// NaviNate — Voice layer (ElevenLabs Agents Platform)
// ---------------------------------------------------
// Gives the cursor-driving agent a mouth AND an ear.
//
// The split of labour is deliberate:
//   • ElevenLabs Agent  = the CONVERSATION. Speech-in, speech-out, turn taking,
//     barge-in, clarifying questions, personality/emotion.
//   • NaviNate (/chat)  = the HANDS. It reads the live DOM and drives the fake
//     cursor: click, type, select, drag sliders, navigate.
//
// They're joined by ElevenLabs **client tools**: the voice agent doesn't have a
// DOM, so when the visitor says "put the cheapest EU server in my cart" it calls
// `navigate_site({goal})` and the widget hands that goal to the existing GPT-4o
// loop, which actually does it on screen. The voice agent narrates while it happens.
//
// This module owns everything that needs the API key, so the key never reaches
// the browser:
//   GET  /voice/session   -> a short-lived signed wss:// URL + runtime overrides
//   POST /voice/provision -> create/refresh a per-client agent from Base44 config
//   POST /voice/speak     -> low-latency TTS proxy (narration / fallback mode)
//   GET  /voice/status    -> is voice configured at all?

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = "https://api.elevenlabs.io/v1";
const KEY = () => process.env.ELEVENLABS_API_KEY || "";

// A shared agent can be pinned in .env; otherwise we provision one per client.
const SHARED_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";
// Voice is resolved from the account at runtime — see resolveDefaultVoice(). A
// hardcoded id is a trap: most well-known voice ids (Rachel and friends) live in
// the shared Voice Library, which free plans are blocked from using via the API
// ("Free users cannot use library voices", HTTP 402).
const PINNED_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
// Preference order when we pick for the user. All are stock voices that ship
// with every account; the first one actually present wins.
const PREFERRED_VOICES = ["Sarah", "Jessica", "Bella", "Alice", "Matilda", "George", "Brian"];
// Flash is the lowest-latency TTS model — the difference between "assistant" and
// "conversation" is almost entirely time-to-first-audio.
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const AGENT_LLM = process.env.ELEVENLABS_AGENT_LLM || "gpt-4o-mini";
const LANGUAGE = process.env.ELEVENLABS_LANGUAGE || "en";

// The `_v2_5` models are the multilingual ones. An agent pinned to English is
// only allowed the English-only variants, and rejects anything else with
// "English Agents must use turbo or flash v2" — so drop the _5 when the agent is
// locked to "en". One-shot TTS (/voice/speak) has no such restriction and keeps
// whatever model was configured.
function agentTtsModel(language) {
  if (language !== "en") return TTS_MODEL;
  return TTS_MODEL.replace(/_v2_5$/, "_v2");
}

export const voiceConfigured = () => Boolean(KEY());

