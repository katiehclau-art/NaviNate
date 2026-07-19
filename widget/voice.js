/* NaviNate — Voice client (ElevenLabs Agents Platform)
 * ----------------------------------------------------
 * Loaded on demand by widget.js the first time a visitor taps the mic.
 *
 * It opens a WebSocket straight to ElevenLabs (using a signed URL our backend
 * minted, so the API key never touches the browser) and runs a full duplex
 * conversation:
 *
 *     mic ──16-bit PCM──▶ ElevenLabs Agent ──PCM──▶ speakers
 *                              │
 *                              ├─ navigate_site(goal) ─▶ NaviNate's cursor agent
 *                              ├─ read_page(question)  ─▶ live DOM snapshot
 *                              └─ undo_last_action()   ─▶ NaviNate's undo stack
 *
 * The two things that make this feel alive rather than like a phone tree:
 *   • Barge-in — the moment ElevenLabs detects the visitor speaking over the
 *     agent we kill every queued audio buffer, so talking over it works.
 *   • Continuity — the socket dies when the agent navigates the page, so we
 *     stash the thread of the conversation in sessionStorage and reconnect on
 *     the next page with a context handoff. To the visitor it's one conversation
 *     that happens to walk across five pages.
 *
 * Exposes window.NaviNateVoice.create(host) -> controller.
 */
