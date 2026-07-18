// NaviNate — Agent Backend
// -------------------------
// The "brain". Receives the user's message + a JSON snapshot of the clickable
// elements on their current page, asks the model what to do, and returns an ordered
// list of browser actions for widget.js to perform (move the cursor, click, type,
// scroll, navigate). Also pulls per-client config from the Base44 dashboard and
// pushes analytics back to it.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE44_URL = (process.env.BASE44_URL || "").replace(/\/$/, "");
const MODEL = process.env.MODEL || "gpt-4o";

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. Copy server/.env.example to server/.env first.");
}

const openai = new OpenAI(); // reads OPENAI_API_KEY from the environment

const app = express();
app.use(cors()); // the widget calls us from the client's (Base44) origin
app.use(express.json({ limit: "4mb" })); // DOM snapshots can be large

// ---------------------------------------------------------------------------
// Per-client config (the "control plane" lives in the Base44 dashboard).
// Cached briefly so we don't hammer Base44 on every keystroke.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  systemPrompt: "You are a friendly, proactive assistant that helps visitors accomplish their goals on this website.",
  primaryColor: "#4f46e5",
  botName: "NaviNate Assistant",
  aggressiveness: "autonomous", // "suggestive" | "autonomous" | "fully_autonomous"
  companyWebsiteUrl: "", // the client's site (used by the scraper to build their site map)
  welcomeMessage: "Hi! I can explore this site and click through it for you. What are you trying to do?",
  launcherIcon: "🧭", // emoji shown on the launcher bubble + header
  suggestedPrompts: [], // starter chips shown before the first message, e.g. ["Find an EU server"]
  widgetPosition: "bottom-right", // "bottom-right" | "bottom-left"
  maxAutoSteps: 8, // safety cap on autonomous steps per goal
  enabled: true, // master on/off switch for the widget on the client's site
};
const CONFIG_TTL_MS = 60 * 1000;
const configCache = new Map();

// Base44 returns the client's settings in snake_case, e.g.
//   { brand_color, system_prompt, aggressiveness, company_website_url,
//     welcome_message, launcher_icon, suggested_prompts, widget_position,
//     max_auto_steps, enabled }
// Map those onto our internal camelCase config. We also accept the camelCase
// names directly, so either shape works.
function mapClientConfig(raw) {
  if (!raw || typeof raw !== "object") return {};
  const pick = (...keys) => keys.map((k) => raw[k]).find((v) => v != null && v !== "");
  const out = {};

  const str = (v) => (v == null ? null : String(v));
  const set = (key, val) => { if (val != null) out[key] = val; };

  set("systemPrompt", str(pick("system_prompt", "systemPrompt")));
  set("primaryColor", str(pick("brand_color", "primaryColor")));
  set("aggressiveness", str(pick("aggressiveness")));
  set("companyWebsiteUrl", str(pick("company_website_url", "companyWebsiteUrl")));
  set("botName", str(pick("bot_name", "botName")));
  set("welcomeMessage", str(pick("welcome_message", "welcomeMessage")));
  set("launcherIcon", str(pick("launcher_icon", "launcherIcon")));
  set("widgetPosition", str(pick("widget_position", "widgetPosition")));

  // suggested_prompts: accept a real array, or a comma/newline-separated string.
  const prompts = pick("suggested_prompts", "suggestedPrompts");
  if (Array.isArray(prompts)) out.suggestedPrompts = prompts.map(String).filter(Boolean).slice(0, 6);
  else if (typeof prompts === "string") {
    out.suggestedPrompts = prompts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  }

  // max_auto_steps: a number, clamped to a sane range.
  const steps = pick("max_auto_steps", "maxAutoSteps");
  if (steps != null && !Number.isNaN(Number(steps))) {
    out.maxAutoSteps = Math.max(1, Math.min(20, Math.round(Number(steps))));
  }

  // enabled: accept boolean or "true"/"false"/"0"/"1".
  const enabled = pick("enabled", "is_enabled", "active");
  if (enabled != null) out.enabled = !(enabled === false || enabled === "false" || enabled === 0 || enabled === "0");

  return out;
}