async function el(pathname, { method = "GET", body, timeoutMs = 20000 } = {}) {
  if (!KEY()) throw new Error("ELEVENLABS_API_KEY is not set");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API + pathname, {
      method,
      headers: {
        "xi-api-key": KEY(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ElevenLabs ${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Pick a voice this account is actually allowed to use. Free plans can only use
// voices attached to the account (the stock "premade" set), not Voice Library
// ones, so we ask rather than assume. Resolved once and cached.
// ---------------------------------------------------------------------------
let defaultVoicePromise = null;
async function resolveDefaultVoice() {
  if (PINNED_VOICE_ID) return PINNED_VOICE_ID;
  if (!defaultVoicePromise) {
    defaultVoicePromise = (async () => {
      const list = await el("/voices");
      const voices = list.voices || [];
      if (!voices.length) throw new Error("this ElevenLabs account has no voices available");
      const byName = (name) =>
        voices.find((v) => String(v.name || "").toLowerCase().startsWith(name.toLowerCase()));
      const pick =
        PREFERRED_VOICES.map(byName).find(Boolean) ||
        voices.find((v) => v.category === "premade") ||
        voices[0];
      console.log(`🎙  using ElevenLabs voice "${pick.name}" (${pick.voice_id})`);
      return pick.voice_id;
    })().catch((err) => {
      defaultVoicePromise = null; // let a later request retry
      throw err;
    });
  }
  return defaultVoicePromise;
}

// ---------------------------------------------------------------------------
// The client tools. These are the voice agent's only way to affect the page —
// each one is executed by widget.js in the visitor's browser.
// ---------------------------------------------------------------------------
const CLIENT_TOOLS = [
  {
    type: "client",
    name: "navigate_site",
    description:
      "Actually operate the website for the visitor: click buttons, fill in fields, apply filters, " +
      "move sliders, add things to the cart, or jump to another page. Pass the goal in plain English " +
      "exactly as the visitor expressed it (e.g. \"filter to hybrid servers in the EU and add the cheapest to the cart\"). " +
      "A visible cursor moves across their screen and performs the steps, then this returns a summary of what happened. " +
      "Use this whenever the visitor wants something DONE rather than explained. " +
      "Say ONE short sentence out loud about what you're doing BEFORE you call it, so they're not left in silence, " +
      "and report the outcome in ONE short sentence afterwards — never read the returned summary back verbatim.",
    expects_response: true,
    response_timeout_secs: 100,
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "The single concrete outcome to achieve on the page, in plain English. One goal per call — " +
            "don't batch unrelated tasks.",
        },
      },
      required: ["goal"],
    },
  },
  {
    type: "client",
    name: "read_page",
    description:
      "Look at what is currently on the visitor's screen — headings, product names, prices, options, " +
      "error messages — without touching anything. Use this to answer questions about what they're " +
      "looking at, to compare prices, or to check whether something worked, instead of guessing.",
    expects_response: true,
    response_timeout_secs: 15,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Optional — what you're trying to find out, so the most relevant part of the page comes back first.",
        },
      },
      required: [],
    },
  },
  {
    type: "client",
    name: "undo_last_action",
    description:
      "Reverse the last thing you did on the page — restores the previous page, scroll position, field " +
      "values and selections. Use it the moment the visitor says \"no\", \"wrong one\", \"go back\" or \"undo\".",
    expects_response: true,
    response_timeout_secs: 20,
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Persona. This is the prompt engineering that makes the agent feel like a
// person sitting next to you driving your screen, rather than a search box.
// ---------------------------------------------------------------------------
export function buildVoicePrompt(config) {
  const suggestive = String(config.aggressiveness || "").toLowerCase().includes("suggest");
  return `You are ${config.botName}, the voice of this website. A visitor is on the site right now and can hear you. You are not a search box and not a phone menu — you are a competent person sitting beside them who can reach over and use their screen.

WHAT MAKES YOU DIFFERENT
You have hands. Through the navigate_site tool a real cursor moves across the visitor's screen and clicks, types, filters and navigates for them. They can watch it happen. Most people have never had a website do this, so be matter-of-fact and reassuring about it: "Sure — watch the top of the page, I'm filtering these now."

THE BUSINESS YOU WORK FOR
${config.systemPrompt}

HOW TO TALK — BREVITY IS THE WHOLE GAME
Every word you say costs the visitor time they can't skip. Reading is fast; listening is slow. So:
- Default to ONE sentence. Two is a lot. Three means you've made a mistake.
- Hard cap: about 30 words per turn unless they explicitly ask you to explain, compare, or list.
- Confirmations are four words, not a paragraph: "Done, it's in your cart." Not "I've gone ahead and added the item you selected to your shopping cart for you."
- No preamble ("Sure, I'd be happy to help with that!"), no recap of what they just said, no offering three follow-ups. Answer, then stop.
- Never read a list of more than three things aloud. Give the shape, then offer: "Six plans, forty up to three hundred. Want the cheapest?"
- Ending every turn with "let me know if you need anything else" is padding. Just stop talking — they know you're there.
- Silence is fine. If there's nothing useful to add, say nothing.

Spoken language, not written: contractions, no markdown, no bullet points, no emoji, never read a URL aloud. Say numbers as a person would ("ninety-nine a month", not "$99/mo"). Match their energy — if they sound rushed, skip straight to doing it. One question at a time, and only when you truly can't proceed; a confident guess you can undo beats an interrogation.

USING YOUR HANDS
- Announce, then act. ONE short sentence before every navigate_site call — silence while the cursor moves feels broken, but a speech before it is worse. "One sec, filtering these now."
- Then report the result in one sentence: "Done, it's in your cart." / "That filter left nothing, so I widened it to all of Europe." Don't re-describe what they can see happening on their own screen.
- read_page before you claim anything about what's on screen. Never invent a price, a plan name or a button.
- If they push back at all — "no", "not that one", "go back" — call undo_last_action first and apologise in four words, then fix it.
${
  suggestive
    ? "- CAUTION MODE: this business wants you to guide rather than take over. Point things out and explain them; only do low-stakes navigation yourself. Never complete a purchase or submit a form without an explicit yes."
    : "- You may act on the visitor's behalf freely. The one exception: for the final irreversible step — placing an order, submitting payment — get a clear spoken yes first."
}

EMOTION
Speak with real inflection, not a customer-service monotone. Use audio tags sparingly and only where a person would actually shift: [warmly] when greeting or reassuring, [thoughtfully] while you work, [laughs] if they joke, [apologetic] when something went wrong. One tag per reply at most; no tags at all is usually right.

WHEN YOU'RE STUCK
Say so plainly and offer the nearest real alternative you can see on the page. Never loop, never repeat a step that already worked, and never pretend something happened that didn't. If the site genuinely can't do it, tell them that and point them at support.`;
}

// ---------------------------------------------------------------------------
// Provisioning: turn a Base44 client config into a live ElevenLabs agent.
// Cached in voice-agents.json so a restart doesn't create duplicate agents; the
// fingerprint means editing the persona in Base44 patches the existing agent
// instead of orphaning it.
// ---------------------------------------------------------------------------
const REGISTRY = path.join(__dirname, "voice-agents.json");

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return {};
  }
}
function writeRegistry(reg) {
  try {
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  } catch (err) {
    console.warn("could not persist voice-agents.json:", err.message);
  }
}