(function () {
  "use strict";
  if (window.NaviNateVoice) return;

  const SS = window.sessionStorage;
  const ACTIVE_KEY = "navinate.voice.active";
  const HANDOFF_KEY = "navinate.voice.handoff";

  // How much audio we batch before sending. ~128ms is the sweet spot: small
  // enough that turn detection stays snappy, big enough to not spam the socket.
  const CHUNK_MS = 128;

  const b64 = {
    encode(bytes) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(s);
    },
    decode(str) {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
  };

  // "pcm_16000" -> 16000. Anything unrecognised falls back to 16k, the default.
  function rateOf(format) {
    const m = /_(\d+)$/.exec(String(format || ""));
    return m ? parseInt(m[1], 10) : 16000;
  }

  // μ-law is only used on telephony agents, but decoding it is eight lines and
  // saves a baffling "why is it static" bug if someone configures it.
  function ulawToPcm(bytes) {
    const out = new Int16Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const u = ~bytes[i];
      const mantissa = ((u & 0x0f) << 3) + 0x84;
      let sample = (mantissa << ((u & 0x70) >> 4)) - 0x84;
      out[i] = u & 0x80 ? -sample : sample;
    }
    return out;
  }

  // Runs off the main thread on purpose: the NaviNate agent is busy mutating the
  // DOM while the visitor is talking, and a main-thread ScriptProcessor would
  // drop mic frames every time the page re-layouts.
  const WORKLET_SRC = `
    class NNCapture extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
        return true;
      }
    }
    registerProcessor('nn-capture', NNCapture);
  `;

  function create(host) {
    const state = {
      ws: null,
      status: "idle", // idle | connecting | listening | speaking | working | error
      micStream: null,
      micCtx: null,
      micNode: null,
      playCtx: null,
      playGain: null,
      playHead: 0,
      sources: new Set(),
      outRate: 16000,
      inRate: 16000,
      lastAudioAt: 0, // when the last audio chunk arrived (see waitUntilQuiet)
      outbox: [], // messages queued while the socket was still connecting
      retries: 0, // consecutive unexpected disconnects
      navigatingAway: false, // this document is on its way out; the close is expected
      micLevel: 0, // smoothed 0..1 input loudness, for the visualiser
      analyser: null,
      pending: [], // Float32 mic samples awaiting a full chunk
      transcript: [], // recent turns, for the cross-page handoff
      closing: false,
      muted: false,
    };

    function setStatus(next) {
      if (state.status === next) return;
      state.status = next;
      host.onStatus && host.onStatus(next);
    }

    // ---- playback --------------------------------------------------------
    function ensurePlayback() {
      if (state.playCtx) return state.playCtx;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.playCtx = new Ctx();
      state.playGain = state.playCtx.createGain();
      state.playGain.connect(state.playCtx.destination);
      // A tap on the output purely so the UI can visualise what's being spoken.
      // Reading it here (rather than off the PCM chunks) keeps the animation in
      // step with what the speakers are actually playing, not with what arrived.
      state.analyser = state.playCtx.createAnalyser();
      state.analyser.fftSize = 256;
      state.analyser.smoothingTimeConstant = 0.75;
      state.analyserBuf = new Uint8Array(state.analyser.frequencyBinCount);
      state.playGain.connect(state.analyser); // a branch; not routed onward
      return state.playCtx;
    }

    // Current loudness of each side, 0..1, for the voice-mode visualiser.
    // `out` is the agent's voice, `in` is the visitor's.
    function levels() {
      let out = 0;
      if (state.analyser && state.sources.size) {
        state.analyser.getByteTimeDomainData(state.analyserBuf);
        let peak = 0;
        for (let i = 0; i < state.analyserBuf.length; i++) {
          peak = Math.max(peak, Math.abs(state.analyserBuf[i] - 128) / 128);
        }
        out = Math.min(1, peak * 1.6);
      }
      return { out, in: state.muted ? 0 : state.micLevel };
    }

    function enqueueAudio(pcm, rate) {
      const ctx = ensurePlayback();
      if (ctx.state === "suspended") ctx.resume();
      const buf = ctx.createBuffer(1, pcm.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(state.playGain);
      // Keep a small lead so consecutive chunks butt up against each other
      // seamlessly instead of clicking.
      const now = ctx.currentTime;
      if (state.playHead < now + 0.04) state.playHead = now + 0.04;
      src.start(state.playHead);
      state.playHead += buf.duration;
      state.sources.add(src);
      src.onended = () => {
        state.sources.delete(src);
        if (!state.sources.size && state.status === "speaking") setStatus("listening");
      };
      setStatus("speaking");
    }

    // Barge-in. Everything already scheduled has to die *now* — if we let the
    // queue drain the agent keeps talking over the visitor for a second or two,
    // which is the single most unnatural thing a voice agent can do.
    function stopPlayback() {
      for (const src of state.sources) {
        try { src.stop(); } catch (_) { /* already finished */ }
      }
      state.sources.clear();
      state.playHead = 0;
      if (state.status === "speaking") setStatus("listening");
    }

    // ---- microphone ------------------------------------------------------
    async function startMic() {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The agent's own voice is coming out of the same speakers the mic can
          // hear. Without these the agent interrupts itself constantly.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.micCtx = new Ctx();
      const source = state.micCtx.createMediaStreamSource(state.micStream);

      const onSamples = (samples) => {
        // Track loudness before the send guard so the orb still reflects the room
        // even in the gaps where we aren't transmitting.
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        // Smooth upward fast, downward slow, or the visual flickers on every
        // consonant. Scaled up because speech RMS sits low in the 0..1 range.
        const scaled = Math.min(1, rms * 7);
        state.micLevel = scaled > state.micLevel ? scaled : state.micLevel * 0.82 + scaled * 0.18;

        if (state.muted || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        state.pending.push(samples);
        const needed = Math.round((state.micCtx.sampleRate * CHUNK_MS) / 1000);
        let have = state.pending.reduce((n, a) => n + a.length, 0);
        while (have >= needed) {
          const merged = new Float32Array(needed);
          let filled = 0;
          while (filled < needed) {
            const head = state.pending[0];
            const take = Math.min(head.length, needed - filled);
            merged.set(head.subarray(0, take), filled);
            filled += take;
            if (take === head.length) state.pending.shift();
            else state.pending[0] = head.subarray(take);
          }
          have -= needed;
          send({ user_audio_chunk: b64.encode(toPcm16(merged, state.micCtx.sampleRate, state.inRate)) });
        }
      };

      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
        await state.micCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        state.micNode = new AudioWorkletNode(state.micCtx, "nn-capture");
        state.micNode.port.onmessage = (e) => onSamples(e.data);
        source.connect(state.micNode);
        // Worklets need a path to the destination to be pulled; a muted gain node
        // keeps it running without echoing the mic back through the speakers.
        const mute = state.micCtx.createGain();
        mute.gain.value = 0;
        state.micNode.connect(mute).connect(state.micCtx.destination);
      } catch (err) {
        // Blob workers are blocked by some strict client CSPs — fall back to the
        // deprecated (but universally allowed) main-thread processor.
        console.warn("[NaviNate] AudioWorklet unavailable, falling back:", err.message);
        state.micNode = state.micCtx.createScriptProcessor(2048, 1, 1);
        state.micNode.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
        source.connect(state.micNode);
        state.micNode.connect(state.micCtx.destination);
      }
    }

    // Linear-interpolation resample + float→int16. ElevenLabs wants a fixed rate;
    // the browser gives us whatever the device runs at (usually 44.1k or 48k).
    function toPcm16(samples, fromRate, toRate) {
      let src = samples;
      if (fromRate !== toRate) {
        const ratio = fromRate / toRate;
        const len = Math.floor(samples.length / ratio);
        src = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const a = samples[idx] || 0;
          const b = idx + 1 < samples.length ? samples[idx + 1] : a;
          src[i] = a + (b - a) * frac;
        }
      }
      const out = new Int16Array(src.length);
      for (let i = 0; i < src.length; i++) {
        const s = Math.max(-1, Math.min(1, src[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return new Uint8Array(out.buffer);
    }

    function stopMic() {
      try { state.micNode && state.micNode.disconnect(); } catch (_) {}
      try { state.micCtx && state.micCtx.close(); } catch (_) {}
      if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
      state.micNode = state.micCtx = state.micStream = null;
      state.pending = [];
    }

    // ---- socket ----------------------------------------------------------
    // Anything sent before the socket finishes opening used to vanish. That
    // window is exactly when a resumed session has the most to say (the page
    // context, the result of the goal that caused the navigation), so queue
    // instead of dropping and flush once we're connected.
    function send(obj) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(obj));
      } else if (state.ws) {
        state.outbox.push(obj);
        if (state.outbox.length > 24) state.outbox.shift();
      }
    }

    function flushOutbox() {
      const queued = state.outbox.splice(0);
      for (const obj of queued) send(obj);
    }

    // Push what's on screen into the conversation without taking a turn. Called
    // on connect and after every navigation, so the agent always knows where the
    // visitor actually is — this is what stops it answering about the old page.
    function sendContext(text, contextId) {
      if (!text) return;
      send({ type: "contextual_update", text: String(text).slice(0, 4000), context_id: contextId });
    }

    function remember(role, text) {
      if (!text) return;
      state.transcript.push(`${role}: ${text}`);
      if (state.transcript.length > 8) state.transcript.shift();
    }

    async function connect({ resumed = false } = {}) {
      setStatus("connecting");
      const res = await fetch(
        host.BACKEND + "/voice/session?clientId=" + encodeURIComponent(host.CLIENT_ID)
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not start a voice session (${res.status})`);
      }
      const session = await res.json();

      // Mic first: if the visitor denies permission we bail out before opening a
      // socket we'd only have to tear down again.
      await startMic();
      ensurePlayback();

      const handoff = resumed ? readHandoff() : null;
      const ws = new WebSocket(session.signedUrl);
      state.ws = ws;
      state.closing = false;

      ws.onopen = () => {
        const override = { agent: {} };
        // On a resume the visitor is mid-conversation and has just watched the
        // page change — re-greeting them ("Hi! I'm...") would be jarring, so we
        // blank the first message and let the context handoff carry the thread.
        if (resumed) override.agent.first_message = "";
        send({
          type: "conversation_initiation_client_data",
          conversation_config_override: override,
          dynamic_variables: {
            page_url: location.href,
            page_title: document.title,
            client_id: host.CLIENT_ID,
          },
        });
        sendContext(pageContext(resumed ? "The page just changed while we were talking." : ""), "page");
        if (handoff) sendContext(handoff, "handoff");
        flushOutbox();
        state.retries = 0;
        SS.setItem(ACTIVE_KEY, "1");
        setStatus("listening");
        host.track && host.track(resumed ? "voice_resumed" : "voice_started");
      };

      ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        handleEvent(msg);
      };

      ws.onerror = (err) => {
        console.warn("[NaviNate] voice socket error", err);
      };

      ws.onclose = (evt) => {
        stopMic();
        state.ws = null;
        if (state.closing) return; // we closed it on purpose
        // The document is unloading; the next page resumes from ACTIVE_KEY, so
        // leave every flag exactly as it is.
        if (state.navigatingAway) return;
        // 1000/1005 are normal closes (the agent ended the call, or the server
        // hung up cleanly). Anything else is a drop we should recover from —
        // previously this just went quiet, which looked exactly like the agent
        // deciding to stop talking.
        console.warn(`[NaviNate] voice socket closed (code ${evt.code}) ${evt.reason || ""}`);
        const clean = evt.code === 1000 || evt.code === 1005;
        if (!clean && state.retries < 2) {
          state.retries++;
          armHandoff(); // carry the thread into the new socket
          setStatus("connecting");
          setTimeout(() => {
            start({ resumed: true }).catch(() => {
              SS.removeItem(ACTIVE_KEY);
              setStatus("idle");
              host.onError && host.onError("The voice connection dropped and I couldn't get it back. You can still type to me.");
              host.onEnded && host.onEnded();
            });
          }, 600 * state.retries);
          return;
        }
        setStatus("idle");
        SS.removeItem(ACTIVE_KEY);
        if (!clean) {
          host.onError && host.onError("The voice connection dropped. Tap the mic to start again, or just type.");
        }
        host.onEnded && host.onEnded();
      };
    }

    function handleEvent(msg) {
      switch (msg.type) {
        case "conversation_initiation_metadata": {
          const meta = msg.conversation_initiation_metadata_event || {};
          state.outRate = rateOf(meta.agent_output_audio_format);
          state.inRate = rateOf(meta.user_input_audio_format);
          state.outUlaw = /ulaw/i.test(meta.agent_output_audio_format || "");
          break;
        }
        case "audio": {
          const raw = msg.audio_event && msg.audio_event.audio_base_64;
          if (!raw) break;
          state.lastAudioAt = Date.now();
          const bytes = b64.decode(raw);
          const pcm = state.outUlaw
            ? ulawToPcm(bytes)
            : new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
          enqueueAudio(pcm, state.outUlaw ? 8000 : state.outRate);
          break;
        }
        case "user_transcript": {
          const text = msg.user_transcription_event && msg.user_transcription_event.user_transcript;
          if (text) {
            remember("Visitor", text);
            host.onTranscript && host.onTranscript("user", text);
          }
          break;
        }
        case "agent_response": {
          const text = msg.agent_response_event && msg.agent_response_event.agent_response;
          if (text) {
            remember("You", text);
            host.onTranscript && host.onTranscript("assistant", text);
          }
          break;
        }
        case "interruption":
          stopPlayback();
          break;
        case "ping":
          send({ type: "pong", event_id: msg.ping_event && msg.ping_event.event_id });
          break;
        case "client_tool_call":
          runTool(msg.client_tool_call || {});
          break;
        default:
          // Surface anything unexpected (agent-side errors, quota messages)
          // rather than dropping it — a silent agent is otherwise unexplainable.
          if (/error|fail|quota|limit/i.test(msg.type || "")) {
            console.warn("[NaviNate] voice event:", msg.type, msg);
          }
          break;
      }
    }

    // ---- the tools the agent can actually reach ---------------------------
    async function runTool(call) {
      const { tool_name: name, tool_call_id: id, parameters: params = {} } = call;
      const reply = (result, isError) =>
        send({ type: "client_tool_result", tool_call_id: id, result: String(result).slice(0, 4000), is_error: !!isError });

      try {
        if (name === "navigate_site") {
          setStatus("working");
          // Hand the goal to the existing cursor agent. If it navigates, this
          // page is about to unload — we resolve with a short note and the
          // conversation picks up on the other side (see resume()).
          const outcome = await host.runGoal(String(params.goal || ""));
          if (outcome && outcome.navigated) {
            armHandoff();
            reply(
              `Started that — the cursor is moving and the site is loading the next page. ` +
                `Tell the visitor briefly what you're doing; you'll see the new page shortly.`
            );
          } else {
            // The summary is the page-driving agent's internal narration and can
            // run long; it's context, not a script. Trim it and say so, or the
            // voice agent reads the whole thing back at the visitor.
            const summary = (outcome && outcome.summary ? outcome.summary : "Done.").slice(0, 600);
            reply(`${summary}\n\n(Report this to the visitor in ONE short sentence. Do not read this text back.)`);
          }
          sendContext(pageContext(), "page");
          setStatus(state.sources.size ? "speaking" : "listening");
          return;
        }

        if (name === "read_page") {
          const page = host.readPage();
          reply(
            `Currently on "${page.title}" (${page.url}).\n` +
              (params.question ? `They asked: ${params.question}\n` : "") +
              `Visible content:\n${page.text}`
          );
          return;
        }

        if (name === "undo_last_action") {
          const note = await host.undo();
          reply(note || "There was nothing to undo.");
          return;
        }

        reply(`Unknown tool "${name}".`, true);
      } catch (err) {
        console.error("[NaviNate] voice tool failed:", err);
        reply(`That didn't work: ${String(err.message || err).slice(0, 200)}`, true);
        setStatus("listening");
      }
    }

    // A goal that spans a page load can never be answered through the tool call
    // that started it — that tool_call_id died with the old socket. Without this
    // the agent goes permanently silent after any navigation: contextual updates
    // give it knowledge but never a turn, so it just sits there knowing things.
    // A user_message does give it a turn, and since we only render `user_transcript`
    // events (real speech), this nudge never appears as a visitor bubble.
    function reportGoalResult(summary) {
      if (!summary) return;
      sendContext(pageContext(), "page");
      send({
        type: "user_message",
        text:
          "(System note — the visitor did not say this. The task you started before the page " +
          `changed has now finished: ${summary} Tell them the outcome in ONE short sentence, ` +
          "then stop and wait.)",
      });
    }

    // Resolves once the agent has stopped talking: no new audio arriving AND the
    // scheduled buffers have played out. Navigation destroys the socket and every
    // queued buffer with it, so without this the agent is guillotined mid-word
    // every single time it moves the visitor to another page.
    // Capped, because an agent that monologues shouldn't stall the click forever.
    function waitUntilQuiet(maxMs = 6000) {
      if (!state.ws) return Promise.resolve();
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          const ctx = state.playCtx;
          const draining = ctx && state.playHead > ctx.currentTime + 0.02;
          const quietFor = Date.now() - state.lastAudioAt;
          // 400ms of silence means the turn is genuinely over rather than just a
          // gap between two chunks of the same sentence.
          if ((!draining && quietFor > 400) || Date.now() - startedAt > maxMs) resolve();
          else setTimeout(tick, 100);
        };
        tick();
      });
    }

    // ---- page context + cross-navigation handoff -------------------------
    function pageContext(prefix) {
      const page = host.readPage();
      return (
        (prefix ? prefix + "\n" : "") +
        `The visitor is looking at "${page.title}" (${page.url}). ` +
        `What's on their screen right now:\n${page.text}`
      );
    }

    // Called right before the page unloads. Everything the next page's socket
    // needs to sound like the same conversation goes in sessionStorage.
    function armHandoff() {
      // Arming a handoff means "we are about to leave this page", so the socket
      // close that follows is expected. Without this the reconnect logic fires on
      // a dying document, fails, and clears the resume flag the NEXT page needs —
      // turning every navigation into a permanently silent agent.
      state.navigatingAway = true;
      try {
        SS.setItem(
          HANDOFF_KEY,
          "This is a continuation of a conversation already in progress — do not greet the visitor again. " +
            "The page changed, which may have cut you off mid-sentence; if you hadn't finished your last " +
            "thought, finish it briefly and naturally rather than starting over. " +
            "Here is what was said just before the page changed:\n" +
            state.transcript.join("\n")
        );
      } catch (_) { /* private mode; we just lose the handoff */ }
    }

    function readHandoff() {
      const v = SS.getItem(HANDOFF_KEY);
      SS.removeItem(HANDOFF_KEY);
      return v;
    }

    // Backstop for navigations nobody told us about (the visitor clicked a link,
    // a form submitted, a script redirected).
    window.addEventListener("pagehide", () => { state.navigatingAway = true; });

    // ---- public surface ---------------------------------------------------
    async function start(opts) {
      if (state.ws) return;
      try {
        await connect(opts || {});
      } catch (err) {
        setStatus("error");
        stopMic();
        state.ws = null;
        SS.removeItem(ACTIVE_KEY);
        throw err;
      }
    }

    function stop() {
      state.closing = true;
      SS.removeItem(ACTIVE_KEY);
      SS.removeItem(HANDOFF_KEY);
      stopPlayback();
      stopMic();
      if (state.ws) {
        try { state.ws.close(); } catch (_) {}
        state.ws = null;
      }
      setStatus("idle");
      host.track && host.track("voice_ended");
      host.onEnded && host.onEnded();
    }

    // Autoplay policy: a page load isn't a user gesture, so a resumed session
    // can't be assumed to have audio permission. It does in practice, because
    // the visitor granted mic access on the previous page and the tab is already
    // "playing" — but we resume the context defensively anyway.
    async function resume() {
      if (SS.getItem(ACTIVE_KEY) !== "1" || state.ws) return false;
      await start({ resumed: true });
      return true;
    }

    return {
      start,
      stop,
      resume,
      sendContext,
      armHandoff,
      waitUntilQuiet,
      reportGoalResult,
      isActive: () => Boolean(state.ws),
      wasActive: () => SS.getItem(ACTIVE_KEY) === "1",
      status: () => state.status,
      levels,
      isMuted: () => state.muted,
      mute: (on) => { state.muted = !!on; if (state.muted) state.micLevel = 0; },
      // The agent should hear about anything the visitor does themselves, too —
      // a click they made, a page they browsed to on their own.
      noteUserAction: (text) => sendContext(text, "user-action"),
    };
  }

  window.NaviNateVoice = { create };
})();
