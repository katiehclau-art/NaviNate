/* NaviNate — Embeddable Agentic Widget
 * ------------------------------------
 * Drop-in <script> that a client pastes onto their site:
 *   <script src="https://<your-ngrok>/widget.js?clientId=CLIENT_ID"></script>
 *
 * What it does:
 *   1. Injects a floating chat window (themed from the Base44 dashboard config).
 *   2. On each message, scans the live DOM for interactive elements and tags them.
 *   3. Sends the user's message + that element snapshot to the backend.
 *   4. Receives actions and performs them — animating a fake cursor across the
 *      screen and actually clicking / typing / scrolling / navigating.
 *
 * The fake-cursor takeover is the "wow": the visitor watches the bot drive.
 */
(function () {
  "use strict";
  if (window.__naviNateLoaded) return;
  window.__naviNateLoaded = true;

  // ---- resolve backend + clientId from our own <script> tag ----------------
  const self =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"]');
  const srcUrl = new URL(self.src);

  // Where the agent brain lives. By default it's wherever this script came from,
  // which is right when the backend serves widget.js itself. But the widget can
  // also be hosted somewhere else entirely — Base44, a CDN, the client's own
  // assets — while the brain stays on a laptop behind a tunnel. In that case
  // point it explicitly:
  //   <script src="https://cdn.example.com/widget.js"
  //           data-client-id="acme"
  //           data-api="https://agent.example.com"></script>
  // `?api=` on the src works too, for hosts that won't let you add attributes.
  const apiOverride =
    self.getAttribute("data-api") ||
    self.getAttribute("data-backend") ||
    srcUrl.searchParams.get("api") ||
    "";
  const BACKEND = apiOverride ? apiOverride.replace(/\/$/, "") : srcUrl.origin;

  const CLIENT_ID =
    srcUrl.searchParams.get("clientId") ||
    self.getAttribute("data-client-id") ||
    "demo";

  // The voice module is a sibling FILE, not an API call — it lives next to this
  // script, wherever that is. Resolving it against our own src (rather than the
  // backend) keeps split hosting working, and `data-voice-src` covers hosts that
  // rename or relocate assets.
  const VOICE_SRC =
    self.getAttribute("data-voice-src") ||
    new URL("widget-voice.js", srcUrl).href;

  // ---- session state (survives page navigations the agent triggers) --------
  const SS = window.sessionStorage;
  // The conversation (history + panel open state) persists across page loads for
  // the whole tab session, so the assistant never "resets" when the page changes —
  // whether the agent navigated, the user clicked a link, or a button redirected.
  // When the navigation wasn't an agent continuation (no navinate.continue flag),
  // we only drop the MID-TASK flags: any in-flight goal ends, but the chat stays.
  const isContinuation = SS.getItem("navinate.continue") === "1";
  if (!isContinuation) {
    ["autoSteps", "recentSigs", "continue", "navNotice", "acting"].forEach((k) =>
      SS.removeItem("navinate." + k)
    );
  }
  const state = {
    history: JSON.parse(SS.getItem("navinate.history") || "[]"),
    open: SS.getItem("navinate.open") === "1",
    autoSteps: parseInt(SS.getItem("navinate.autoSteps") || "0", 10),
    recentSigs: JSON.parse(SS.getItem("navinate.recentSigs") || "[]"), // recent action signatures (loop guard)
    repeatStrikes: 0, // in-memory: consecutive repeated-action nudges before we give up
    pendingContinue: isContinuation,
    // The reason for the navigation that brought us here, stashed right before the
    // page unloaded so the new page can show "what I'm doing" under the cursor.
    navNotice: SS.getItem("navinate.navNotice") || "",
    // True while the agent is actively driving the page. We minimize the window
    // during this so the user can watch the cursor, then pop it back open to answer.
    acting: SS.getItem("navinate.acting") === "1",
    undoDraft: JSON.parse(SS.getItem("navinate.undoDraft") || "null"),
    lastUndo: JSON.parse(SS.getItem("navinate.lastUndo") || "null"),
    activeGoal: SS.getItem("navinate.activeGoal") || "",
    // How the current goal was given: "voice" or "text". Persisted because a goal
    // that spans a navigation finishes on the next page, which still needs to know
    // whether the visitor is listening or reading.
    goalVia: SS.getItem("navinate.goalVia") || "",
  };
  let MAX_AUTO_STEPS = 8; // safety cap on agent-driven steps per goal (overridable via config)
  const RECENT_SIGS_MAX = 5; // how many past actions the loop guard remembers
  const MAX_REPEAT_STRIKES = 3; // how many "you already did that" nudges before giving up
  function persist() {
    SS.setItem("navinate.history", JSON.stringify(state.history.slice(-20)));
    SS.setItem("navinate.open", state.open ? "1" : "0");
    SS.setItem("navinate.autoSteps", String(state.autoSteps));
    SS.setItem("navinate.recentSigs", JSON.stringify(state.recentSigs));
    state.undoDraft
      ? SS.setItem("navinate.undoDraft", JSON.stringify(state.undoDraft))
      : SS.removeItem("navinate.undoDraft");
    state.lastUndo
      ? SS.setItem("navinate.lastUndo", JSON.stringify(state.lastUndo))
      : SS.removeItem("navinate.lastUndo");
    state.activeGoal
      ? SS.setItem("navinate.activeGoal", state.activeGoal)
      : SS.removeItem("navinate.activeGoal");
    state.goalVia
      ? SS.setItem("navinate.goalVia", state.goalVia)
      : SS.removeItem("navinate.goalVia");
  }

  // Client-configurable theme/behavior (fetched from the backend /config, which
  // proxies Base44). Defaults here keep the widget working if that fetch fails.
  let theme = {
    primaryColor: "#4f46e5",
    botName: "NaviNate Assistant",
    welcomeMessage: "Hi! I can explore this site and click through it for you. What are you trying to do?",
    suggestedPrompts: [],
    widgetPosition: "bottom-right",
    maxAutoSteps: 8,
    enabled: true,
    // Flipped on by /config only when the backend actually holds an ElevenLabs
    // key, so we never show a mic button that can't work.
    voiceEnabled: false,
  };

  // ---- analytics identity + reporter --------------------------------------
  // visitorId: durable across sessions (localStorage) → unique-user counts.
  // sessionId: per tab session (sessionStorage) → engagement/adoption rate.
  const LS = window.localStorage;
  function uid() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }
  let visitorId, sessionId;
  try {
    visitorId = LS.getItem("navinate.vid") || uid();
    LS.setItem("navinate.vid", visitorId);
  } catch { visitorId = uid(); }
  sessionId = SS.getItem("navinate.sid") || uid();
  SS.setItem("navinate.sid", sessionId);

  // Fire-and-forget engagement event to the backend (which forwards to Base44).
  // keepalive lets events sent right before a navigation still go out.
  function track(event, extra) {
    try {
      fetch(BACKEND + "/analytics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: CLIENT_ID, event, visitorId, sessionId, url: location.href, ...extra }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* never let analytics break the widget */ }
  }

  // ---- tiny DOM helpers ----------------------------------------------------
  const el = (tag, props = {}, styles = {}) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    Object.assign(n.style, styles);
    return n;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The launcher/header icon is always the NaviNate brand mark (served alongside
  // the demo site, so it works from the same origin the widget was loaded from).
  // No emoji override — the brand icon is the identity.
  function iconMarkup(cls) {
    return `<img class="nn-icon-img ${cls}" src="${BACKEND}/assets/navinate-icon.png" alt="${escapeHtml(theme.botName)}" />`;
  }

  // ---- build the UI --------------------------------------------------------
  let root, panel, log, input, sendBtn, launcher, cursor, cursorCaption, statusEl, suggestionsEl, undoBtn, micBtn;
  let voiceStage, captionEl, orbEl, vStateEl, vMicBtn;
  let voice = null; // the ElevenLabs voice controller, lazy-loaded on first use

  function buildUI() {
    root = el("div", { id: "navinate-root" });
    const shadowHost = root; // keep it simple; scope styles by prefix instead
    document.body.appendChild(root);

    const style = el("style");
    style.textContent = css();
    root.appendChild(style);

    // Position (bottom-right default; bottom-left if the client configured it).
    if (theme.widgetPosition === "bottom-left") root.classList.add("nn-left");

    // Launcher bubble
    launcher = el("button", {
      className: "nn-launcher",
      title: "Ask " + theme.botName,
      innerHTML: iconMarkup("nn-launcher-icon"),
    });
    launcher.onclick = toggle;
    root.appendChild(launcher);
    setLauncherBusy(state.acting); // reflect an in-progress goal resumed after a page reload

    // Chat panel
    panel = el("div", { className: "nn-panel" });
    panel.innerHTML = `
      <div class="nn-header">
        <span class="nn-title">${iconMarkup("nn-header-icon")} ${escapeHtml(theme.botName)}</span>
        <div class="nn-header-actions">
          <button class="nn-reset" title="Reset chat" aria-label="Reset chat">↺</button>
          <button class="nn-min" title="Minimize" aria-label="Minimize">–</button>
        </div>
      </div>
      <div class="nn-log"></div>
      <div class="nn-status"></div>
      <div class="nn-undo-row"><button class="nn-undo" type="button">↶ Undo last command</button></div>
      <div class="nn-suggestions"></div>
      <div class="nn-inputbar">
        <button class="nn-mic" title="Talk to me" aria-label="Start a voice conversation">🎙</button>
        <input class="nn-input" type="text" placeholder="Ask me to find or do something…" />
        <button class="nn-send">➤</button>
      </div>`;
    root.appendChild(panel);

    log = panel.querySelector(".nn-log");
    input = panel.querySelector(".nn-input");
    sendBtn = panel.querySelector(".nn-send");
    statusEl = panel.querySelector(".nn-status");
    undoBtn = panel.querySelector(".nn-undo");
    suggestionsEl = panel.querySelector(".nn-suggestions");
    micBtn = panel.querySelector(".nn-mic");
    micBtn.onclick = toggleVoice;
    if (!theme.voiceEnabled) micBtn.style.display = "none";

    panel.querySelector(".nn-min").onclick = closePanel;
    undoBtn.onclick = undoLastCommand;
    panel.querySelector(".nn-reset").onclick = resetChat;

    sendBtn.onclick = () => submit();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    // Voice stage. It lives on the ROOT, not inside the panel: during a call it
    // floats over the site at the bottom of the screen with no chrome around it,
    // so the visitor can still see (and the agent can still drive) the page they
    // came for. The panel steps aside entirely while it's up.
    voiceStage = el("div", { className: "nn-voice" });
    voiceStage.innerHTML = `
      <div class="nn-vcaption"></div>
      <div class="nn-orb">
        <span class="nn-orb-halo"></span>
        <span class="nn-orb-ring"></span>
        <span class="nn-orb-core"></span>
      </div>
      <div class="nn-vstate"></div>
      <div class="nn-vcontrols">
        <button class="nn-vkeyboard" title="Switch to typing" aria-label="Switch to typing">⌨</button>
        <button class="nn-vmic" title="Mute microphone" aria-label="Mute microphone">🎙</button>
        <button class="nn-vend" title="End voice chat" aria-label="End voice chat">✕</button>
      </div>`;
    root.appendChild(voiceStage);

    captionEl = voiceStage.querySelector(".nn-vcaption");
    orbEl = voiceStage.querySelector(".nn-orb");
    vStateEl = voiceStage.querySelector(".nn-vstate");
    vMicBtn = voiceStage.querySelector(".nn-vmic");
    vMicBtn.onclick = toggleMute;
    voiceStage.querySelector(".nn-vend").onclick = () => voice && voice.stop();
    // Hand back to the keyboard without hanging up — the call keeps running and
    // the mic button in the input bar brings the stage back.
    voiceStage.querySelector(".nn-vkeyboard").onclick = () => setVoiceUI(false);

    // Fake cursor
    cursor = el("div", { className: "nn-cursor" });
    cursor.innerHTML =
      `<img class="nn-cursor-pose nn-cursor-pose-hover" src="${BACKEND}/assets/cursor-hover.png" alt="" />` +
      `<img class="nn-cursor-pose nn-cursor-pose-click" src="${BACKEND}/assets/cursor-click.png" alt="" />` +
      '<div class="nn-cursor-caption"></div>';
    cursorCaption = cursor.querySelector(".nn-cursor-caption");
    root.appendChild(cursor);

    // Apply theme accent
    root.style.setProperty("--nn-accent", theme.primaryColor);

    // Show the conversation. The greeting reflects the CURRENT welcome message
    // (which the client can change in Base44), so we NEVER persist it into history —
    // otherwise the first-ever greeting would get stuck in sessionStorage and later
    // changes to welcome_message would never show. We render it fresh, from the live
    // theme, whenever the conversation hasn't actually started yet.
    const conversationStarted = state.history.some((m) => m.role === "user");
    if (!conversationStarted && state.history.length) {
      state.history = []; // drop any stale stored greeting from an earlier load/version
      persist();
    }
    // Replay the conversation exactly as it looked live.
    //
    // `content` is what the MODEL sees and is often not fit for display: action
    // notes ("Navigated to https://…") and system nudges ("(System: you already
    // did that)") are memory, not conversation. So an entry may carry `label` —
    // the text the visitor actually saw — and `kind` — how it was drawn. An entry
    // whose `label` is present but empty was never on screen at all, and must
    // stay off screen after a reload too.
    for (const m of state.history) {
      const text = "label" in m ? m.label : m.content;
      if (!text) continue;
      const bubble = addBubble(m.kind || m.role, text, false);
      if (m.kind !== "task") continue;
      if (m.state === "done") bubble.classList.add("nn-task-done");
      else if (m.state === "stuck") bubble.classList.add("nn-task-stuck");
      else {
        // Still in flight — the agent navigated mid-goal and is about to resume
        // on this page. Re-adopt it so it gets settled when the goal finishes.
        bubble.classList.add("nn-task-live");
        taskChip = bubble;
        taskEntry = m;
      }
    }
    if (!conversationStarted && theme.welcomeMessage) {
      addBubble("assistant", theme.welcomeMessage); // ephemeral — not pushed to history
    }
    if (state.open) openPanel();
    renderSuggestions();
    renderUndo();
  }

  // Client-configured starter chips. Shown until the visitor sends their first
  // message (then hidden to save space). Clicking one sends it as a goal.
  function renderSuggestions() {
    if (!suggestionsEl) return;
    const prompts = Array.isArray(theme.suggestedPrompts) ? theme.suggestedPrompts : [];
    const alreadyChatting = state.history.some((m) => m.role === "user");
    suggestionsEl.innerHTML = "";
    if (!prompts.length || alreadyChatting) {
      suggestionsEl.style.display = "none";
      return;
    }
    suggestionsEl.style.display = "flex";
    for (const p of prompts.slice(0, 6)) {
      const chip = el("button", { className: "nn-chip", textContent: p });
      chip.onclick = () => {
        input.value = p;
        submit();
      };
      suggestionsEl.appendChild(chip);
    }
  }

  function toggle() {
    state.open ? closePanel() : openPanel();
  }
  function openPanel() {
    state.open = true;
    panel.classList.add("nn-open");
    launcher.classList.add("nn-hidden");
    persist();
    input && input.focus();
    log.scrollTop = log.scrollHeight;
    // Count each session's first open — the numerator for "% of visitors who
    // actually engage the assistant".
    if (SS.getItem("navinate.opened") !== "1") {
      SS.setItem("navinate.opened", "1");
      track("widget_opened");
    }
  }
  function closePanel() {
    state.open = false;
    panel.classList.remove("nn-open");
    launcher.classList.remove("nn-hidden");
    persist();
  }

  // Wipe the conversation and start over: clears history + all in-flight/loop-guard
  // state, re-renders the log with a fresh welcome message, and re-shows the starter
  // chips. Doesn't touch visitorId/sessionId — this is a chat reset, not a new session.
  function resetChat() {
    if (busy) return; // don't yank the log out from under an in-flight turn
    state.history = [];
    state.autoSteps = 0;
    state.recentSigs = [];
    state.repeatStrikes = 0;
    // The undo button rewinds an action from the conversation we're about to wipe —
    // once the chat is reset there's nothing left to undo it back into.
    state.undoDraft = null;
    state.lastUndo = null;
    state.activeGoal = "";
    state.goalVia = "";
    taskChip = taskEntry = null; // the task line is about to be wiped with the log
    pendingVoiceFeedback = false;
    exitActingMode();
    disarmContinuation();
    ["autoSteps", "recentSigs", "continue", "navNotice", "acting", "history"].forEach((k) =>
      SS.removeItem("navinate." + k)
    );
    persist();
    log.innerHTML = "";
    setStatus("");
    if (theme.welcomeMessage) addBubble("assistant", theme.welcomeMessage);
    renderSuggestions();
    renderUndo();
    track("chat_reset");
  }

  // ---- "acting" mode: get out of the way while the agent drives the page ----
  // While the agent is clicking/typing/navigating we minimize the window (to the
  // launcher) so the user can watch the fake cursor, then pop it back open to
  // deliver the answer. `acting` is persisted so it holds across the page reloads
  // the agent triggers when it navigates.
  function enterActingMode() {
    if (state.acting) return;
    state.acting = true;
    SS.setItem("navinate.acting", "1");
    setLauncherBusy(true); // pulse the launcher — the only cue left once the panel is minimized
    if (state.open) closePanel(); // minimize; the cursor + caption keep the user informed
  }
  function exitActingMode() {
    if (!state.acting) return;
    state.acting = false;
    SS.removeItem("navinate.acting");
    setLauncherBusy(false);
    openPanel(); // pop back out to show the reply
  }

  // Pulses the launcher logo (grow/shrink) so the user has SOME signal the agent
  // is still working even if they've scrolled away from the fake cursor, it's
  // off-screen, or they just glance at the corner where the chat lives.
  function setLauncherBusy(v) {
    if (launcher) launcher.classList.toggle("nn-launcher-busy", v);
  }

  // ---- chat rendering ------------------------------------------------------
  function addBubble(role, text, animate = true) {
    const b = el("div", { className: "nn-msg nn-" + role });
    // The model's replies may contain markdown; render it. User text stays plain
    // (rendered via textContent) so nothing a visitor types can inject markup.
    if (role === "assistant") b.innerHTML = renderMarkdown(text);
    else b.textContent = text;
    if (!animate) b.style.animation = "none";
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  // Tiny, dependency-free markdown → HTML for assistant messages. Everything from
  // the model is HTML-escaped FIRST, so this can't be used to inject markup; we
  // then layer on a safe subset (headings, bold/italic, code, lists, quotes, links).
  function renderMarkdown(src) {
    const blocks = []; // fenced code blocks, pulled out so they're not marked up
    const spans = []; // inline `code` spans

    let text = String(src == null ? "" : src);
    text = text.replace(/```([\s\S]*?)```/g, (_, body) => {
      const code = body.replace(/^[\w-]*\n/, "").replace(/\n$/, "");
      blocks.push(code);
      return `\nB${blocks.length - 1}B\n`; // own line -> handled as a block, not a <p>
    });
    text = text.replace(/`([^`\n]+)`/g, (_, body) => {
      spans.push(body);
      return `C${spans.length - 1}C`;
    });
    text = escapeHtml(text); // placeholders survive (no HTML-special chars)

    const inline = (s) =>
      s
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|#[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
        )
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");

    const lines = text.split(/\r?\n/);
    let html = "";
    let list = null; // 'ul' | 'ol'
    let para = [];
    const flushPara = () => {
      if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; }
    };
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = line.trim().match(/^B(\d+)B$/))) { // a fenced code block on its own line
        flushPara(); closeList();
        html += `<pre><code>${escapeHtml(blocks[+m[1]])}</code></pre>`;
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushPara(); closeList();
        html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
        flushPara();
        if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        flushPara(); closeList();
        html += `<blockquote>${inline(m[1])}</blockquote>`;
      } else {
        para.push(line);
      }
    }
    flushPara(); closeList();

    // Restore any leftover code placeholders (inline spans + stray blocks).
    html = html.replace(/B(\d+)B/g, (_, i) => `<pre><code>${escapeHtml(blocks[+i])}</code></pre>`);
    html = html.replace(/C(\d+)C/g, (_, i) => `<code>${escapeHtml(spans[+i])}</code>`);
    return html || "";
  }
  // Is this the same thing the assistant just said? Used to keep the spoken and
  // typed channels from double-rendering the same line.
  function isDuplicateOfLastBubble(text) {
    const bubbles = log.querySelectorAll(".nn-assistant");
    const last = bubbles[bubbles.length - 1];
    if (!last) return false;
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    return norm(last.textContent) === norm(text);
  }

  function setStatus(text) {
    statusEl.textContent = text || "";
    statusEl.style.display = text ? "block" : "none";
    // The status strip is hidden behind the voice stage, so mirror the agent's
    // live "what I'm clicking" line onto the stage instead of losing it.
    if (voiceUIOn && vStateEl && text) vStateEl.textContent = text;
  }

  // ---- DOM scanning --------------------------------------------------------
  // Tag every interactive element with a stable data-agent-id and return a
  // compact JSON snapshot for the backend to reason over.
  const SELECTOR =
    'a[href], area[href], [href], button, input:not([type=hidden]), select, textarea, ' +
    '[role=button], [role=link], [role=tab], [role=menuitem], [role=slider], ' +
    '[role=radio], [role=checkbox], [role=switch], [onclick]';

  // Sliders come in two flavors: native <input type=range> (has real min/max/step/
  // value) and custom ARIA role="slider" widgets (only the aria-value* attributes).
  // These helpers read whichever applies so scanDom + performAction share one source.
  const isRangeInput = (node) => node.tagName === "INPUT" && node.type === "range";
  const isAriaSlider = (node) => node.getAttribute("role") === "slider";
  const isSlider = (node) => isRangeInput(node) || isAriaSlider(node);

  // Checkable controls — native radio/checkbox inputs plus their ARIA
  // equivalents. Radios and checkboxes are actuated with a plain "click"; the
  // point of surfacing them specially is so the model can SEE which option is
  // currently selected (via `checked`) and not re-click one that's already on.
  const isRadio = (node) =>
    (node.tagName === "INPUT" && node.type === "radio") || node.getAttribute("role") === "radio";
  const isCheckbox = (node) =>
    (node.tagName === "INPUT" && node.type === "checkbox") ||
    node.getAttribute("role") === "checkbox" ||
    node.getAttribute("role") === "switch";
  const isCheckable = (node) => isRadio(node) || isCheckbox(node);
  function isChecked(node) {
    if (node.tagName === "INPUT") return !!node.checked;
    return node.getAttribute("aria-checked") === "true";
  }
  function sliderMin(node) {
    if (isRangeInput(node)) return node.min || "0"; // browser defaults when unset
    if (isAriaSlider(node)) return node.getAttribute("aria-valuemin") || undefined;
    return undefined;
  }
  function sliderMax(node) {
    if (isRangeInput(node)) return node.max || "100";
    if (isAriaSlider(node)) return node.getAttribute("aria-valuemax") || undefined;
    return undefined;
  }
  function sliderStep(node) {
    if (isRangeInput(node)) return node.step || "1";
    return undefined; // ARIA defines no standard step attribute
  }
  function sliderValue(node) {
    if (isRangeInput(node)) return node.value;
    if (isAriaSlider(node)) return node.getAttribute("aria-valuenow") || undefined;
    return undefined;
  }

  // Monotonic counter so each DOM element keeps a STABLE data-agent-id across
  // re-scans. This lets the loop guard recognise "same element clicked again"
  // (a loop) versus "a different element" (progress) — text labels can't, since
  // e.g. every product's "Add to Cart" button shares the same text.
  let agentIdCounter = 0;

  function scanDom() {
    const nodes = document.querySelectorAll(SELECTOR);
    const elements = [];
    for (const node of nodes) {
      if (node.closest("#navinate-root")) continue; // never target our own UI
      const rect = node.getBoundingClientRect();
      const styleV = window.getComputedStyle(node);
      const renderable =
        styleV.display !== "none" &&
        styleV.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0;
      if (!renderable) continue;

      let agentId = node.getAttribute("data-agent-id");
      if (!agentId) {
        agentId = String(++agentIdCounter);
        node.setAttribute("data-agent-id", agentId);
      }

      const inViewport =
        rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0;

      const own = elementText(node).slice(0, 120);
      const ctx = contextText(node, own); // surrounding card/row text — often carries the price
      elements.push({
        id: agentId,
        tag: node.tagName.toLowerCase(),
        // Custom ARIA widgets aren't <input>, so surface their role as the type —
        // it's the model's only cue that a non-native element is a slider,
        // radio, or checkbox it can act on.
        type:
          node.getAttribute("type") ||
          (isAriaSlider(node) ? "slider" : isCheckable(node) ? node.getAttribute("role") : undefined),
        text: own,
        value: isSlider(node) ? sliderValue(node) : node.value || undefined,
        min: isSlider(node) ? sliderMin(node) : undefined,
        max: isSlider(node) ? sliderMax(node) : undefined,
        step: isSlider(node) ? sliderStep(node) : undefined,
        // radio/checkbox: whether this option is currently selected. Lets the
        // model pick the right one and skip any that's already chosen.
        checked: isCheckable(node) ? isChecked(node) : undefined,
        options:
          node.tagName === "SELECT"
            ? Array.from(node.options).map((option) => ({
                label: option.text.trim(),
                value: option.value,
                disabled: option.disabled || undefined,
              }))
            : undefined,
        context: ctx || undefined,
        href: node.getAttribute("href") || undefined,
        active: isActive(node) || undefined, // a filter/tab/toggle that's already applied
        visible: inViewport,
      });
      if (elements.length >= 180) break; // keep the payload sane
    }
    return elements;
  }

  // Is this control already selected/applied? Lets the model avoid re-clicking a
  // filter or tab that's already on (a common cause of "it just repeated itself").
  function isActive(node) {
    const cur = node.getAttribute("aria-current");
    return (
      node.getAttribute("aria-pressed") === "true" ||
      node.getAttribute("aria-selected") === "true" ||
      // a chosen radio is a mutually-exclusive selection that's already applied —
      // re-clicking it is a no-op, so flag it like any other active filter.
      // (Checkboxes are independent toggles, so a checked one is NOT "active":
      //  the model may legitimately want to uncheck it. Its state rides in `checked`.)
      (isRadio(node) && isChecked(node)) ||
      (cur && cur !== "false") ||
      node.classList.contains("active") ||
      node.classList.contains("selected") ||
      node.classList.contains("current") ||
      node.classList.contains("is-active")
    );
  }

  // The visible text of the enclosing card/row/list-item — so the model can read
  // the price/name attached to a button whose own label is just "Add to Cart".
  function contextText(node, own) {
    const container =
      node.closest('.card, li, article, tr, [class*="card"], [class*="item"], [class*="product"]') ||
      node.parentElement;
    if (!container || container.closest("#navinate-root")) return "";
    const t = (container.innerText || "").replace(/\s+/g, " ").trim();
    return t && t !== own ? t.slice(0, 220) : "";
  }

  // The page's visible text (excluding our own widget) so the model can READ
  // content — prices, names, headings — not just the clickable elements.
  function getPageText() {
    let out = "";
    for (const child of document.body.children) {
      if (child.id === "navinate-root") continue;
      out += (child.innerText || "") + "\n";
    }
    return out.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, 2500);
  }

  function elementText(node) {
    return (
      node.getAttribute("aria-label") ||
      (node.innerText && node.innerText.trim()) ||
      // A bare <input type=radio/checkbox> has no text of its own — its visible
      // label is a associated <label> ("Hybrid", "EU region"). Pull that so the
      // model can tell the options apart instead of seeing the raw value/name.
      labelText(node) ||
      node.getAttribute("placeholder") ||
      node.value ||
      node.getAttribute("title") ||
      node.getAttribute("name") ||
      ""
    ).replace(/\s+/g, " ").trim();
  }

  // The text of a form control's associated <label>(s): covers both
  // `<label for=id>` and a wrapping `<label>…<input></label>`, plus
  // aria-labelledby. Empty for elements that aren't labelable.
  function labelText(node) {
    try {
      if (node.labels && node.labels.length) {
        return Array.from(node.labels)
          .map((l) => (l.innerText || l.textContent || "").trim())
          .filter(Boolean)
          .join(" ");
      }
    } catch (_) { /* .labels not present on this element type */ }
    const ref = node.getAttribute && node.getAttribute("aria-labelledby");
    if (ref) {
      const t = ref
        .split(/\s+/)
        .map((id) => (document.getElementById(id)?.innerText || "").trim())
        .filter(Boolean)
        .join(" ");
      if (t) return t;
    }
    return "";
  }

  function findByAgentId(id) {
    return document.querySelector(`[data-agent-id="${CSS.escape(String(id))}"]`);
  }

  // ---- the agent loop ------------------------------------------------------
  let busy = false;

  async function submit() {
    const text = (input.value || "").trim();
    if (!text || busy) return;
    input.value = "";
    return runGoal(text);
  }

  // Start a fresh goal and drive it to completion. `submit()` is the typed entry
  // point; the voice agent's navigate_site tool is the spoken one — both land
  // here so there's exactly one definition of "what NaviNate does with a goal".
  // Resolves with { navigated, summary, stuck, steps } so the caller (and the
  // voice agent, which has no eyes) can report what actually happened.
  async function runGoal(text, opts = {}) {
    if (!text || busy) return { navigated: false, summary: "I'm already working on something — one moment.", stuck: true };
    // A spoken goal was already logged as the visitor's own transcript line, so
    // we show what the agent is doing about it as a task line, rather than a
    // second user bubble that looks like they said the same thing twice.
    // `kind`/`label` ride along in history so a page reload redraws this exactly
    // as it appeared live (see the restore loop in buildUI).
    const entry = { role: "user", content: text };
    if (opts.via === "voice") {
      entry.kind = "task";
      entry.label = taskLabel(text);
      taskEntry = entry;
      taskChip = addBubble("task", entry.label);
      taskChip.classList.add("nn-task-live");
    } else {
      addBubble("user", text);
    }
    state.history.push(entry);
    state.autoSteps = 0; // new user goal resets the step budget
    state.recentSigs = []; // ...and the loop guard, so a fresh goal may repeat a prior action
    state.repeatStrikes = 0;
    state.activeGoal = text;
    state.goalVia = opts.via === "voice" ? "voice" : "text";
    state.lastUndo = null;
    state.undoDraft = {
      command: text,
      startUrl: window.location.href,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      entries: [],
      appState: captureAppUndoState(),
    };
    persist();
    renderUndo();
    renderSuggestions(); // hide the starter chips now that they're chatting
    // The message text lets the dashboard surface common questions/issues.
    // Spoken goals are already counted from the visitor's transcript, so don't
    // count the agent's restatement of one a second time.
    if (opts.via !== "voice") track("message_sent", { message: text });
    return runTurn(text);
  }

  // Drives the agent loop: ask the backend → perform the action → re-scan → repeat,
  // until the goal is done, the model stops acting, it repeats itself, or we hit the
  // step cap. Continues across page navigations via sessionStorage (see boot()).
  async function runTurn(userMessage) {
    if (busy) return { navigated: false, summary: "", stuck: true, steps: 0 };
    busy = true;
    const activeGoal = userMessage || state.activeGoal;
    let msg = userMessage || continueGoalMessage(activeGoal);
    let stuck = false; // did the goal end by giving up / hitting the cap? (an "issue")
    // Everything the agent said or did this goal, so a caller with no screen
    // (the voice agent) can be told what happened rather than guessing.
    const notes = [];

    // During a spoken goal the visitor is LISTENING to the voice agent, and these
    // replies are the page-driving agent's internal narration — they get handed
    // over as the tool result and the voice agent says its own version. Rendering
    // them too puts the same answer on screen twice, in two different wordings.
    // They still go into history as model memory, with an empty `label` so a
    // reload doesn't resurrect them either.
    const viaVoice = state.goalVia === "voice";
    const showReply = (text) => {
      if (text && !viaVoice) addBubble("assistant", text);
    };
    const replyEntry = (content, displayed) => ({
      role: "assistant",
      content,
      label: viaVoice ? "" : displayed === undefined ? content : displayed,
    });

    try {
      for (;;) {
        setStatus(state.autoSteps === 0 ? "Thinking…" : "Working…");
        const pageElements = scanDom();
        const pageText = getPageText();
        const res = await fetch(BACKEND + "/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: msg,
            clientId: CLIENT_ID,
            pageElements,
            pageText,
            history: state.history.slice(-12),
          }),
        });
        const data = await res.json();
        if (data.reply) {
          showReply(data.reply);
          notes.push(data.reply);
        }

        // ONE deliberate step per turn: perform only the FIRST requested action,
        // then re-scan and let the model decide again. This is the real fix for
        // the "did it 4 times" bug — even if a response somehow carries several
        // tool calls, we never fire more than one per turn.
        const action = (data.actions || [])[0];

        if (!action) {
          if (data.reply) state.history.push(replyEntry(data.reply));
          persist();
          break; // model answered in text / finished — nothing to do
        }

        // Loop guard (preventive): signature keyed on the STABLE element id.
        // If we've already done this exact action, DON'T repeat it — instead nudge
        // the model to take the next step. Only give up after a few nudges.
        const sig = [action.action, action.target_id || "", action.value || "", action.url || ""].join("|");
        if (state.recentSigs.includes(sig)) {
          state.repeatStrikes++;
          if (data.reply) state.history.push(replyEntry(data.reply));
          state.history.push({
            role: "user",
            label: "", // a nudge to the model; the visitor never saw it
            content:
              "(System: you already performed that exact step, so I did not repeat it — it's done. " +
              "Check the current pageText and pageElements (note any element with active:true is already selected) " +
              "and take the NEXT step toward the goal. If the goal is already achieved, or cannot be done on this " +
              "site, tell me that in plain text and do not call the tool.)",
          });
          persist();
          if (state.repeatStrikes >= MAX_REPEAT_STRIKES) {
            const note = "I seem to be stuck — could you rephrase or point me in the right direction?";
            showReply(note);
            notes.push(note);
            stuck = true;
            break;
          }
          state.autoSteps++;
          persist();
          if (state.autoSteps >= MAX_AUTO_STEPS) {
            const note = "I've taken several steps — let me know if you'd like me to keep going.";
            showReply(note);
            notes.push(note);
            stuck = true;
            break;
          }
          msg = continueGoalMessage(activeGoal);
          await sleep(300);
          continue;
        }
        state.repeatStrikes = 0; // made real progress — reset the strike counter

        enterActingMode(); // minimize the window so the user can watch the page
        showCursorCaption(action.reason);
        const undoEntry = captureUndoEntry(action);
        // Let the voice session stash the conversation before a click that might
        // unload the page — after realClick() it may already be too late.
        if (action.action === "navigate" && voice) voice.armHandoff();
        const r = await performAction(action);
        hideCursorCaption();
        if (r.executed) {
          notes.push(describeAction(action, r.label));
          if (undoEntry && state.undoDraft) state.undoDraft.entries.push(undoEntry);
          state.recentSigs.push(sig);
          if (state.recentSigs.length > RECENT_SIGS_MAX) state.recentSigs.shift();
          // Record what we did so the next turn's model remembers and won't redo
          // it. Only the reply was ever spoken to the visitor — the action note
          // is memory, so `label` keeps it out of the replayed log.
          state.history.push(
            replyEntry(
              [data.reply, describeAction(action, r.label)].filter(Boolean).join("\n"),
              data.reply || ""
            )
          );
        } else if (r.failure) {
          // The action was refused (e.g. a URL that doesn't exist). Tell the
          // model exactly why, as a system turn, so it picks a real route instead
          // of retrying the same dead end.
          state.history.push({
            role: "user",
            label: "", // system feedback to the model, not a visitor turn
            content: `(System: I did NOT perform that action. ${r.failure})`,
          });
          notes.push(r.failure);
          // Remember it as attempted so the loop guard blocks an exact retry,
          // even though nothing actually happened on the page.
          state.recentSigs.push(sig);
          if (state.recentSigs.length > RECENT_SIGS_MAX) state.recentSigs.shift();
        } else if (data.reply) {
          state.history.push(replyEntry(data.reply));
        }
        persist();

        // Page is reloading; boot() resumes the loop on the other side.
        if (r.navigated) return { navigated: true, summary: notes.join(" "), stuck: false, steps: state.autoSteps };
        if (data.done) break; // model doesn't intend to act further

        state.autoSteps++;
        persist();
        if (state.autoSteps >= MAX_AUTO_STEPS) {
          const note = "I've taken several steps — let me know if you'd like me to keep going.";
          showReply(note);
          notes.push(note);
          stuck = true;
          break;
        }

        msg = continueGoalMessage(activeGoal);
        await sleep(450);
      }
      // Loop finished with a text answer (not a navigation) — pop back open to show it.
      const didAct = state.acting;
      exitActingMode();
      setStatus("");
      // Report the outcome so the dashboard can chart resolution vs. common issues.
      if (stuck) track("goal_stuck", { steps: state.autoSteps });
      else track("goal_completed", { steps: state.autoSteps });
      state.activeGoal = "";
      finishUndoCommand();
      // Rate the answer (CSAT). On a spoken goal the answer the visitor actually
      // gets is the voice agent's, which arrives a moment later — attaching now
      // would pin the thumbs to a mid-action line, so hand it to the transcript.
      if (viaVoice) pendingVoiceFeedback = true;
      else attachFeedback();
      // Whatever just happened on screen, tell the voice agent about it — it's
      // holding a conversation about a page it can't see.
      if (voice && voice.isActive()) voice.sendContext(describePageForVoice(), "page");
      finishTaskChip(stuck);
      return { navigated: false, summary: notes.join(" "), stuck, steps: state.autoSteps };
    } catch (err) {
      console.error("[NaviNate]", err);
      hideCursorCaption(0);
      exitActingMode();
      const note = "Hmm, I couldn't reach my brain just now. Mind trying again?";
      showReply(note);
      setStatus("");
      state.activeGoal = "";
      finishUndoCommand();
      finishTaskChip(true);
      return { navigated: false, summary: note, stuck: true, steps: state.autoSteps };
    } finally {
      busy = false;
      renderUndo();
    }
  }

  // ---- the task line shown for a spoken goal -------------------------------
  // A spoken goal arrives as an imperative ("open FAQ entry #1"). Shown verbatim
  // it reads like a command the visitor is still waiting on, so we conjugate the
  // leading verb: "Opening FAQ entry #1" while it works, "Opened FAQ entry #1"
  // once it's done. Every occurrence of that verb is converted, so compound
  // goals ("open #1 and open #2") don't end up half-tensed.
  let taskChip = null; // the live <div> for the goal in flight
  let taskEntry = null; // its history record, so a reload redraws it identically
  let pendingVoiceFeedback = false; // 👍👎 owed to the next spoken reply

  const TASK_VERBS = {
    open: ["Opening", "Opened"], click: ["Clicking", "Clicked"], add: ["Adding", "Added"],
    select: ["Selecting", "Selected"], choose: ["Choosing", "Chose"], pick: ["Picking", "Picked"],
    go: ["Going", "Went"], navigate: ["Navigating", "Navigated"], show: ["Showing", "Showed"],
    find: ["Finding", "Found"], set: ["Setting", "Set"], filter: ["Filtering", "Filtered"],
    remove: ["Removing", "Removed"], apply: ["Applying", "Applied"], search: ["Searching", "Searched"],
    scroll: ["Scrolling", "Scrolled"], type: ["Typing", "Typed"], compare: ["Comparing", "Compared"],
    check: ["Checking", "Checked"], fill: ["Filling", "Filled"], submit: ["Submitting", "Submitted"],
    sort: ["Sorting", "Sorted"], view: ["Viewing", "Viewed"], close: ["Closing", "Closed"],
    expand: ["Expanding", "Expanded"], read: ["Reading", "Read"], get: ["Getting", "Got"],
  };

  function taskLabel(goal, done) {
    const text = String(goal || "").trim().replace(/[.!\s]+$/, "");
    if (!text) return "";
    const verb = (/^\s*(?:please\s+|can you\s+|could you\s+)?([a-z]+)\b/i.exec(text) || [])[1];
    const forms = verb && TASK_VERBS[verb.toLowerCase()];
    let out = text;
    if (forms) {
      out = text.replace(new RegExp("\\b" + verb + "\\b", "gi"), done ? forms[1] : forms[0]);
    }
    return out.charAt(0).toUpperCase() + out.slice(1);
  }

  // Settle the task line once the goal is over: past tense, and a ✓ (or a ⚠ when
  // the agent gave up) instead of the working dot.
  function finishTaskChip(stuck) {
    if (!taskChip || !taskEntry) return;
    taskEntry.label = taskLabel(taskEntry.content, true);
    taskEntry.state = stuck ? "stuck" : "done";
    taskChip.textContent = taskEntry.label;
    taskChip.classList.remove("nn-task-live");
    taskChip.classList.add(stuck ? "nn-task-stuck" : "nn-task-done");
    taskChip = taskEntry = null;
    persist();
  }

  function continueGoalMessage(goal) {
    return goal
      ? `(Continue only the current user goal: "${goal}". Do not resume or infer tasks from earlier user commands.)`
      : "(Check whether the current goal is complete. Do not resume older user commands.)";
  }

  function renderUndo() {
    if (!undoBtn) return;
    undoBtn.parentElement.style.display = state.lastUndo ? "flex" : "none";
    undoBtn.disabled = busy;
  }

  // The radio currently selected in the same group as `node` (same name, same
  // form), or null. Native radios only — that's what needs group-aware undo.
  function checkedRadioInGroup(node) {
    if (!(node.tagName === "INPUT" && node.type === "radio")) return null;
    const name = node.name;
    const scope = node.form || document;
    for (const r of scope.querySelectorAll('input[type="radio"]')) {
      if (r.name === name && r.checked) return r;
    }
    return null;
  }

  function captureUndoEntry(action) {
    if (action.action === "scroll") {
      return { kind: "scroll", x: window.scrollX, y: window.scrollY };
    }
    const node = action.target_id ? findByAgentId(action.target_id) : null;
    if (!node) return null;
    const targetId = String(action.target_id);
    if (action.action === "type") {
      return { kind: "value", targetId, value: node.value || "" };
    }
    if (action.action === "select" && node.tagName === "SELECT") {
      return { kind: "select", targetId, value: node.value };
    }
    if (action.action === "click" && isRadio(node)) {
      // Selecting a radio unchecks whichever sibling was on, so undoing it means
      // re-selecting that sibling — merely unchecking the new one would leave the
      // group with nothing chosen. Capture the currently-selected radio (if any).
      const prev = checkedRadioInGroup(node);
      if (prev && prev !== node) {
        if (!prev.dataset.agentId) prev.dataset.agentId = String(++agentIdCounter);
        return { kind: "radio", targetId: prev.dataset.agentId };
      }
      return { kind: "checked", targetId, checked: !!node.checked }; // nothing was selected before
    }
    if (action.action === "click" && /^checkbox$/i.test(node.type || "")) {
      return { kind: "checked", targetId, checked: !!node.checked };
    }
    if (action.action === "click") {
      const group = node.parentElement;
      const previous = group && group.querySelector(
        '.active, [aria-pressed="true"], [aria-selected="true"]'
      );
      if (previous && previous !== node) {
        if (!previous.dataset.agentId) previous.dataset.agentId = String(++agentIdCounter);
        return { kind: "click", targetId: previous.dataset.agentId };
      }
    }
    return null;
  }

  function finishUndoCommand() {
    const draft = state.undoDraft;
    if (!draft) return;
    const changedPage = window.location.href !== draft.startUrl;
    const currentAppState = captureAppUndoState();
    const appChanged =
      draft.appState != null &&
      JSON.stringify(draft.appState) !== JSON.stringify(currentAppState);
    if (draft.entries.length || changedPage || appChanged) state.lastUndo = draft;
    state.undoDraft = null;
    persist();
    renderUndo();
  }

  // Returns a short note describing what was reversed (the voice agent speaks it).
  async function undoLastCommand() {
    if (busy) return "I'm in the middle of something — give me a second.";
    if (!state.lastUndo) return "There's nothing to undo yet.";
    busy = true;
    renderUndo();
    const transaction = state.lastUndo;
    state.lastUndo = null;
    state.undoDraft = null;
    persist();
    try {
      if (window.location.href !== transaction.startUrl) {
        SS.setItem("navinate.undoNotice", `Undid: ${transaction.command}`);
        if (transaction.appState != null) {
          SS.setItem("navinate.undoAppState", JSON.stringify(transaction.appState));
        }
        if (voice) voice.armHandoff();
        window.location.href = transaction.startUrl;
        return `Taking them back to the previous page to undo "${transaction.command}".`;
      }
      restoreAppUndoState(transaction.appState);
      for (const entry of [...transaction.entries].reverse()) {
        const node = entry.targetId ? findByAgentId(entry.targetId) : null;
        if (entry.kind === "scroll") {
          window.scrollTo({ left: entry.x, top: entry.y, behavior: "smooth" });
        } else if (entry.kind === "value" && node) {
          setNativeValue(node, entry.value);
        } else if (entry.kind === "select" && node) {
          setNativeValue(node, entry.value);
        } else if (entry.kind === "checked" && node) {
          node.checked = entry.checked;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (entry.kind === "radio" && node) {
          // Re-select the radio that was on before — a real click re-checks it,
          // unchecks the group, and fires change so frameworks stay in sync.
          realClick(node);
        } else if (entry.kind === "click" && node) {
          realClick(node);
        }
      }
      const shown = `Undid your last command: “${transaction.command}”`;
      addBubble("assistant", shown);
      // Phrased differently for the model than for the visitor, so pin the
      // displayed wording or a reload would quietly reword it.
      state.history.push({
        role: "assistant",
        content: `Undid the previous command: ${transaction.command}`,
        label: shown,
      });
      persist();
      track("command_undone", { message: transaction.command });
      if (voice && voice.isActive()) voice.sendContext(describePageForVoice(), "page");
      return `Undone — reversed "${transaction.command}".`;
    } finally {
      busy = false;
      renderUndo();
    }
  }

  // Host applications can opt into undo for state that is not represented by a
  // form control (cart contents, saved filters, configurator state, etc.). The
  // adapter must return JSON-serializable state and restore that same shape.
  function captureAppUndoState() {
    try {
      const adapter = window.NaviNateUndo;
      return adapter && typeof adapter.capture === "function"
        ? adapter.capture()
        : null;
    } catch (_) {
      return null;
    }
  }

  function restoreAppUndoState(snapshot) {
    try {
      const adapter = window.NaviNateUndo;
      if (snapshot != null && adapter && typeof adapter.restore === "function") {
        adapter.restore(snapshot);
      }
    } catch (err) {
      console.warn("[NaviNate] Host undo adapter failed:", err);
    }
  }

  function setNativeValue(node, value) {
    const proto = node.tagName === "SELECT"
      ? window.HTMLSelectElement.prototype
      : node.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Append 👍/👎 to the last assistant message so visitors can rate the outcome.
  // Fires a "feedback" event (CSAT signal) and can only be answered once.
  function attachFeedback() {
    const bubbles = log.querySelectorAll(".nn-assistant");
    const last = bubbles[bubbles.length - 1];
    if (!last || last.querySelector(".nn-feedback") || last.dataset.nnFeedback) return;
    last.dataset.nnFeedback = "1";
    const answer = last.textContent || "";
    const row = el("div", { className: "nn-feedback" });
    const mk = (icon, value) => {
      const b = el("button", { className: "nn-fb-btn", title: value, innerHTML: icon });
      b.onclick = () => {
        track("feedback", { value, message: answer.slice(0, 300) });
        // The thanks message replaces the row, taking the play/pause button with
        // it — don't leave audio running with nothing to stop it.
        if (narration && row.contains(narration.btn)) stopNarration();
        row.innerHTML = '<span class="nn-fb-thanks">Thanks for the feedback!</span>';
      };
      return b;
    };
    row.appendChild(mk("👍", "up"));
    row.appendChild(mk("👎", "down"));
    // Read-it-to-me. Pointless while a live conversation is running (the agent
    // already said it), so only offer it on the text path.
    if (theme.voiceEnabled && !(voice && voice.isActive())) {
      const speakBtn = el("button", { className: "nn-fb-btn nn-fb-speak" });
      setNarrationState(speakBtn, "idle");
      speakBtn.onclick = () => narrate(answer, speakBtn);
      row.appendChild(speakBtn);
    }
    last.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  // Human-readable note of an action, stored in history as the model's memory.
  function describeAction(action, label) {
    const l = label ? ` "${label}"` : "";
    const why = action.reason ? ` (${action.reason})` : "";
    if (action.action === "type") return `Typed "${action.value || ""}" into${l || " the field"}.${why}`;
    if (action.action === "select") return `Selected "${action.value || ""}" in${l || " the dropdown"}.${why}`;
    if (action.action === "slider") return `Set${l || " the slider"} to ${action.value}.${why}`;
    if (action.action === "navigate") return `Navigated to ${label || action.url || "another page"}.${why}`;
    return `Did ${action.action}${l}.${why}`;
  }

  // ---- action execution ----------------------------------------------------
  // Returns { navigated, label, executed }:
  //   navigated — a page load was triggered (loop resumes after reload)
  //   label     — the acted element's visible text (for memory + the loop guard)
  //   executed  — false when the target element wasn't found (nothing happened)
  const skip = { navigated: false, label: "", executed: false };

  // Unloading the page kills the voice socket and every audio buffer queued in
  // it, so a navigation fired while the agent is talking chops it off mid-word.
  // Let it land the sentence first — the cursor has already moved, so the pause
  // reads as deliberate rather than as lag.
  async function letVoiceFinishSpeaking() {
    if (!(voice && voice.isActive())) return;
    await voice.waitUntilQuiet(6000);
    // Re-stash the thread now that the last sentence is actually in it, so the
    // reconnect on the next page resumes from a complete turn.
    voice.armHandoff();
  }

  // Does this same-origin URL actually exist? Only an answer the server really
  // gave us counts — a network hiccup must never look like a missing page.
  async function urlIsMissing(href) {
    try {
      const res = await fetch(href, { method: "HEAD", redirect: "follow" });
      return res.status === 404 || res.status === 410;
    } catch (_) {
      return false; // offline / blocked / CORS — not evidence of anything
    }
  }

  // Work out where a requested navigation should actually go, or why it must not
  // happen. Returns { url } to proceed, or { failure } to refuse and tell the model.
  async function resolveDestination(href) {
    let target;
    try {
      target = new URL(href, window.location.href);
    } catch {
      return { failure: `"${href}" is not a valid URL.` };
    }

    // The site map is built by a crawler that may have run against a different
    // host than the visitor is on right now — www vs non-www, http vs https,
    // staging vs production, a different dev port. Following it literally throws
    // the visitor onto another origin, which silently drops the whole session:
    // chat history, undo stack and the live voice conversation all live in
    // per-origin storage. Prefer the equivalent page on the origin we're on.
    if (target.origin !== window.location.origin) {
      const local = new URL(target.pathname + target.search + target.hash, window.location.origin);
      if (!(await urlIsMissing(local.href))) {
        return { url: local.href };
      }
      return { url: target.href }; // genuinely somewhere else; go as asked
    }

    if (target.href.replace(/#.*$/, "") === window.location.href.replace(/#.*$/, "")) {
      return { failure: "That is the page we're already on." };
    }
    if (await urlIsMissing(target.href)) {
      return {
        failure:
          `${target.pathname} does not exist on this site (404). Do not retry it or guess a similar ` +
          `path — use a link that is actually present in pageElements, or tell the user the page isn't available.`,
      };
    }
    return { url: target.href };
  }

  // The page-navigating href on an element, or "" if it hasn't got one. Covers
  // <a>/<area>, SVG <a> (whose href lives in href.baseVal), and any element that
  // simply carries an href attribute. Excludes hrefs that DON'T load a page —
  // same-page anchors (#…, handled by a plain click that scrolls) and non-http
  // schemes (javascript:/mailto:/tel:/sms:, which the browser handles itself).
  function linkHref(node) {
    if (!node || !node.getAttribute) return "";
    let href = node.getAttribute("href");
    if (!href && node.href && typeof node.href === "object") href = node.href.baseVal; // SVG
    href = (href || "").trim();
    if (!href || href.startsWith("#")) return "";
    if (/^(javascript|mailto|tel|sms|data|blob):/i.test(href)) return "";
    return href;
  }

  // Does clicking this probably leave the page? Any element with a real href is
  // the common case worth waiting on (so voice can finish its sentence first).
  function likelyNavigates(node) {
    return !!linkHref(node);
  }

  // A hash-only URL change (same document, no reload) is NOT a navigation the
  // loop should stop and wait for — boot() only re-runs on a real page load, so
  // treating an in-page anchor / hash-router jump as a navigation freezes the
  // agent until the next real load. Compare without the hash.
  function leftThePage(fromUrl, unloadFired) {
    if (unloadFired) return true;
    return window.location.href.replace(/#.*$/, "") !== fromUrl.replace(/#.*$/, "");
  }

  async function performAction(action) {
    const { action: type, target_id, value, url, reason } = action;
    if (reason) setStatus(reason);

    if (type === "navigate") {
      const node = target_id ? findByAgentId(target_id) : null;
      if (node) {
        const label = elementText(node);
        await moveCursorToNode(node);
        await letVoiceFinishSpeaking();
        // Watch for the page actually starting to unload. A "navigate" whose
        // target turns out NOT to navigate — a #anchor, a target=_blank link, or
        // an element that merely toggles something — must not report success:
        // otherwise the loop stops waiting for a reload that never comes and the
        // agent freezes (with the continuation flag stuck) until the next page
        // load happens to resume it. Same guard the click branch uses.
        const before = window.location.href;
        let leaving = false;
        const onLeave = () => { leaving = true; };
        window.addEventListener("pagehide", onLeave);
        window.addEventListener("beforeunload", onLeave);
        armContinuation(reason || `Navigating to ${label || "another page"}…`);
        node.click();
        await sleep(400); // give a redirect time to begin unloading
        window.removeEventListener("pagehide", onLeave);
        window.removeEventListener("beforeunload", onLeave);
        if (leftThePage(before, leaving)) {
          return { navigated: true, label, executed: true };
        }
        // Didn't move. Follow the element's href directly if it has one;
        // otherwise the navigate was a misfire — disarm and let the loop take the
        // NEXT step in place rather than freeze waiting for a reload.
        const href = linkHref(node);
        if (href) {
          window.location.href = new URL(href, window.location.href).href; // continuation still armed
          return { navigated: true, label, executed: true };
        }
        disarmContinuation();
        return { navigated: false, label, executed: true };
      }
      if (url) {
        // The model can hallucinate a plausible-looking path ("/faq") the site has
        // never had, and the site map can point at a stale host. Resolve both
        // before committing — landing the visitor on a 404, or on another origin
        // that wipes the session, can't be recovered from by re-reading the page.
        const dest = await resolveDestination(url);
        if (dest.failure) {
          return { navigated: false, label: url, executed: false, failure: dest.failure };
        }
        await letVoiceFinishSpeaking();
        armContinuation(reason || `Navigating to ${url}…`);
        window.location.href = dest.url;
        return { navigated: true, label: url, executed: true };
      }
      return skip;
    }

    const node = target_id ? findByAgentId(target_id) : null;
    if (!node) return skip; // element gone — model will get a fresh scan and can retry/ask
    const label = elementText(node);

    await moveCursorToNode(node);

    if (type === "click") {
      if (likelyNavigates(node)) await letVoiceFinishSpeaking();
      await flashClick(node);
      // A click can navigate asynchronously — an <a href>, a form submit, or a JS
      // redirect. While the old document is still alive, window.location.href hasn't
      // changed yet, so a same-tick location poll wrongly concludes "didn't move"
      // and clears the continuation flag right before the page unloads — which reset
      // the whole session. Instead, arm continuation up front and watch for the page
      // actually starting to unload; only disarm if it's clearly staying put.
      const before = window.location.href;
      let leaving = false;
      const onLeave = () => { leaving = true; };
      window.addEventListener("pagehide", onLeave);
      window.addEventListener("beforeunload", onLeave);
      armContinuation(reason);
      realClick(node);
      await sleep(400); // give a redirect time to begin unloading
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      const navigated = leftThePage(before, leaving);
      if (!navigated) {
        // The element carries an href but clicking it didn't navigate — a link
        // whose default was preventDefault'd, or a non-anchor with an href
        // attribute the browser doesn't follow on its own. Honour it as a link
        // and go there. It came from the live DOM (not the model), so no
        // hallucination/404 guard is needed — just follow it.
        const href = linkHref(node);
        if (href) {
          await letVoiceFinishSpeaking();
          window.location.href = new URL(href, window.location.href).href; // continuation already armed
          return { navigated: true, label, executed: true };
        }
        disarmContinuation();
      }
      return { navigated, label, executed: true };
    }

    if (type === "type") {
      node.focus();
      await typeInto(node, value || "");
      disarmContinuation();
      return { navigated: false, label, executed: true };
    }

    if (type === "select" && node.tagName === "SELECT") {
      const requested = String(value || "");
      const option = Array.from(node.options).find(
        (candidate) =>
          !candidate.disabled &&
          (candidate.value === requested || candidate.text.trim() === requested)
      );
      if (!option) return skip;

      node.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value"
      ).set;
      setter.call(node, option.value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      disarmContinuation();
      return {
        navigated: false,
        label: `${label}: ${option.text.trim()}`,
        executed: true,
      };
    }

    if (type === "slider" && isSlider(node)) {
      const min = parseFloat(sliderMin(node));
      const max = parseFloat(sliderMax(node));
      const step = parseFloat(sliderStep(node));
      let target = parseFloat(value);
      if (!Number.isFinite(target)) return skip;
      if (Number.isFinite(min)) target = Math.max(min, target);
      if (Number.isFinite(max)) target = Math.min(max, target);
      if (Number.isFinite(min) && Number.isFinite(step) && step > 0) {
        target = min + Math.round((target - min) / step) * step; // snap to the nearest valid step
      }
      target = Math.round(target * 1000) / 1000; // trim floating-point noise

      if (isRangeInput(node)) {
        await dragRangeInput(node, target, min, max);
      } else {
        await dragAriaSlider(node, target, Number.isFinite(step) && step > 0 ? step : 1);
      }
      disarmContinuation();
      return { navigated: false, label: `${label}: ${target}`, executed: true };
    }

    if (type === "scroll") {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      disarmContinuation();
      return { navigated: false, label, executed: true };
    }

    if (type === "highlight") {
      pulseHighlight(node);
      disarmContinuation();
      return { navigated: false, label, executed: true };
    }

    return skip;
  }

  // After a navigation, resume the agent loop on the next page load. We also stash
  // the reason so the destination page can show a notice of what the bot is doing
  // (the cursor caption is wiped by the page reload).
  function armContinuation(reason) {
    SS.setItem("navinate.continue", "1");
    if (reason) SS.setItem("navinate.navNotice", reason);
    persist();
  }
  function disarmContinuation() {
    SS.removeItem("navinate.continue");
    SS.removeItem("navinate.navNotice");
  }

  // ---- fake cursor + real interaction --------------------------------------
  let captionTimer;
  let cursorIdleTimer;

  function wakeCursor() {
    clearTimeout(cursorIdleTimer);
    cursor.classList.add("nn-cursor-active");
  }

  function hideIdleCursor(delay = 1300) {
    clearTimeout(cursorIdleTimer);
    cursorIdleTimer = setTimeout(() => {
      cursor.classList.remove("nn-cursor-active", "nn-cursor-click");
    }, delay);
  }

  function showCursorCaption(text) {
    clearTimeout(captionTimer);
    clearTimeout(cursorIdleTimer);
    cursorCaption.textContent = text || "Working on this…";
    cursorCaption.classList.add("nn-caption-visible");
  }

  function hideCursorCaption(delay = 900) {
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => {
      cursorCaption.classList.remove("nn-caption-visible");
    }, delay);
    hideIdleCursor(delay + 450);
  }

  // Just landed on a page the agent navigated to: park the cursor at a visible
  // spot and show what it's doing beneath it — the same "text under the cursor"
  // affordance, carried across the page reload so the jump never feels silent.
  function showNavNotice(text) {
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(Math.max(96, window.innerHeight * 0.26));
    wakeCursor();
    cursor.classList.toggle("nn-cursor-left", x > window.innerWidth - 250);
    cursor.classList.toggle("nn-cursor-above", y > window.innerHeight - 100);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    showCursorCaption(text);
    hideCursorCaption(2600); // fades on its own; the next real action cancels it
  }

  function moveCursorToNode(node) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    return sleep(120).then(() => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      wakeCursor();
      cursor.classList.toggle("nn-cursor-left", x > window.innerWidth - 250);
      cursor.classList.toggle("nn-cursor-above", y > window.innerHeight - 100);
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      return sleep(650); // let the cursor glide
    });
  }

  async function flashClick(node) {
    cursor.classList.add("nn-cursor-click");
    pulseHighlight(node, 600);
    await sleep(400); // long enough to actually register the click pose vs. the hover pose
    cursor.classList.remove("nn-cursor-click");
  }

  // Click the element exactly ONCE. We send mousedown/mouseup for press semantics,
  // then a single native node.click() — that one call fires plain onclick handlers
  // AND bubbles a native click that React/Vue event delegation picks up. (Do NOT
  // also dispatch a "click" MouseEvent here: that plus node.click() = two clicks,
  // which double-fires handlers — e.g. adding an item to the cart twice.)
  function realClick(node) {
    const rect = node.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    node.dispatchEvent(new MouseEvent("mousedown", opts));
    node.dispatchEvent(new MouseEvent("mouseup", opts));
    node.click();
  }

  // Type character-by-character, using the native value setter so React/Vue
  // controlled inputs register the change.
  async function typeInto(node, text) {
    const proto =
      node.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    // Clear first even when the requested value is empty. Previously the setter
    // only ran inside the loop, so clearing a field was incorrectly a no-op.
    let acc = "";
    setter.call(node, acc);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    for (const ch of String(text)) {
      acc += ch;
      setter.call(node, acc);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(35);
    }
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Animate a native <input type=range> from its current value to `target`,
  // dispatching input/change like a real drag so React/Vue controlled sliders
  // pick it up — and sliding the fake cursor along the track as it goes.
  async function dragRangeInput(node, target, min, max) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const start = parseFloat(node.value);
    const from = Number.isFinite(start) ? start : target;
    const rect = node.getBoundingClientRect();
    const span = Number.isFinite(min) && Number.isFinite(max) && max > min ? max - min : null;
    const FRAMES = 10;
    for (let i = 1; i <= FRAMES; i++) {
      const v = from + ((target - from) * i) / FRAMES;
      setter.call(node, String(v));
      node.dispatchEvent(new Event("input", { bubbles: true }));
      if (span) {
        const frac = Math.min(1, Math.max(0, (v - min) / span));
        cursor.style.transform = `translate(${rect.left + frac * rect.width}px, ${rect.top + rect.height / 2}px)`;
      }
      await sleep(30);
    }
    setter.call(node, String(target));
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Best-effort mover for custom ARIA role="slider" widgets — there's no native
  // value setter to call, so nudge it with arrow-key presses, the interaction
  // every compliant slider widget must support per the WAI-ARIA authoring
  // practices. Stops once aria-valuenow reaches the target, or as soon as the
  // widget stops responding (so a non-conformant widget can't hang the loop).
  async function dragAriaSlider(node, target, step) {
    node.focus();
    let current = parseFloat(node.getAttribute("aria-valuenow"));
    if (!Number.isFinite(current)) return;
    const maxPresses = 200; // hard safety cap
    for (let presses = 0; presses < maxPresses && Math.abs(current - target) > step / 2; presses++) {
      const key = current < target ? "ArrowRight" : "ArrowLeft";
      node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      node.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      await sleep(25);
      const next = parseFloat(node.getAttribute("aria-valuenow"));
      if (!Number.isFinite(next) || next === current) break; // not responding to keys; give up
      current = next;
    }
  }

  function pulseHighlight(node, ms = 1400) {
    const rect = node.getBoundingClientRect();
    const ring = el("div", { className: "nn-ring" }, {
      left: rect.left - 4 + "px",
      top: rect.top - 4 + "px",
      width: rect.width + 8 + "px",
      height: rect.height + 8 + "px",
    });
    root.appendChild(ring);
    setTimeout(() => ring.remove(), ms);
  }

  // ---- voice (ElevenLabs) --------------------------------------------------
  // The mic turns NaviNate from "type a goal, watch the cursor" into a spoken
  // conversation with something that can operate the page while you talk to it.
  // widget/voice.js owns the audio and the socket; everything below is the bridge
  // it needs into this file — the goal runner, the DOM, and the chat log.

  let voiceLoading = null;
  function loadVoiceModule() {
    if (window.NaviNateVoice) return Promise.resolve(window.NaviNateVoice);
    if (voiceLoading) return voiceLoading;
    voiceLoading = new Promise((resolve, reject) => {
      const s = el("script", { src: VOICE_SRC, async: true });
      s.onload = () => (window.NaviNateVoice ? resolve(window.NaviNateVoice) : reject(new Error("voice module did not register")));
      s.onerror = () => reject(new Error("could not load the voice module"));
      document.head.appendChild(s);
    });
    return voiceLoading;
  }

  // What the voice agent "sees". It has no DOM, so this is its only window onto
  // the page the visitor is actually looking at.
  function describePageForVoice() {
    return `The visitor is on "${document.title}" (${location.href}). Visible content:\n${getPageText()}`;
  }

  async function ensureVoice() {
    if (voice) return voice;
    const mod = await loadVoiceModule();
    voice = mod.create({
      BACKEND,
      CLIENT_ID,
      track,
      // The spoken entry point into the exact same agent loop the text box uses.
      runGoal: (goal) => runGoal(goal, { via: "voice" }),
      readPage: () => ({ url: location.href, title: document.title, text: getPageText() }),
      undo: () => undoLastCommand(),
      // Speech shows up in the chat log as it happens, so the visitor has a
      // transcript to scroll back through and deaf/HoH users aren't shut out.
      onTranscript: (role, text) => {
        // The agent's first_message is the same welcome line the panel already
        // painted on load, so it would land twice the moment voice connects.
        // More generally, never repeat the bubble we just showed.
        if (role === "assistant" && isDuplicateOfLastBubble(text)) return;
        setCaption(role, text); // the stage shows the line being said right now
        addBubble(role, text);
        state.history.push({ role, content: text });
        persist();
        // This spoken reply is the answer to the goal that just finished, so it's
        // the one worth rating.
        if (role === "assistant" && pendingVoiceFeedback) {
          pendingVoiceFeedback = false;
          attachFeedback();
        }
        if (role === "user") {
          renderSuggestions();
          track("message_sent", { message: text });
        }
      },
      onStatus: setVoiceStatus,
      onError: (m) => {
        addBubble("assistant", m);
        setVoiceStatus("error");
      },
      onEnded: () => {
        setVoiceStatus("idle");
        setStatus("");
      },
    });
    // The visitor can leave the page themselves mid-sentence (clicking a link,
    // hitting back). Stash the thread on the way out so the reconnect on the next
    // page doesn't start cold.
    window.addEventListener("pagehide", () => {
      if (voice && voice.isActive()) voice.armHandoff();
    });
    return voice;
  }

  // ---- voice mode UI -------------------------------------------------------
  // While a call is live the keyboard is the wrong affordance, so the text bar
  // and transcript give way to a stage: captions, a visualiser that breathes with
  // whoever is talking, and the controls. The transcript keeps filling underneath
  // and is one tap away via the keyboard button.
  let voiceUIOn = false;
  let orbRaf = 0;

  // Voice mode and text mode are two views of the SAME live call — switching
  // between them never starts or ends anything. Voice mode hides the panel and
  // the launcher so only the floating stage is over the site; text mode brings
  // the panel back with the transcript already filled in.
  function setVoiceUI(on) {
    if (!root || voiceUIOn === on) return;
    voiceUIOn = on;
    root.classList.toggle("nn-voice-open", on);
    if (on) {
      if (captionEl && !captionEl.textContent.trim()) {
        setCaption("hint", "Just say what you're looking for.");
      }
      startOrb();
    } else {
      stopOrb();
      // Coming back to typing: show the conversation that happened while talking.
      if (voice && voice.isActive()) openPanel();
      log && (log.scrollTop = log.scrollHeight);
    }
    updateMicButton();
  }

  // The input-bar mic is the way back INTO voice mode, so it has to read
  // differently depending on whether a call is already up.
  function updateMicButton() {
    if (!micBtn) return;
    const live = voice && voice.isActive();
    micBtn.title = live ? "Back to voice mode" : "Talk to me";
    micBtn.setAttribute("aria-label", micBtn.title);
    micBtn.innerHTML = live ? "🔊" : "🎙";
  }

  function startOrb() {
    cancelAnimationFrame(orbRaf);
    const tick = () => {
      if (!voiceUIOn || !orbEl) return;
      const lv = voice && voice.isActive() ? voice.levels() : { out: 0, in: 0 };
      // The two sides drive different parts so you can tell at a glance who has
      // the floor: the halo is the agent's voice, the core is yours.
      orbEl.style.setProperty("--nn-out", (1 + lv.out * 0.55).toFixed(3));
      orbEl.style.setProperty("--nn-in", (1 + lv.in * 0.32).toFixed(3));
      orbEl.style.setProperty("--nn-glow", (0.25 + lv.out * 0.6).toFixed(3));
      orbEl.classList.toggle("nn-orb-quiet", lv.out < 0.02 && lv.in < 0.04);
      orbRaf = requestAnimationFrame(tick);
    };
    orbRaf = requestAnimationFrame(tick);
  }

  function stopOrb() {
    cancelAnimationFrame(orbRaf);
    orbRaf = 0;
  }

  // Captions: just the line being said right now. Anything older belongs to the
  // transcript, which is still there behind the stage.
  function setCaption(role, text) {
    if (!captionEl || !text) return;
    captionEl.className = "nn-vcaption nn-vcaption-" + role;
    captionEl.textContent = text;
    // Re-trigger the entry animation on each new line.
    captionEl.style.animation = "none";
    void captionEl.offsetWidth;
    captionEl.style.animation = "";
  }

  function toggleMute() {
    if (!voice || !voice.isActive()) return;
    const next = !voice.isMuted();
    voice.mute(next);
    vMicBtn.classList.toggle("nn-vmic-off", next);
    vMicBtn.innerHTML = next ? "🔇" : "🎙";
    vMicBtn.title = next ? "Unmute microphone" : "Mute microphone";
    vMicBtn.setAttribute("aria-label", vMicBtn.title);
    if (vStateEl) vStateEl.textContent = next ? "Muted" : VOICE_LABELS[voice.status()] || "";
  }

  const VOICE_LABELS = {
    connecting: "Connecting…",
    listening: "Listening — just talk",
    speaking: "Speaking…",
    working: "Working on the page…",
    error: "Voice unavailable",
    idle: "",
  };

  function setVoiceStatus(status) {
    if (!micBtn) return;
    const live = status !== "idle" && status !== "error";
    micBtn.classList.toggle("nn-mic-live", live);
    micBtn.classList.toggle("nn-mic-hot", status === "listening");
    micBtn.classList.toggle("nn-mic-speaking", status === "speaking");
    // Don't stomp on the agent's own "what I'm clicking" status while it drives.
    if (!busy) setStatus(VOICE_LABELS[status] || "");

    // Starting a call opens the stage; ending one always closes it. Switching
    // views mid-call is the visitor's choice, so don't yank them back.
    if (live && !voiceUIOn && status === "connecting") setVoiceUI(true);
    if (!live) setVoiceUI(false);
    updateMicButton();
    if (vStateEl && !(voice && voice.isMuted())) vStateEl.textContent = VOICE_LABELS[status] || "";
    if (orbEl) {
      orbEl.classList.toggle("nn-orb-working", status === "working");
      orbEl.classList.toggle("nn-orb-connecting", status === "connecting");
    }
    // While the agent drives the page the panel minimises so the visitor can watch
    // the cursor — mark the launcher so it's obvious the call is still up.
    if (launcher) launcher.classList.toggle("nn-launcher-live", live);
  }

  async function toggleVoice() {
    // A call is already running and we're looking at the transcript — this is a
    // view switch, not a hang-up. Ending is the ✕ on the stage.
    if (voice && voice.isActive()) {
      setVoiceUI(true);
      return;
    }
    setVoiceStatus("connecting");
    try {
      const v = await ensureVoice();
      await v.start();
    } catch (err) {
      console.warn("[NaviNate] voice failed:", err);
      setVoiceStatus("error");
      addBubble(
        "assistant",
        err && /permission|denied|NotAllowed/i.test(String(err.name || err.message))
          ? "I need microphone access to talk — you can still type to me here."
          : "I couldn't start the voice connection. Typing still works fine."
      );
    }
  }

  // Speak a single assistant message out loud (the 🔊 on each reply). This is the
  // one-shot TTS path — no mic, no session — so visitors who prefer to read but
  // want a line read back still get the good voice.
  //
  // The button is the whole transport: 🔊 → spinner while the audio is generated
  // → ⏸ while playing → ▶ paused. Clicking during the spinner cancels the
  // request, because waiting on speech you no longer want is worse than silence.
  // Only one line is ever narrated at a time; starting another takes over.
  let narration = null; // { btn, audio, url, controller }

  function setNarrationState(btn, state) {
    if (!btn) return;
    btn.classList.remove("nn-fb-loading", "nn-fb-playing", "nn-fb-paused");
    if (state !== "idle") btn.classList.add("nn-fb-" + state);
    btn.innerHTML =
      state === "loading" ? '<span class="nn-spin" aria-hidden="true"></span>' :
      state === "playing" ? "⏸" :
      state === "paused" ? "▶" : "🔊";
    btn.title =
      state === "loading" ? "Preparing audio — click to cancel" :
      state === "playing" ? "Pause" :
      state === "paused" ? "Resume" : "Read this aloud";
    btn.setAttribute("aria-label", btn.title);
  }

  // Tear the current narration down completely and return its button to 🔊.
  function stopNarration() {
    if (!narration) return;
    const { btn, audio, url, controller } = narration;
    narration = null; // clear first: abort() and pause() fire handlers that check it
    try { controller && controller.abort(); } catch (_) {}
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    if (url) URL.revokeObjectURL(url);
    setNarrationState(btn, "idle");
  }

  async function narrate(text, btn) {
    // Clicking the button that owns the current narration is a transport control,
    // not a new request.
    if (narration && narration.btn === btn) {
      const audio = narration.audio;
      if (!audio) return stopNarration(); // still generating — cancel it
      if (audio.paused) {
        try { await audio.play(); } catch (_) { return stopNarration(); }
        setNarrationState(btn, "playing");
      } else {
        audio.pause();
        setNarrationState(btn, "paused");
      }
      return;
    }

    stopNarration(); // a different reply — take over
    const controller = new AbortController();
    narration = { btn, audio: null, url: null, controller };
    setNarrationState(btn, "loading");
    try {
      const res = await fetch(BACKEND + "/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: CLIENT_ID, text }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("tts " + res.status);
      const blob = await res.blob();
      // Cancelled (or superseded) while the audio was downloading.
      if (!narration || narration.btn !== btn) return;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      narration.audio = audio;
      narration.url = url;
      audio.onended = () => { if (narration && narration.audio === audio) stopNarration(); };
      await audio.play();
      setNarrationState(btn, "playing");
      track("voice_narration");
    } catch (err) {
      if (err && err.name === "AbortError") return; // cancelled; already reset
      console.warn("[NaviNate] narration failed:", err);
      stopNarration();
      setStatus("I couldn't play that audio just now.");
      setTimeout(() => setStatus(""), 2600);
    }
  }

  // ---- boot ----------------------------------------------------------------
  async function loadTheme() {
    try {
      const res = await fetch(BACKEND + "/config?clientId=" + encodeURIComponent(CLIENT_ID));
      if (res.ok) theme = { ...theme, ...(await res.json()) };
    } catch (_) {
      /* fall back to defaults */
    }
  }

  async function boot() {
    await loadTheme();
    // Master kill switch: a client can disable the widget without removing the
    // <script> tag. Bail before building any UI.
    if (theme.enabled === false) return;
    if (Number.isFinite(theme.maxAutoSteps)) MAX_AUTO_STEPS = theme.maxAutoSteps;
    buildUI();
    const pendingAppUndo = SS.getItem("navinate.undoAppState");
    if (pendingAppUndo) {
      SS.removeItem("navinate.undoAppState");
      try { restoreAppUndoState(JSON.parse(pendingAppUndo)); } catch (_) { /* ignore stale state */ }
    }
    const undoNotice = SS.getItem("navinate.undoNotice");
    if (undoNotice) {
      SS.removeItem("navinate.undoNotice");
      openPanel();
      addBubble("assistant", undoNotice);
      state.history.push({ role: "assistant", content: undoNotice });
      persist();
    }
    // A voice conversation was running when the page changed (the agent navigated,
    // or the visitor clicked a link themselves). The socket died with the old
    // document, so reconnect and replay the thread — from the visitor's side it's
    // one conversation that happened to walk across several pages.
    if (theme.voiceEnabled && SS.getItem("navinate.voice.active") === "1") {
      ensureVoice()
        .then((v) => v.resume())
        .catch((err) => {
          console.warn("[NaviNate] could not resume voice:", err);
          SS.removeItem("navinate.voice.active");
        });
    }

    // Count genuine page loads where the widget is present (the denominator for
    // adoption %). Skip agent-driven reloads so they don't inflate page views.
    if (!state.pendingContinue) track("widget_loaded");
    // If the agent navigated us here mid-task, keep going automatically.
    if (state.pendingContinue) {
      disarmContinuation();
      // If we're still driving the page, stay minimized and let the cursor notice
      // do the talking; otherwise pop open. Either way, resume the goal.
      if (state.acting) closePanel();
      else openPanel();
      // Show a notice of what the bot just did to land here (persisted pre-reload).
      const notice = state.navNotice || "Continuing…";
      setStatus(notice);
      if (state.navNotice) showNavNotice(state.navNotice);
      await sleep(700); // let the new page settle
      if (state.autoSteps < MAX_AUTO_STEPS) {
        state.autoSteps++;
        persist();
        // "" (not state.activeGoal) so runTurn wraps this as a CONTINUATION via
        // continueGoalMessage() instead of resending the original command as a
        // fresh user message — otherwise the model has no signal it already acted
        // on this goal and re-clicks the same nav link that got it here.
        //
        // The goal finishing here is the other half of a navigate_site call whose
        // tool result died with the previous page's socket, so hand the outcome to
        // the voice agent explicitly — otherwise it never gets a turn and stays
        // silent for the rest of the conversation.
        runTurn("").then((outcome) => {
          if (outcome && !outcome.navigated && voice && voice.isActive()) {
            voice.reportGoalResult(outcome.summary);
          }
        });
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // ---- assets --------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function css() {
    return `
    #navinate-root { all: initial; }
    #navinate-root, #navinate-root * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    #navinate-root {
      --nn-accent: #4f46e5;
      /* Sky + liquid glass. Every surface is translucent white over a soft blue
         wash, so the widget reads like glass catching daylight rather than a card
         sitting on the page. The client's brand colour still drives the accents,
         so this restyle doesn't cost them their identity. */
      --nn-ink: #16354d;
      --nn-ink-soft: #5b7893;
      --nn-glass: rgba(255,255,255,.62);
      --nn-glass-strong: rgba(255,255,255,.80);
      --nn-edge: rgba(255,255,255,.85);
      --nn-blur: saturate(170%) blur(22px);
      --nn-lift: 0 18px 48px rgba(23,72,110,.20), 0 2px 8px rgba(23,72,110,.08);
      /* the sheen that makes an accent-filled surface look like wet glass */
      --nn-sheen: linear-gradient(140deg, rgba(255,255,255,.38), rgba(255,255,255,.06) 62%);
    }

    .nn-launcher {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      /* footprint tracks the scaled logo (60px box × 2.5) so the whole visible
         mark is clickable, not just its centre */
      width: 86px; height: 86px; border: none; cursor: pointer; padding: 0;
      background: transparent; color: #fff; font-size: 26px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      transition: transform .18s cubic-bezier(.34,1.4,.5,1);
      filter: drop-shadow(0 10px 22px rgba(23,90,140,.34));
    }
    .nn-launcher:hover { transform: translateY(-2px) scale(1.06); }
    .nn-hidden { display: none !important; }

    .nn-icon-img { display: block; object-fit: contain; border-radius: 8px; }
    /* The brand PNG carries a lot of transparent padding, so the mark reads small
       inside its box. Scaling the artwork up (rather than the box) grows the mark
       ~2.5x while the launcher/header footprints stay put — the overflow is only
       transparent padding, so nothing visually collides. */
    .nn-launcher-icon {
      width: 60px; height: 60px; border-radius: 14px;
      transform: scale(2.5); transform-origin: center;
      filter: drop-shadow(0 8px 20px rgba(0,0,0,.3)); transition: transform .15s ease;
    }
    .nn-header-icon {
      display: inline-block; width: 24px; height: 24px; border-radius: 7px;
      transform: scale(2.5); transform-origin: center;
    }

    /* "still working" cue while the agent is acting and the panel is minimized —
       the fake cursor is the primary signal, this is the backup for when it's
       out of view: the launcher logo breathes instead of sitting static. */
    .nn-launcher-busy .nn-launcher-icon { animation: nn-icon-pulse 1.1s ease-in-out infinite; }
    /* keyed off the 2.5x base scale so the pulse breathes AROUND it rather than
       snapping the logo back to its small resting size while working */
    @keyframes nn-icon-pulse {
      0%, 100% { transform: scale(2.5); }
      50% { transform: scale(2.95); }
    }

    /* bottom-left placement when the client configures widget_position */
    #navinate-root.nn-left .nn-launcher,
    #navinate-root.nn-left .nn-panel { right: auto; left: 22px; }

    /* The panel is a single pane of glass: a daylight highlight at the top left,
       a wash of sky at the top right, and a bank of cloud resting at the bottom.
       All of it lives in the background stack rather than in extra elements, so
       nothing can stack on top of the transcript. */
    .nn-panel {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      width: 380px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 44px);
      border-radius: 24px; overflow: hidden; display: none; flex-direction: column;
      color: var(--nn-ink);
      background:
        radial-gradient(120% 78% at 10% -6%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 58%),
        radial-gradient(95% 55% at 104% 2%, rgba(168,215,246,.85) 0%, rgba(168,215,246,0) 62%),
        radial-gradient(72% 42% at 22% 107%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 72%),
        radial-gradient(62% 38% at 78% 112%, rgba(255,255,255,.9) 0%, rgba(255,255,255,0) 72%),
        linear-gradient(180deg, rgba(255,255,255,.80) 0%, rgba(223,241,254,.74) 100%);
      backdrop-filter: var(--nn-blur); -webkit-backdrop-filter: var(--nn-blur);
      border: 1px solid var(--nn-edge);
      box-shadow: var(--nn-lift), inset 0 1px 0 rgba(255,255,255,.95);
    }
    .nn-panel.nn-open { display: flex; animation: nn-pop .22s cubic-bezier(.22,1.2,.4,1); }
    @keyframes nn-pop { from { transform: translateY(14px) scale(.97); opacity: 0; } to { transform: none; opacity: 1; } }

    .nn-header {
      background: var(--nn-sheen), var(--nn-accent);
      color: #fff; padding: 14px 16px;
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid rgba(255,255,255,.5);
      box-shadow: 0 6px 20px rgba(23,72,110,.16), inset 0 1px 0 rgba(255,255,255,.55);
    }
    .nn-title { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 7px;
      text-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .nn-header-actions { display: flex; align-items: center; gap: 2px; }
    .nn-min, .nn-reset { background: transparent; border: none; color: #fff; cursor: pointer; line-height: 1; padding: 0 6px; border-radius: 8px; }
    .nn-min { font-size: 24px; }
    .nn-reset { font-size: 17px; padding: 4px 7px; }
    .nn-min:hover, .nn-reset:hover { background: rgba(255,255,255,.24); }

    /* transparent so the panel's own sky shows through the conversation */
    .nn-log { flex: 1; overflow-y: auto; padding: 16px; background: transparent; display: flex; flex-direction: column; gap: 10px; }
    .nn-log::-webkit-scrollbar { width: 8px; }
    .nn-log::-webkit-scrollbar-track { background: transparent; }
    .nn-log::-webkit-scrollbar-thumb { background: rgba(88,142,184,.28); border-radius: 8px; }
    .nn-log::-webkit-scrollbar-thumb:hover { background: rgba(88,142,184,.45); }

    .nn-msg { max-width: 84%; padding: 10px 13px; border-radius: 17px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; animation: nn-in .2s ease; }
    @keyframes nn-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .nn-user {
      align-self: flex-end; color: #fff; border-bottom-right-radius: 6px;
      background: var(--nn-sheen), var(--nn-accent);
      border: 1px solid rgba(255,255,255,.45);
      box-shadow: 0 8px 20px rgba(23,72,110,.20), inset 0 1px 0 rgba(255,255,255,.5);
    }
    .nn-assistant {
      align-self: flex-start; color: var(--nn-ink); border-bottom-left-radius: 6px; white-space: normal;
      background: var(--nn-glass-strong);
      backdrop-filter: saturate(150%) blur(14px); -webkit-backdrop-filter: saturate(150%) blur(14px);
      border: 1px solid var(--nn-edge);
      box-shadow: 0 8px 22px rgba(23,72,110,.13), inset 0 1px 0 rgba(255,255,255,.9);
    }

    /* rendered markdown inside assistant bubbles */
    .nn-assistant > :first-child { margin-top: 0; }
    .nn-assistant > :last-child { margin-bottom: 0; }
    .nn-assistant p { margin: 0 0 8px; }
    .nn-assistant h1, .nn-assistant h2, .nn-assistant h3,
    .nn-assistant h4, .nn-assistant h5, .nn-assistant h6 { margin: 12px 0 6px; line-height: 1.3; }
    .nn-assistant h1 { font-size: 17px; } .nn-assistant h2 { font-size: 16px; }
    .nn-assistant h3 { font-size: 15px; } .nn-assistant h4,
    .nn-assistant h5, .nn-assistant h6 { font-size: 14px; }
    .nn-assistant ul, .nn-assistant ol { margin: 4px 0 8px; padding-left: 20px; }
    .nn-assistant li { margin: 2px 0; }
    .nn-assistant a { color: var(--nn-accent); text-decoration: underline; word-break: break-word; }
    .nn-assistant strong { font-weight: 700; }
    .nn-assistant em { font-style: italic; }
    .nn-assistant code { background: rgba(255,255,255,.7); border: 1px solid rgba(255,255,255,.9);
      border-radius: 6px; padding: 1px 5px; font-size: 12.5px; color: #12405f;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
    .nn-assistant pre { background: rgba(14,42,64,.92); color: #e7f3fb; border-radius: 12px; padding: 11px 13px;
      overflow-x: auto; margin: 8px 0; border: 1px solid rgba(255,255,255,.16); }
    .nn-assistant pre code { background: none; border: none; color: inherit; padding: 0; font-size: 12.5px; }
    .nn-assistant blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid rgba(122,183,225,.75); color: var(--nn-ink-soft); }

    .nn-status { padding: 6px 16px; font-size: 12.5px; color: var(--nn-ink-soft); background: transparent; display: none; font-style: italic; }

    .nn-undo-row { display: none; justify-content: flex-end; padding: 7px 12px; background: transparent; border-top: 1px solid rgba(255,255,255,.6); }
    .nn-undo {
      border: 1px solid var(--nn-edge); background: var(--nn-glass); color: var(--nn-ink);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      border-radius: 11px; padding: 6px 11px; font-size: 12.5px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 12px rgba(23,72,110,.10);
      transition: border-color .12s ease, color .12s ease, background .12s ease, transform .12s ease;
    }
    .nn-undo:hover { color: var(--nn-accent); background: rgba(255,255,255,.85); transform: translateY(-1px); }
    .nn-undo:disabled { opacity: .5; cursor: default; }

    .nn-inputbar {
      display: flex; gap: 8px; padding: 12px; align-items: center;
      background: linear-gradient(180deg, rgba(255,255,255,.30), rgba(255,255,255,.62));
      border-top: 1px solid rgba(255,255,255,.7);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    }
    .nn-input {
      flex: 1; border: 1px solid var(--nn-edge); border-radius: 14px; padding: 11px 14px;
      font-size: 14px; outline: none; color: var(--nn-ink);
      background: rgba(255,255,255,.66);
      box-shadow: inset 0 1px 3px rgba(23,72,110,.08);
      transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
    }
    .nn-input::placeholder { color: rgba(91,120,147,.75); }
    .nn-input:focus {
      background: rgba(255,255,255,.9); border-color: rgba(255,255,255,1);
      box-shadow: inset 0 1px 3px rgba(23,72,110,.06), 0 0 0 3px rgba(122,183,225,.35);
    }
    .nn-send {
      border: 1px solid rgba(255,255,255,.45); color: #fff; border-radius: 14px; width: 44px; height: 42px;
      font-size: 16px; cursor: pointer; flex: none;
      background: var(--nn-sheen), var(--nn-accent);
      box-shadow: 0 6px 16px rgba(23,72,110,.24), inset 0 1px 0 rgba(255,255,255,.5);
      transition: transform .12s ease, filter .12s ease;
    }
    .nn-send:hover { transform: translateY(-1px); filter: brightness(1.06); }

    /* voice: the mic sits left of the input and pulses while the line is open */
    .nn-mic {
      border: 1px solid var(--nn-edge); background: rgba(255,255,255,.66); border-radius: 14px;
      width: 44px; height: 42px; font-size: 16px; cursor: pointer; line-height: 1; flex: none;
      color: var(--nn-ink);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 3px 10px rgba(23,72,110,.10);
      transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .12s ease;
    }
    .nn-mic:hover { background: rgba(255,255,255,.92); transform: translateY(-1px); }
    .nn-mic-live { background: var(--nn-sheen), var(--nn-accent); border-color: rgba(255,255,255,.45); }
    .nn-mic-hot { animation: nn-mic-pulse 1.9s ease-in-out infinite; }
    .nn-mic-speaking { animation: nn-mic-talk .7s ease-in-out infinite; }
    @keyframes nn-mic-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(122,183,225,.75); }
      50% { box-shadow: 0 0 0 8px rgba(122,183,225,0); }
    }
    @keyframes nn-mic-talk { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.09); } }

    /* the goal the voice agent handed to the cursor agent — a quiet activity
       line, not a message, so it reads as something the agent did rather than
       something either party said */
    .nn-task {
      align-self: stretch; background: transparent; color: var(--nn-ink-soft); border: none;
      font-size: 12.5px; font-weight: 500; max-width: 100%; padding: 2px 2px 2px 0;
      display: flex; align-items: baseline; gap: 7px; white-space: normal;
    }
    .nn-task::before {
      content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%;
      background: var(--nn-accent); transform: translateY(-1px);
      box-shadow: 0 0 8px rgba(122,183,225,.9);
    }
    .nn-task-live::before { animation: nn-task-pulse 1.4s ease-in-out infinite; }
    .nn-task-live { color: var(--nn-ink); }
    .nn-task-done::before {
      content: "✓"; width: auto; height: auto; background: none; box-shadow: none;
      color: var(--nn-accent); font-weight: 700; font-size: 12px; transform: none;
    }
    .nn-task-stuck::before {
      content: "•"; width: auto; height: auto; background: none; box-shadow: none;
      color: #a9bccb; font-weight: 700; transform: none;
    }
    .nn-task-stuck { color: #8ba0b3; }
    @keyframes nn-task-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

    /* ---- voice mode: a bare stage floating over the site, bottom centre ----
       No panel, no card, no backdrop — the visitor keeps the whole page. The
       container ignores pointer events so only the controls themselves are
       clickable; everything behind stays usable (and clickable by the agent). */
    .nn-voice {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 2147483400; display: none; flex-direction: column; align-items: center;
      gap: 7px; width: min(440px, calc(100vw - 28px)); pointer-events: none;
    }
    #navinate-root.nn-voice-open .nn-voice { display: flex; animation: nn-stage-in .22s ease; }
    .nn-voice > * { pointer-events: auto; }
    @keyframes nn-stage-in { from { opacity: 0; transform: translate(-50%, 10px); } }
    /* while the stage is up the panel and launcher get out of the way entirely */
    #navinate-root.nn-voice-open .nn-panel,
    #navinate-root.nn-voice-open .nn-launcher { display: none !important; }

    /* Captions carry their own contrast chip — they have to stay readable on top
       of whatever the client's page looks like, which we can't predict. */
    .nn-vcaption {
      max-width: 100%; text-align: center; font-size: 14px; line-height: 1.45; color: var(--nn-ink);
      background: linear-gradient(180deg, rgba(255,255,255,.88), rgba(232,245,254,.82));
      backdrop-filter: saturate(170%) blur(16px); -webkit-backdrop-filter: saturate(170%) blur(16px);
      padding: 10px 15px; border-radius: 16px; border: 1px solid var(--nn-edge);
      box-shadow: 0 10px 30px rgba(23,72,110,.22), inset 0 1px 0 rgba(255,255,255,.95);
      animation: nn-cap-in .22s ease; max-height: 96px; overflow: hidden;
    }
    .nn-vcaption:empty { display: none; }
    .nn-vcaption-user { color: var(--nn-ink-soft); font-style: italic; }
    .nn-vcaption-hint { color: var(--nn-ink-soft); font-size: 13px; }
    @keyframes nn-cap-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

    /* the visualiser as a luminous cloud-drop: a soft daylight halo, a thin ring
       of sky, and a glassy pearl core lit from the top-left like the references */
    .nn-orb { position: relative; width: 116px; height: 116px; }
    .nn-orb span { position: absolute; top: 50%; left: 50%; border-radius: 50%; }
    .nn-orb-halo {
      width: 124px; height: 124px; filter: blur(4px);
      background: radial-gradient(circle, rgba(160,210,244,.95) 0%, rgba(122,183,225,.35) 42%, transparent 70%);
      opacity: var(--nn-glow, .3); transform: translate(-50%, -50%) scale(var(--nn-out, 1));
      transition: opacity .1s linear;
    }
    .nn-orb-ring {
      width: 86px; height: 86px; border: 1.5px solid rgba(255,255,255,.85); opacity: .55;
      box-shadow: 0 0 18px rgba(160,210,244,.6);
      transform: translate(-50%, -50%) scale(var(--nn-out, 1));
    }
    .nn-orb-core {
      width: 64px; height: 64px; transform: translate(-50%, -50%) scale(var(--nn-in, 1));
      background:
        radial-gradient(circle at 36% 28%, #ffffff 0%, rgba(255,255,255,.85) 16%, transparent 42%),
        radial-gradient(circle at 62% 74%, rgba(150,204,242,.95) 0%, transparent 58%),
        linear-gradient(150deg, #eaf6ff 0%, var(--nn-accent) 128%);
      border: 1px solid rgba(255,255,255,.8);
      box-shadow: 0 14px 30px rgba(23,72,110,.30), inset 0 -8px 16px rgba(60,110,150,.28), inset 0 6px 12px rgba(255,255,255,.9);
    }
    /* nobody talking: a slow breath, so it reads as listening rather than frozen */
    .nn-orb-quiet .nn-orb-core { animation: nn-breathe 3.6s ease-in-out infinite; }
    @keyframes nn-breathe {
      0%, 100% { transform: translate(-50%, -50%) scale(1); }
      50% { transform: translate(-50%, -50%) scale(1.045); }
    }
    /* dedicated keyframes: the shared nn-spin animates transform to a bare
       rotate(), which would drop the translate(-50%,-50%) and fling the ring
       off centre. (No backticks in here — this CSS is a JS template literal.) */
    .nn-orb-working .nn-orb-ring {
      opacity: .9; border-color: rgba(255,255,255,.35); border-top-color: #fff;
      animation: nn-orb-spin 1s linear infinite;
    }
    @keyframes nn-orb-spin {
      from { transform: translate(-50%, -50%) rotate(0deg); }
      to { transform: translate(-50%, -50%) rotate(360deg); }
    }
    .nn-orb-connecting .nn-orb-core { animation: nn-breathe 1.1s ease-in-out infinite; }

    /* also chipped, for the same reason as the captions */
    .nn-vstate {
      font-size: 11.5px; color: var(--nn-ink); background: rgba(255,255,255,.78);
      border: 1px solid var(--nn-edge);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      padding: 3px 11px; border-radius: 10px; letter-spacing: .01em;
      box-shadow: 0 4px 14px rgba(23,72,110,.14);
    }
    .nn-vstate:empty { display: none; }

    .nn-vcontrols { display: flex; gap: 10px; align-items: center; }
    .nn-vcontrols button {
      width: 42px; height: 42px; border-radius: 50%; border: 1px solid var(--nn-edge);
      background: var(--nn-glass-strong); color: var(--nn-ink);
      backdrop-filter: saturate(160%) blur(14px); -webkit-backdrop-filter: saturate(160%) blur(14px);
      font-size: 16px; line-height: 1; cursor: pointer; display: grid; place-items: center;
      box-shadow: 0 6px 20px rgba(23,72,110,.20), inset 0 1px 0 rgba(255,255,255,.9);
      transition: transform .12s ease, background .12s ease, border-color .12s ease;
    }
    .nn-vcontrols button:hover { transform: translateY(-1px); background: rgba(255,255,255,.95); }
    /* these need the parent in the selector: ".nn-vcontrols button" is more
       specific than a lone class, so a bare .nn-vend loses and renders white */
    .nn-vcontrols .nn-vkeyboard { font-size: 15px; }
    .nn-vcontrols .nn-vmic-off { background: rgba(255,236,235,.9); border-color: rgba(240,180,176,.9); }
    .nn-vcontrols .nn-vend {
      background: var(--nn-sheen), var(--nn-accent); border-color: rgba(255,255,255,.45); color: #fff; font-size: 15px;
    }
    .nn-vcontrols .nn-vend:hover { filter: brightness(1.08); }
    /* the call is still up while the panel is minimised to watch the cursor */
    .nn-launcher-live { animation: nn-mic-pulse 1.9s ease-in-out infinite; }

    /* suggested-prompt starter chips */
    .nn-suggestions { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 12px 4px; background: transparent; }
    .nn-chip {
      border: 1px solid var(--nn-edge); background: rgba(255,255,255,.66); color: var(--nn-accent);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      border-radius: 16px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; line-height: 1.2; font-weight: 600;
      box-shadow: 0 3px 10px rgba(23,72,110,.10);
      transition: background .12s ease, color .12s ease, transform .12s ease;
    }
    .nn-chip:hover { background: var(--nn-sheen), var(--nn-accent); color: #fff; border-color: rgba(255,255,255,.45); transform: translateY(-1px); }

    /* thumbs-up/down feedback under an answer */
    .nn-feedback { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    .nn-fb-btn {
      border: 1px solid var(--nn-edge); background: rgba(255,255,255,.6); border-radius: 10px; padding: 2px 8px;
      font-size: 14px; cursor: pointer; line-height: 1.4;
      transition: border-color .12s ease, background .12s ease;
    }
    .nn-fb-btn:hover { border-color: rgba(122,183,225,.9); background: rgba(255,255,255,.9); }
    .nn-fb-thanks { font-size: 12px; color: var(--nn-ink-soft); font-style: italic; }

    /* read-aloud transport: 🔊 → spinner → ⏸ → ▶ all in one button, so a fixed
       width keeps the row from twitching as the glyph changes */
    .nn-fb-speak { min-width: 30px; text-align: center; padding: 2px 6px; }
    .nn-fb-loading, .nn-fb-playing, .nn-fb-paused {
      border-color: rgba(122,183,225,.9); background: rgba(232,245,254,.85); color: var(--nn-accent);
    }
    .nn-spin {
      display: inline-block; width: 11px; height: 11px; vertical-align: -1px;
      border: 2px solid rgba(122,183,225,.35); border-top-color: var(--nn-accent);
      border-radius: 50%; animation: nn-spin .6s linear infinite;
    }
    @keyframes nn-spin { to { transform: rotate(360deg); } }

    .nn-cursor {
      position: fixed; left: 0; top: 0; z-index: 2147483600; pointer-events: none;
      width: 74px; height: 44px; margin: -1px 0 0 -10px; opacity: 0;
      transition: transform .6s cubic-bezier(.22,.61,.36,1), opacity .2s ease;
    }
    .nn-cursor-active { opacity: 1; }
    /* two hand poses (hand + logo art from the source PNG) stacked in place —
       the fingertip lands at nearly the same spot in both crops, so a plain
       crossfade (no per-pose offset) is enough to avoid a visible jump */
    .nn-cursor-pose {
      position: absolute; top: 0; left: 0; width: 74px; height: 44px;
      image-rendering: pixelated; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35));
      transition: opacity .12s ease;
    }
    .nn-cursor-pose-click { opacity: 0; }
    .nn-cursor.nn-cursor-click .nn-cursor-pose-hover { opacity: 0; }
    .nn-cursor.nn-cursor-click .nn-cursor-pose-click { opacity: 1; }
    .nn-cursor-caption {
      position: absolute; left: 40px; top: 46px; width: max-content; max-width: 230px;
      padding: 7px 10px; border-radius: 9px; background: #151722; color: #fff;
      font-size: 12px; font-weight: 500; line-height: 1.35; letter-spacing: 0;
      box-shadow: 0 8px 22px rgba(23,72,110,.24); filter: none;
      opacity: 0; transform: translateY(-3px) scale(.96); transform-origin: top left;
      transition: opacity .16s ease, transform .16s ease;
    }
    .nn-cursor-caption::before {
      content: ""; position: absolute; left: 6px; top: -5px; width: 10px; height: 10px;
      background: rgba(246,251,255,.92); border-left: 1px solid var(--nn-edge); border-top: 1px solid var(--nn-edge);
      transform: rotate(45deg);
    }
    .nn-cursor-caption.nn-caption-visible { opacity: 1; transform: none; }
    .nn-cursor-left .nn-cursor-caption { left: auto; right: 26px; transform-origin: top right; }
    .nn-cursor-left .nn-cursor-caption::before { left: auto; right: 5px; }
    .nn-cursor-above .nn-cursor-caption { top: auto; bottom: 49px; transform-origin: bottom left; }
    .nn-cursor-above.nn-cursor-left .nn-cursor-caption { transform-origin: bottom right; }
    .nn-cursor-above .nn-cursor-caption::before { top: auto; bottom: -5px; }

    .nn-ring {
      position: fixed; z-index: 2147483500; pointer-events: none; border-radius: 10px;
      border: 2px solid rgba(255,255,255,.9);
      box-shadow: 0 0 0 3px rgba(122,183,225,.45), 0 0 22px rgba(122,183,225,.7);
      animation: nn-ring .5s ease; transition: all .2s ease;
    }
    @keyframes nn-ring { from { transform: scale(1.15); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    `;
  }
})();