// Everything that affects the deployed agent has to be in here, or a cached
// agent silently keeps serving the old configuration forever. Hash the FULL
// built prompt rather than listing the inputs to it: that way editing the
// persona template in this file re-provisions on the next session, which
// listing config fields alone did not do.
function fingerprint(config, voiceId) {
  const material = JSON.stringify([
    buildVoicePrompt(config),
    config.welcomeMessage,
    voiceId,
    // Voice/language settings live in env, so a change there has to re-provision
    // too — otherwise the cached agent keeps the old model forever.
    LANGUAGE,
    agentTtsModel(LANGUAGE),
    AGENT_LLM,
    CLIENT_TOOLS.map((t) => `${t.name}:${t.description}`).join("|"),
  ]);
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

// Client tools are shared across every provisioned agent, so create them once
// and reuse the ids. Newer accounts use the standalone /convai/tools registry;
// older ones only accept tools inlined on the agent, so we fall back to that.
let toolIdsPromise = null;
async function ensureToolIds() {
  if (!toolIdsPromise) {
    toolIdsPromise = (async () => {
      const existing = new Map();
      try {
        const list = await el("/convai/tools");
        for (const t of list.tools || []) {
          if (t?.tool_config?.name) existing.set(t.tool_config.name, t.id);
        }
      } catch (err) {
        console.warn("voice: could not list tools, will inline them —", err.message);
        return null; // signal "inline mode"
      }
      const ids = [];
      for (const tool of CLIENT_TOOLS) {
        if (existing.has(tool.name)) {
          ids.push(existing.get(tool.name));
          continue;
        }
        const created = await el("/convai/tools", { method: "POST", body: { tool_config: tool } });
        ids.push(created.id);
      }
      return ids;
    })().catch((err) => {
      toolIdsPromise = null; // let a later request retry
      throw err;
    });
  }
  return toolIdsPromise;
}

function agentBody(config, toolIds, voiceId) {
  const prompt = {
    prompt: buildVoicePrompt(config),
    llm: AGENT_LLM,
    temperature: 0.4,
  };
  if (toolIds) prompt.tool_ids = toolIds;
  else prompt.tools = CLIENT_TOOLS;

  return {
    name: `NaviNate — ${config.botName}`,
    conversation_config: {
      agent: {
        prompt,
        first_message: config.welcomeMessage,
        language: LANGUAGE,
      },
      tts: {
        voice_id: voiceId,
        model_id: agentTtsModel(LANGUAGE),
        stability: 0.4, // lower = more expressive delivery
        similarity_boost: 0.75,
        speed: 1.0,
      },
      turn: {
        // Short timeout: a navigation assistant should jump in quickly rather
        // than leave the visitor watching a cursor in silence.
        turn_timeout: 7,
      },
      conversation: {
        max_duration_seconds: 900,
      },
    },
    platform_settings: {
      // The agent is provisioned once but serves every page load, so the widget
      // re-sends the live persona (and the page it's standing on) per session.
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: true },
        },
      },
    },
  };
}