async function getClientConfig(clientId) {
  const cached = configCache.get(clientId);
  if (cached && Date.now() - cached.t < CONFIG_TTL_MS) return cached.v;

  let config = { ...DEFAULT_CONFIG };
  if (BASE44_URL && clientId) {
    try {
      // Base44 serves deployed functions under /functions/<name>.
      const res = await fetch(`${BASE44_URL}/functions/config?clientId=${encodeURIComponent(clientId)}`);
      const body = await res.text();
      if (!res.ok) {
        console.warn(`config fetch for ${clientId} returned ${res.status}`);
      } else {
        try {
          config = { ...config, ...mapClientConfig(JSON.parse(body)) };
        } catch {
          console.warn(`config for ${clientId} was not JSON (check BASE44_URL): ${body.slice(0, 40)}…`);
        }
      }
    } catch (err) {
      console.warn("config fetch failed:", err.message);
    }
  }
  configCache.set(clientId, { t: Date.now(), v: config });
  return config;
}

// Fire-and-forget analytics back into the Base44 dashboard. The function lives at
// /functions/analytics and requires an "action" field in the payload.
function sendAnalytics(clientId, payload) {
  if (!BASE44_URL || !clientId) return;
  fetch(`${BASE44_URL}/functions/analytics?clientId=${encodeURIComponent(clientId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: payload.type || payload.event || "event", // required by the endpoint
      ...payload,
      ts: new Date().toISOString(),
    }),
  }).catch((err) => console.warn("analytics failed:", err.message));
}

// ---------------------------------------------------------------------------
// Optional site map produced by the scraper (scraper/scrape.js).
// Gives the agent a bird's-eye view so it can navigate to the right subpage.
// ---------------------------------------------------------------------------
// widget.js can be embedded on many different client sites, so each client has
// its OWN site map: scraper/sitemaps/<clientId>.json (built with
// `node scrape.js <that client's URL> --client <clientId>`). We load the map that
// matches the request's clientId, falling back to the shared sitemap.json (the
// local demo / single-tenant setups).
function loadSiteMap(clientId) {
  const scraperDir = path.join(__dirname, "..", "scraper");
  const safeId = String(clientId || "").replace(/[^a-zA-Z0-9_-]/g, ""); // no path traversal
  const candidates = [];
  if (safeId) candidates.push(path.join(scraperDir, "sitemaps", `${safeId}.json`));
  candidates.push(path.join(scraperDir, "sitemap.json"));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      console.warn(`could not load ${path.basename(p)}:`, err.message);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The single tool the model uses to drive the page (OpenAI function-calling schema).
// ---------------------------------------------------------------------------
const BROWSER_ACTION_TOOL = {
  type: "function",
  function: {
    name: "execute_browser_action",
    description:
      "Perform ONE action on the user's current web page on their behalf. " +
      "The page will update and you will be called again with the new page state, " +
      "so take a single deliberate step at a time rather than guessing several ahead.",
    parameters: {
      type: "object",
      properties: {
        action_type: {
          type: "string",
          enum: ["click", "type", "select", "scroll", "navigate", "highlight"],
          description:
            "click: click an element. type: type text into an input. select: choose an option in a native select dropdown. " +
            "scroll: bring an element into view. " +
            "navigate: go to a URL (use for jumping to a known subpage). " +
            "highlight: draw attention to an element and explain it WITHOUT clicking (use this instead of click " +
            "for irreversible/high-commitment actions like final checkout or submitting payment when you are not certain).",
        },
        target_id: {
          type: "string",
          description:
            "The data-agent-id of the element to act on (from the pageElements list). Required for click, type, select, scroll, highlight.",
        },
        value: {
          type: "string",
          description: "The text to type, or exact dropdown option label/value to select. Required for type or select.",
        },
        url: {
          type: "string",
          description: "Destination path or URL. Only for action_type=navigate.",
        },
        reason: {
          type: "string",
          description:
            "One short first-person sentence shown to the user describing what you're about to do, e.g. \"Opening the Laptops category for you.\"",
        },
      },
      required: ["action_type", "reason"],
    },
  },
};

function buildSystemPrompt(config, clientId) {
  const siteMap = loadSiteMap(clientId);
  const siteMapBlock = siteMap
    ? `\n\nKNOWN SITE MAP (url -> description) — use "navigate" to jump straight to the right page when the user's goal clearly lives elsewhere:\n${JSON.stringify(
        siteMap
      ).slice(0, 4000)}`
    : "";

  // Base44 sends values like "fully_autonomous" / "suggestive". Anything that
  // isn't a "suggest…" mode is treated as autonomous.
  const isSuggestive = String(config.aggressiveness || "").toLowerCase().includes("suggest");
  const aggression =
    isSuggestive
      ? "MODE: Suggestive. Prefer to guide the user — use \"highlight\" to point at the right element and explain it, and only \"click\" for clearly safe, low-stakes navigation. Never complete a purchase or submit a form without the user explicitly confirming."
      : "MODE: Autonomous. You may click, type, scroll, and navigate on the user's behalf to accomplish their goal. Still use \"highlight\" (not click) for the final irreversible step (placing an order, submitting payment) unless the user has clearly told you to complete it.";

  return `You are ${config.botName}, an agentic assistant embedded on a client's website. Your job is not just to chat — you actually operate the page for the visitor: clicking buttons, filling forms, scrolling, and navigating so they don't have to fight a confusing interface.

CLIENT INSTRUCTIONS (from the business that hired you):
${config.systemPrompt}

${aggression}

HOW YOU SEE THE PAGE:
Each user turn includes two things:
1. "pageText": the visible text of the whole page (headings, product names, PRICES, descriptions). READ this to gather information — e.g. to find the most expensive plan, compare the prices in pageText. Never click a "View details"/"More info" button just to see something you can already read here.
2. "pageElements": a JSON array of the interactive elements you can act on. Each has:
  - id: the value to pass as target_id
  - tag: html tag (a, button, input, select, ...)
  - type: input type when relevant
  - text: the element's own label (e.g. "Add to Cart")
  - value: the element's current value when relevant
  - options: for native select dropdowns, the available option labels and values
  - context: the text of the surrounding card/row — this usually contains the price and product name tied to THIS element. Use it to pick the right button (e.g. the "Add to Cart" whose context shows "$999/mo").
  - href: destination for links
  - active: true means this control (a filter, tab, or toggle) is ALREADY selected/applied. Do NOT click an active:true element again — it's done; move to the next step.
  - visible: whether it's currently in the viewport
You can only ACT on elements present in pageElements. If what you need isn't there, scroll or navigate to find it, or ask the user.

Worked example — "add the most expensive plan": read the prices from pageText/context, find the highest, then click the "Add to Cart" whose context matches that price. That's usually ONE click — no need to open any details page.

If the goal cannot be satisfied on this page (e.g. the user asks for a combination of filters that yields no results, or an item that doesn't exist here), don't keep clicking — say so plainly and suggest the closest available alternative you can see in pageText.

HOW TO ACT:
- To do something on the page, call the execute_browser_action tool. Use "select" with an exact option label or value for native select dropdowns.
- Take ONE step per turn. After the page updates you'll be called again with fresh pageElements.
- Always set a friendly "reason" — the user sees it as you work.
- If the user is just asking a question, answer in plain text and don't call the tool.
- Keep chat replies short and warm.

WHEN TO STOP (important — avoid loops):
- Your previous actions this session are recorded in the conversation as assistant notes. Read them before acting.
- Do NOT repeat an action you have already taken. If the page already reflects your intent (the filter is active, the item is in the cart, you're on the right tab), that step is DONE — move to the next step or finish.
- Once the user's goal is accomplished, STOP calling the tool and reply with a short plain-text confirmation. Do not keep acting.
- If the element you need is not in pageElements, or you're unsure the last action worked, ask the user in plain text instead of guessing or repeating.${siteMapBlock}`;
}

// Build a valid OpenAI messages array: a system turn, prior plain-text history, then
// the current user turn (message + live DOM snapshot). We deliberately keep history as
// plain text (no tool_call blocks) so every request is self-contained and valid — the
// live pageElements carry the state.
function buildMessages(config, history, userMessage, pageElements, pageText, clientId) {
  const messages = [{ role: "system", content: buildSystemPrompt(config, clientId) }];
  for (const m of Array.isArray(history) ? history.slice(-12) : []) {
    if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    messages.push({ role: m.role, content: m.content });
  }
  const elementsJson = JSON.stringify(pageElements || []).slice(0, 60000);
  const text = (pageText || "").slice(0, 3000);
  messages.push({
    role: "user",
    content:
      `${userMessage || "(continue helping with my current goal)"}\n\n` +
      `<pageText>\n${text}\n</pageText>\n\n` +
      `<pageElements>\n${elementsJson}\n</pageElements>`,
  });
  return messages;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true, model: MODEL }));

// The widget fetches its theme/name here so it can style itself before chatting.
// The scraper can also read companyWebsiteUrl from here (a cached proxy to Base44)
// so it knows which site to crawl for a given clientId.
app.get("/config", async (req, res) => {
  const config = await getClientConfig(req.query.clientId || "");
  res.json({
    primaryColor: config.primaryColor,
    botName: config.botName,
    aggressiveness: config.aggressiveness,
    companyWebsiteUrl: config.companyWebsiteUrl,
    welcomeMessage: config.welcomeMessage,
    launcherIcon: config.launcherIcon,
    suggestedPrompts: config.suggestedPrompts,
    widgetPosition: config.widgetPosition,
    maxAutoSteps: config.maxAutoSteps,
    enabled: config.enabled,
  });
});

// The widget posts engagement events here (widget_loaded, widget_opened,
// message_sent, goal_completed, goal_stuck, feedback, …). We forward them to
// Base44 so the dashboard can chart adoption, common issues, and CSAT. Keeping
// this server-side means the widget never needs the Base44 URL or any secret.
app.post("/analytics", (req, res) => {
  const { clientId = "", event = "", ...rest } = req.body || {};
  if (event) {
    const payload = { event };
    // Only forward a known, size-bounded set of fields.
    if (rest.message != null) payload.message = String(rest.message).slice(0, 500);
    if (rest.value != null) payload.value = String(rest.value).slice(0, 100);
    if (rest.reason != null) payload.reason = String(rest.reason).slice(0, 300);
    if (rest.sessionId != null) payload.session_id = String(rest.sessionId).slice(0, 64);
    if (rest.visitorId != null) payload.visitor_id = String(rest.visitorId).slice(0, 64);
    if (rest.url != null) payload.url = String(rest.url).slice(0, 500);
    if (rest.steps != null && !Number.isNaN(Number(rest.steps))) payload.steps = Number(rest.steps);
    sendAnalytics(clientId, payload);
  }
  res.json({ ok: true });
});

// Serve the widget so the client's <script src="https://<ngrok>/widget.js"> works.
app.get("/widget.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "..", "widget", "widget.js"));
});

