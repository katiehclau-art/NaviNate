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
  const BACKEND = srcUrl.origin; // e.g. https://abc123.ngrok.app
  const CLIENT_ID = srcUrl.searchParams.get("clientId") || "demo";

  // ---- session state (survives page navigations the agent triggers) --------
  const SS = window.sessionStorage;
  // Reset the conversation on every page load. The ONE exception is a reload the
  // agent itself triggered mid-task (it sets navinate.continue right before it
  // navigates) — that state is preserved so it can finish the goal across pages.
  const isContinuation = SS.getItem("navinate.continue") === "1";
  if (!isContinuation) {
    ["history", "open", "autoSteps", "recentSigs", "continue"].forEach((k) =>
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
  };
  const MAX_AUTO_STEPS = 8; // safety cap on agent-driven steps per goal
  const RECENT_SIGS_MAX = 5; // how many past actions the loop guard remembers
  const MAX_REPEAT_STRIKES = 3; // how many "you already did that" nudges before giving up
  function persist() {
    SS.setItem("navinate.history", JSON.stringify(state.history.slice(-20)));
    SS.setItem("navinate.open", state.open ? "1" : "0");
    SS.setItem("navinate.autoSteps", String(state.autoSteps));
    SS.setItem("navinate.recentSigs", JSON.stringify(state.recentSigs));
  }

  let theme = { primaryColor: "#4f46e5", botName: "NaviNate Assistant" };

  // ---- tiny DOM helpers ----------------------------------------------------
  const el = (tag, props = {}, styles = {}) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    Object.assign(n.style, styles);
    return n;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- build the UI --------------------------------------------------------
  let root, panel, log, input, sendBtn, launcher, cursor, statusEl;

  function buildUI() {
    root = el("div", { id: "navinate-root" });
    const shadowHost = root; // keep it simple; scope styles by prefix instead
    document.body.appendChild(root);

    const style = el("style");
    style.textContent = css();
    root.appendChild(style);

    // Launcher bubble
    launcher = el("button", {
      className: "nn-launcher",
      title: "Ask " + theme.botName,
      innerHTML: "🧭",
    });
    launcher.onclick = toggle;
    root.appendChild(launcher);

    // Chat panel
    panel = el("div", { className: "nn-panel" });
    panel.innerHTML = `
      <div class="nn-header">
        <span class="nn-title">🧭 ${escapeHtml(theme.botName)}</span>
        <button class="nn-close" title="Close">×</button>
      </div>
      <div class="nn-log"></div>
      <div class="nn-status"></div>
      <div class="nn-inputbar">
        <input class="nn-input" type="text" placeholder="Ask me to find or do something…" />
        <button class="nn-send">➤</button>
      </div>`;
    root.appendChild(panel);

    log = panel.querySelector(".nn-log");
    input = panel.querySelector(".nn-input");
    sendBtn = panel.querySelector(".nn-send");
    statusEl = panel.querySelector(".nn-status");
    panel.querySelector(".nn-close").onclick = toggle;

    sendBtn.onclick = () => submit();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    // Fake cursor
    cursor = el("div", { className: "nn-cursor" });
    cursor.innerHTML = svgCursor();
    root.appendChild(cursor);

    // Apply theme accent
    root.style.setProperty("--nn-accent", theme.primaryColor);

    // Restore prior conversation + open state
    for (const m of state.history) addBubble(m.role, m.content, false);
    if (state.open) openPanel();
    else if (state.history.length === 0) {
      // First-ever load: greet.
      const greeting = "Hi! I can explore this site and click through it for you. What are you trying to do?";
      addBubble("assistant", greeting);
      state.history.push({ role: "assistant", content: greeting });
      persist();
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
  }
  function closePanel() {
    state.open = false;
    panel.classList.remove("nn-open");
    launcher.classList.remove("nn-hidden");
    persist();
  }

  // ---- chat rendering ------------------------------------------------------
  function addBubble(role, text, animate = true) {
    const b = el("div", { className: "nn-msg nn-" + role });
    b.textContent = text;
    if (!animate) b.style.animation = "none";
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  function setStatus(text) {
    statusEl.textContent = text || "";
    statusEl.style.display = text ? "block" : "none";
  }

  // ---- DOM scanning --------------------------------------------------------
  // Tag every interactive element with a stable data-agent-id and return a
  // compact JSON snapshot for the backend to reason over.
  const SELECTOR =
    'a[href], button, input:not([type=hidden]), select, textarea, ' +
    '[role=button], [role=link], [role=tab], [role=menuitem], [onclick]';

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
        type: node.getAttribute("type") || undefined,
        text: own,
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
      node.getAttribute("placeholder") ||
      node.value ||
      node.getAttribute("title") ||
      node.getAttribute("name") ||
      ""
    ).replace(/\s+/g, " ").trim();
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
    addBubble("user", text);
    state.history.push({ role: "user", content: text });
    state.autoSteps = 0; // new user goal resets the step budget
    state.recentSigs = []; // ...and the loop guard, so a fresh goal may repeat a prior action
    state.repeatStrikes = 0;
    persist();
    await runTurn(text);
  }

  // Drives the agent loop: ask the backend → perform the action → re-scan → repeat,
  // until the goal is done, the model stops acting, it repeats itself, or we hit the
  // step cap. Continues across page navigations via sessionStorage (see boot()).
  async function runTurn(userMessage) {
    if (busy) return;
    busy = true;
    let msg = userMessage;
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
        if (data.reply) addBubble("assistant", data.reply);

        // ONE deliberate step per turn: perform only the FIRST requested action,
        // then re-scan and let the model decide again. This is the real fix for
        // the "did it 4 times" bug — even if a response somehow carries several
        // tool calls, we never fire more than one per turn.
        const action = (data.actions || [])[0];

        if (!action) {
          if (data.reply) state.history.push({ role: "assistant", content: data.reply });
          persist();
          break; // model answered in text / finished — nothing to do
        }

        // Loop guard (preventive): signature keyed on the STABLE element id.
        // If we've already done this exact action, DON'T repeat it — instead nudge
        // the model to take the next step. Only give up after a few nudges.
        const sig = [action.action, action.target_id || "", action.value || "", action.url || ""].join("|");
        if (state.recentSigs.includes(sig)) {
          state.repeatStrikes++;
          if (data.reply) state.history.push({ role: "assistant", content: data.reply });
          state.history.push({
            role: "user",
            content:
              "(System: you already performed that exact step, so I did not repeat it — it's done. " +
              "Check the current pageText and pageElements (note any element with active:true is already selected) " +
              "and take the NEXT step toward the goal. If the goal is already achieved, or cannot be done on this " +
              "site, tell me that in plain text and do not call the tool.)",
          });
          persist();
          if (state.repeatStrikes >= MAX_REPEAT_STRIKES) {
            addBubble("assistant", "I seem to be stuck — could you rephrase or point me in the right direction?");
            break;
          }
          state.autoSteps++;
          persist();
          if (state.autoSteps >= MAX_AUTO_STEPS) {
            addBubble("assistant", "I've taken several steps — let me know if you'd like me to keep going.");
            break;
          }
          msg = ""; // let the model reconsider against the updated page
          await sleep(300);
          continue;
        }
        state.repeatStrikes = 0; // made real progress — reset the strike counter

        const r = await performAction(action);
        if (r.executed) {
          state.recentSigs.push(sig);
          if (state.recentSigs.length > RECENT_SIGS_MAX) state.recentSigs.shift();
          // Record what we did so the next turn's model remembers and won't redo it.
          state.history.push({
            role: "assistant",
            content: [data.reply, describeAction(action, r.label)].filter(Boolean).join("\n"),
          });
        } else if (data.reply) {
          state.history.push({ role: "assistant", content: data.reply });
        }
        persist();

        if (r.navigated) return; // page is reloading; boot() resumes the loop
        if (data.done) break; // model doesn't intend to act further

        state.autoSteps++;
        persist();
        if (state.autoSteps >= MAX_AUTO_STEPS) {
          addBubble("assistant", "I've taken several steps — let me know if you'd like me to keep going.");
          break;
        }

        msg = ""; // "" = continue toward the same goal against the updated page
        await sleep(450);
      }
      setStatus("");
    } catch (err) {
      console.error("[NaviNate]", err);
      addBubble("assistant", "Hmm, I couldn't reach my brain just now. Mind trying again?");
      setStatus("");
    } finally {
      busy = false;
    }
  }

  // Human-readable note of an action, stored in history as the model's memory.
  function describeAction(action, label) {
    const l = label ? ` "${label}"` : "";
    const why = action.reason ? ` (${action.reason})` : "";
    if (action.action === "type") return `Typed "${action.value || ""}" into${l || " the field"}.${why}`;
    if (action.action === "navigate") return `Navigated to ${label || action.url || "another page"}.${why}`;
    return `Did ${action.action}${l}.${why}`;
  }

  // ---- action execution ----------------------------------------------------
  // Returns { navigated, label, executed }:
  //   navigated — a page load was triggered (loop resumes after reload)
  //   label     — the acted element's visible text (for memory + the loop guard)
  //   executed  — false when the target element wasn't found (nothing happened)
  const skip = { navigated: false, label: "", executed: false };

  async function performAction(action) {
    const { action: type, target_id, value, url, reason } = action;
    if (reason) setStatus(reason);

    if (type === "navigate") {
      const node = target_id ? findByAgentId(target_id) : null;
      if (node) {
        const label = elementText(node);
        await moveCursorToNode(node);
        armContinuation();
        node.click();
        return { navigated: true, label, executed: true };
      }
      if (url) {
        armContinuation();
        window.location.href = new URL(url, window.location.href).href; // handles relative paths
        return { navigated: true, label: url, executed: true };
      }
      return skip;
    }

    const node = target_id ? findByAgentId(target_id) : null;
    if (!node) return skip; // element gone — model will get a fresh scan and can retry/ask
    const label = elementText(node);

    await moveCursorToNode(node);

    if (type === "click") {
      await flashClick(node);
      const before = window.location.href;
      armContinuation(); // a click may navigate (e.g. an <a>)
      realClick(node);
      await sleep(150);
      const navigated = window.location.href !== before;
      if (!navigated) disarmContinuation();
      return { navigated, label, executed: true };
    }

    if (type === "type") {
      node.focus();
      await typeInto(node, value || "");
      disarmContinuation();
      return { navigated: false, label, executed: true };
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

  // After a navigation, resume the agent loop on the next page load.
  function armContinuation() {
    SS.setItem("navinate.continue", "1");
    persist();
  }
  function disarmContinuation() {
    SS.removeItem("navinate.continue");
  }

  // ---- fake cursor + real interaction --------------------------------------
  function moveCursorToNode(node) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    return sleep(120).then(() => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      cursor.classList.add("nn-cursor-active");
      cursor.style.transform = `translate(${x}px, ${y}px)`;
      return sleep(650); // let the cursor glide
    });
  }

  async function flashClick(node) {
    cursor.classList.add("nn-cursor-click");
    pulseHighlight(node, 600);
    await sleep(180);
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
    let acc = "";
    for (const ch of text) {
      acc += ch;
      setter.call(node, acc);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(35);
    }
    node.dispatchEvent(new Event("change", { bubbles: true }));
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
    buildUI();
    // If the agent navigated us here mid-task, keep going automatically.
    if (state.pendingContinue) {
      disarmContinuation();
      openPanel();
      setStatus("Continuing…");
      await sleep(700); // let the new page settle
      if (state.autoSteps < MAX_AUTO_STEPS) {
        state.autoSteps++;
        persist();
        runTurn(""); // resume toward the same goal
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // ---- assets --------------------------------------------------------------
  function svgCursor() {
    return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M4 2l6 16 2.5-6.5L19 9 4 2z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function css() {
    return `
    #navinate-root { all: initial; }
    #navinate-root, #navinate-root * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    #navinate-root { --nn-accent: #4f46e5; }

    .nn-launcher {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      width: 60px; height: 60px; border-radius: 50%; border: none; cursor: pointer;
      background: var(--nn-accent); color: #fff; font-size: 26px; line-height: 1;
      box-shadow: 0 8px 24px rgba(0,0,0,.25); transition: transform .15s ease;
    }
    .nn-launcher:hover { transform: scale(1.06); }
    .nn-hidden { display: none !important; }

    .nn-panel {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      width: 380px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 44px);
      background: #fff; border-radius: 18px; overflow: hidden; display: none; flex-direction: column;
      box-shadow: 0 24px 60px rgba(0,0,0,.28); border: 1px solid rgba(0,0,0,.06);
    }
    .nn-panel.nn-open { display: flex; animation: nn-pop .18s ease; }
    @keyframes nn-pop { from { transform: translateY(12px) scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }

    .nn-header {
      background: var(--nn-accent); color: #fff; padding: 14px 16px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .nn-title { font-weight: 600; font-size: 15px; }
    .nn-close { background: transparent; border: none; color: #fff; font-size: 22px; cursor: pointer; line-height: 1; }

    .nn-log { flex: 1; overflow-y: auto; padding: 16px; background: #f7f7fb; display: flex; flex-direction: column; gap: 10px; }
    .nn-msg { max-width: 84%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; animation: nn-in .18s ease; }
    @keyframes nn-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .nn-user { align-self: flex-end; background: var(--nn-accent); color: #fff; border-bottom-right-radius: 4px; }
    .nn-assistant { align-self: flex-start; background: #fff; color: #1a1a1a; border: 1px solid #ececf2; border-bottom-left-radius: 4px; }

    .nn-status { padding: 6px 16px; font-size: 12.5px; color: #6b6b7b; background: #f7f7fb; display: none; font-style: italic; }

    .nn-inputbar { display: flex; gap: 8px; padding: 12px; background: #fff; border-top: 1px solid #eee; }
    .nn-input { flex: 1; border: 1px solid #dcdce6; border-radius: 12px; padding: 11px 13px; font-size: 14px; outline: none; }
    .nn-input:focus { border-color: var(--nn-accent); }
    .nn-send { border: none; background: var(--nn-accent); color: #fff; border-radius: 12px; width: 44px; font-size: 16px; cursor: pointer; }

    .nn-cursor {
      position: fixed; left: 0; top: 0; z-index: 2147483600; pointer-events: none;
      width: 26px; height: 26px; margin: -4px 0 0 -4px; opacity: 0;
      transition: transform .6s cubic-bezier(.22,.61,.36,1), opacity .2s ease;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.35));
    }
    .nn-cursor-active { opacity: 1; }
    .nn-cursor-click { animation: nn-tap .18s ease; }
    @keyframes nn-tap { 0% { transform-origin: 0 0; } 50% { filter: drop-shadow(0 0 0 rgba(0,0,0,0)) brightness(1.4); } }

    .nn-ring {
      position: fixed; z-index: 2147483500; pointer-events: none; border-radius: 8px;
      border: 3px solid var(--nn-accent); box-shadow: 0 0 0 4px rgba(79,70,229,.18);
      animation: nn-ring .5s ease; transition: all .2s ease;
    }
    @keyframes nn-ring { from { transform: scale(1.15); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    `;
  }
})();