// Returns the agent id to connect to for this client, creating or patching the
// ElevenLabs agent as needed. A pinned ELEVENLABS_AGENT_ID short-circuits it.
export async function ensureAgent(clientId, config) {
  if (SHARED_AGENT_ID) return SHARED_AGENT_ID;

  const key = clientId || "_default";
  const reg = readRegistry();
  const entry = reg[key];
  const voiceId = config.voiceId || (await resolveDefaultVoice());
  const fp = fingerprint(config, voiceId);
  if (entry?.agentId && entry.fingerprint === fp) return entry.agentId;

  const toolIds = await ensureToolIds();
  const body = agentBody(config, toolIds, voiceId);

  let agentId = entry?.agentId;
  if (agentId) {
    try {
      await el(`/convai/agents/${agentId}`, { method: "PATCH", body });
    } catch (err) {
      console.warn(`voice: patching agent ${agentId} failed, creating a new one —`, err.message);
      agentId = null;
    }
  }
  if (!agentId) {
    const created = await el("/convai/agents/create", { method: "POST", body });
    agentId = created.agent_id || created.id;
    if (!agentId) throw new Error("ElevenLabs did not return an agent_id");
    console.log(`🎙  provisioned voice agent for "${key}": ${agentId}`);
  }

  reg[key] = { agentId, fingerprint: fp, updatedAt: new Date().toISOString() };
  writeRegistry(reg);
  return agentId;
}

// Short-lived wss:// URL. Expires in ~15 minutes and carries no API key, so it's
// safe to hand to a browser on somebody else's domain.
export async function signedUrl(agentId) {
  const out = await el(`/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
  if (!out.signed_url) throw new Error("ElevenLabs did not return a signed_url");
  return out.signed_url;
}

// Low-latency one-shot TTS. Used for narration mode — speaking the text agent's
// replies and cursor captions when there's no live conversation (mic denied,
// no agent configured, or the visitor just wants to be read to).
export async function speak({ text, voiceId, format = "mp3_44100_128" }) {
  if (!KEY()) throw new Error("ELEVENLABS_API_KEY is not set");
  const voice = voiceId || (await resolveDefaultVoice());
  const res = await fetch(
    `${API}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${encodeURIComponent(format)}`,
    {
      method: "POST",
      headers: { "xi-api-key": KEY(), "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: TTS_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.75, use_speaker_boost: true },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.body; // a web ReadableStream — pipe it straight to the client
}

export { resolveDefaultVoice };

export const voiceDefaults = {
  pinnedVoiceId: PINNED_VOICE_ID || null,
  ttsModel: TTS_MODEL,
  agentTtsModel: agentTtsModel(LANGUAGE),
  language: LANGUAGE,
  agentLlm: AGENT_LLM,
};