// Local demo site (a deliberately maze-like fake "client" website) so you can
// test the whole thing on localhost without Base44 or ngrok. Visit http://localhost:PORT/
app.use(express.static(path.join(__dirname, "public")));

// The main event: decide what to do on the page.
app.post("/chat", async (req, res) => {
  const { message = "", clientId = "", pageElements = [], pageText = "", history = [] } = req.body || {};

  try {
    const config = await getClientConfig(clientId);
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 1024,
      tools: [BROWSER_ACTION_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false, // one action per response — the widget acts one step at a time
      messages: buildMessages(config, history, message, pageElements, pageText, clientId),
    });

    const choice = completion.choices[0];
    const msg = choice.message || {};

    // Split the response into a chat reply + the ordered actions to execute.
    const reply = (msg.content || "").trim();
    const actions = [];
    for (const call of msg.tool_calls || []) {
      if (call.type !== "function" || call.function?.name !== "execute_browser_action") continue;
      let a = {};
      try {
        a = JSON.parse(call.function.arguments || "{}");
      } catch (err) {
        console.warn("could not parse tool arguments:", err.message);
        continue;
      }
      actions.push({
        action: a.action_type,
        target_id: a.target_id ?? null,
        value: a.value ?? null,
        url: a.url ?? null,
        reason: a.reason || "",
      });
    }

    // Push a lightweight analytics event per action so the dashboard charts move.
    for (const a of actions) {
      sendAnalytics(clientId, {
        event: "action_taken",
        type: a.action,
        target: a.target_id,
        reason: a.reason,
        time_saved_seconds: 12, // rough demo estimate of manual effort avoided
      });
    }
    if (actions.length === 0) {
      sendAnalytics(clientId, { event: "chat_reply" });
    }

    res.json({
      reply,
      actions,
      done: choice.finish_reason !== "tool_calls", // no action requested this turn
    });
  } catch (err) {
    console.error("chat error:", err);
    sendAnalytics(clientId, { event: "error", reason: String(err.message || err).slice(0, 300) });
    res.status(500).json({
      reply: "Sorry — I hit a snag reaching my brain. Please try again in a moment.",
      actions: [],
      done: true,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🧭  NaviNate backend running on http://localhost:${PORT}`);
  console.log(`    model:   ${MODEL}`);
  console.log(`    base44:  ${BASE44_URL || "(none — using built-in defaults)"}`);
  console.log(`\n    Expose it with:  ngrok http ${PORT}`);
  console.log(`    Then embed:      <script src="https://<your-ngrok>/widget.js?clientId=CLIENT_ID"></script>\n`);
});
