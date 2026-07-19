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
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ensureAgent, resolveDefaultVoice, signedUrl, speak, voiceConfigured, voiceDefaults } from "./voice.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE44_URL = (process.env.BASE44_URL || "").replace(/\/$/, "");
const MODEL = process.env.MODEL || "gpt-4o";

if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. Copy server/.env.example to server/.env first.");
}

// timeout + maxRetries are load-bearing, not tuning: the SDK default is a 600s
// (ten-minute!) timeout, so a stalled upstream request would leave /chat hanging
// for minutes and the widget frozen on "Working…". Cap each attempt at 30s with a
// single retry, so a step either answers promptly or fails fast enough for the
// client to recover.
const openai = new OpenAI({ timeout: 30000, maxRetries: 1 }); // reads OPENAI_API_KEY from the environment

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
  suggestedPrompts: [], // starter chips shown before the first message, e.g. ["Find an EU server"]
  widgetPosition: "bottom-right", // "bottom-right" | "bottom-left"
  maxAutoSteps: 8, // safety cap on autonomous steps per goal
  enabled: true, // master on/off switch for the widget on the client's site
  voiceEnabled: true, // show the mic button (needs ELEVENLABS_API_KEY server-side)
  voiceId: "", // ElevenLabs voice for this client; blank = the server default
};
const CONFIG_TTL_MS = 60 * 1000;
const configCache = new Map();

// Base44 returns the client's settings in snake_case, e.g.
//   { brand_color, system_prompt, aggressiveness, company_website_url,
//     welcome_message, suggested_prompts, widget_position,
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
  set("widgetPosition", str(pick("widget_position", "widgetPosition")));
  set("voiceId", str(pick("voice_id", "voiceId", "elevenlabs_voice_id")));

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

  const voiceEnabled = pick("voice_enabled", "voiceEnabled");
  if (voiceEnabled != null) {
    out.voiceEnabled = !(voiceEnabled === false || voiceEnabled === "false" || voiceEnabled === 0 || voiceEnabled === "0");
  }

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
// On-demand rescans. The client clicks "Rescan my site" in the Base44 dashboard,
// which calls POST /scrape here; the dashboard then polls GET /scrape/status.
// The crawl runs in this process (it needs Puppeteer, which Base44 can't run) and
// writes scraper/sitemaps/<clientId>.json — the same file loadSiteMap reads.
// ---------------------------------------------------------------------------
const scrapeJobs = new Map(); // clientId -> { state, pages, url, startedAt, finishedAt, error }
const SCRAPE_MAX_PAGES = parseInt(process.env.SCRAPE_MAX_PAGES || "40", 10);
const SCRAPE_MAX_DEPTH = parseInt(process.env.SCRAPE_MAX_DEPTH || "3", 10);

function safeClientId(clientId) {
  return String(clientId || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function sitemapPath(clientId) {
  const safeId = safeClientId(clientId);
  return path.join(__dirname, "..", "scraper", safeId ? path.join("sitemaps", `${safeId}.json`) : "sitemap.json");
}

// The sitemap is { url: description }; the dashboard wants a list it can render.
// Descriptions are trimmed because a whole crawl's worth of them is a lot of
// payload for what is, on screen, one line per row.
function sitemapToList(map) {
  return Object.entries(map || {}).map(([url, description]) => ({
    url,
    description: String(description || "").slice(0, 300),
  }));
}

// Info about the currently-saved map for a client (for the dashboard status card).
// `urls` is the full list of pages the agent currently knows about — the same set
// that gets injected into its system prompt, so the client can see exactly what
// their assistant can reach.
function savedSitemapInfo(clientId) {
  try {
    const p = sitemapPath(clientId);
    if (!fs.existsSync(p)) return { exists: false, pages: 0, updatedAt: null, urls: [] };
    const map = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      exists: true,
      pages: Object.keys(map).length,
      updatedAt: fs.statSync(p).mtime.toISOString(),
      urls: sitemapToList(map),
    };
  } catch {
    return { exists: false, pages: 0, updatedAt: null, urls: [] };
  }
}

function scrapeStatus(clientId) {
  const job = scrapeJobs.get(clientId) || { state: "idle" };
  return { ...job, sitemap: savedSitemapInfo(clientId) };
}

// Kick off a crawl for a client (unless one is already running). Runs async and
// updates scrapeJobs as it goes; writes the sitemap when done. Returns the status.
async function startScrape(clientId, startUrl) {
  const existing = scrapeJobs.get(clientId);
  if (existing && existing.state === "running") return scrapeStatus(clientId);

  // `found` fills in as the crawl walks the site, so the dashboard can list pages
  // live instead of showing a bare counter until the whole crawl finishes.
  const job = {
    state: "running",
    pages: 0,
    url: startUrl,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    found: [],
  };
  scrapeJobs.set(clientId, job);

  // Import Puppeteer lazily so the server still boots if scraper deps aren't
  // installed — the error only surfaces when someone actually triggers a scrape.
  (async () => {
    try {
      const { crawl } = await import("../scraper/crawl.js");
      const siteMap = await crawl({
        startUrl,
        maxPages: SCRAPE_MAX_PAGES,
        maxDepth: SCRAPE_MAX_DEPTH,
        onProgress: ({ pages, lastUrl, desc, error }) => {
          job.pages = pages;
          if (lastUrl) {
            job.found.push({
              url: lastUrl,
              description: String(desc || "").slice(0, 300),
              error: error || null,
            });
          }
        },
      });
      const p = sitemapPath(clientId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(siteMap, null, 2));
      const urls = sitemapToList(siteMap);
      job.pages = urls.length;
      job.found = urls; // settle on the saved map (drops pages that errored out)
      job.state = "done";
      job.finishedAt = new Date().toISOString();
      console.log(`🕸  scrape for "${clientId}" done — ${job.pages} pages`);
      // Push the result to Base44 too, so the dashboard can record what the
      // agent learned without having to be open and polling at the time.
      sendAnalytics(clientId, {
        event: "scrape_completed",
        pages: job.pages,
        url: startUrl,
        urls: urls.map((u) => u.url),
      });
    } catch (err) {
      job.state = "error";
      job.error = String(err.message || err).slice(0, 300);
      job.finishedAt = new Date().toISOString();
      console.warn(`scrape for "${clientId}" failed:`, job.error);
      sendAnalytics(clientId, { event: "scrape_failed", reason: job.error, url: startUrl });
    }
  })();

  return scrapeStatus(clientId);
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
          enum: ["click", "type", "select", "slider", "scroll", "navigate", "highlight"],
          description:
            "click: click an element. type: type text into a text/number/email/etc input — NEVER use this for an " +
            "element that has min/max in pageElements, that's a slider. select: choose an option in a native select dropdown. " +
            "slider: drag a range slider (an element with min/max in pageElements — native <input type=range> or an " +
            "ARIA role=slider widget) to a numeric value. " +
            "scroll: bring an element into view. " +
            "navigate: go to a URL (use for jumping to a known subpage). " +
            "highlight: draw attention to an element and explain it WITHOUT clicking (use this instead of click " +
            "for irreversible/high-commitment actions like final checkout or submitting payment when you are not certain).",
        },
        target_id: {
          type: "string",
          description:
            "The data-agent-id of the element to act on (from the pageElements list). Required for click, type, select, slider, scroll, highlight.",
        },
        value: {
          type: "string",
          description:
            "The text to type, the exact dropdown option label/value to select, or the target numeric value for a slider " +
            "(must respect that element's min/max/step from pageElements). Required for type, select, or slider.",
        },
        url: {
          type: "string",
          description:
            "Destination path or URL. Only for action_type=navigate. It MUST be copied verbatim from the " +
            "KNOWN SITE MAP or from an href in pageElements — never guessed, shortened, or constructed from " +
            "the page's wording. Guessed paths 404 and strand the visitor.",
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
      ? "MODE: Suggestive. Prefer to guide the user — use \"highlight\" to point at the right element and explain it, and only \"click\" for clearly safe, low-stakes navigation. Never complete a purchase or submit a form."
      : "MODE: Autonomous. You may click, type, scroll, and navigate on the user's behalf to accomplish their goal. Stop at the final irreversible step: use \"highlight\" and plain text instead of clicking buttons that submit payment, place an order, complete a purchase, book/reserve, subscribe, or submit a form.";

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
  - value: the element's current value when relevant (current position, for a slider)
  - min, max, step: present ONLY when this element is a slider (type "range", or a custom slider widget) — the valid
    range and increment. If an element has min/max, it is a slider: use action_type "slider" on it, NEVER "type",
    even though its tag is "input". Always pick a value on-step within [min, max].
  - options: for native select dropdowns, the available option labels and values
  - checked: present ONLY for radio buttons and checkboxes (type "radio"/"checkbox"). true = that option is currently selected. To choose a radio or toggle a checkbox, use action_type "click" on it (NOT "select" — that's only for native dropdowns). Never click a radio whose checked is already true; pick the right option by its "text"/"context" label. To change a radio selection, just click the option you want — the previously-selected one clears automatically.
  - context: the text of the surrounding card/row — this usually contains the price and product name tied to THIS element. Use it to pick the right button (e.g. the "Add to Cart" whose context shows "$999/mo").
  - href: destination for links
  - active: true means this control (a filter, tab, toggle, or a selected radio) is ALREADY selected/applied. Do NOT click an active:true element again — it's done; move to the next step.
  - visible: whether it's currently in the viewport
You can only ACT on elements present in pageElements. If what you need isn't there, scroll or navigate to find it, or ask the user.

Worked example — "add the most expensive plan": read the prices from pageText/context, find the highest, then click the "Add to Cart" whose context matches that price. That's usually ONE click — no need to open any details page.

If the goal cannot be satisfied on this page (e.g. the user asks for a combination of filters that yields no results, or an item that doesn't exist here), don't keep clicking — say so plainly and suggest the closest available alternative you can see in pageText.

NAVIGATION RULES (a guessed URL is worse than no action at all):
- You may ONLY navigate to a URL that appears verbatim in the KNOWN SITE MAP below, or as an "href" on an element in pageElements. If neither contains it, the page does not exist as far as you are concerned.
- Never invent, guess, or infer a path from a page's wording. "/faq", "/pricing", "/help" are not real just because the site talks about FAQs, pricing or help.
- If the destination you want isn't in the site map or in any href, prefer clicking a link/menu that leads there. If there is no such link, say plainly that you can't find that page and offer the closest one that IS listed.
- If a navigation is reported back to you as failed or not found, do NOT retry it or try a similar invented path — pick a real link from pageElements, or tell the user.

HOW TO ACT:
- To do something on the page, call the execute_browser_action tool. Use "select" with an exact option label or value for native select dropdowns. Use "slider" with a numeric value (on-step, within min/max) for range sliders.
- Take ONE step per turn. After the page updates you'll be called again with fresh pageElements.
- Always set a friendly "reason" — the user sees it as you work.
- If the user is just asking a question, answer in plain text and don't call the tool.
- Keep chat replies short and warm.

WHEN TO STOP (important — avoid loops):
- Your previous actions this session are recorded in the conversation as assistant notes. Read them before acting.
- Do NOT repeat an action you have already taken. If the page already reflects your intent (the filter is active, the item is in the cart, you're on the right tab), that step is DONE — move to the next step or finish.
- Once the user's goal is accomplished, STOP calling the tool and reply with a short plain-text confirmation. Do not keep acting.
- Treat the latest explicit current-goal instruction as authoritative. Never continue an older user request after finishing a newer one.
- If the current goal only asks to go, open, or navigate to a page, reaching that page completes the goal. Do not select products, change fields, or add anything to the cart unless the current goal explicitly asks for it.
- You may prepare checkout/forms up to the review step, but do not click the final irreversible button yourself. Highlight it and tell the user to review and click it if they want to proceed.
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
    suggestedPrompts: config.suggestedPrompts,
    widgetPosition: config.widgetPosition,
    maxAutoSteps: config.maxAutoSteps,
    enabled: config.enabled,
    // Voice is only offered when the client wants it AND the server actually
    // holds an ElevenLabs key — otherwise the widget hides the mic entirely
    // rather than showing a button that can only fail.
    voiceEnabled: config.voiceEnabled !== false && voiceConfigured(),
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

// Start a rescan of a client's site. The Base44 dashboard's "Rescan my site"
// button calls this. We resolve the site URL from the client's config (or an
// explicit `url` override), then crawl in the background. Returns the status.
app.post("/scrape", async (req, res) => {
  const clientId = req.body?.clientId || req.query.clientId || "";
  if (!clientId) return res.status(400).json({ error: "clientId is required" });

  let startUrl = req.body?.url || "";
  if (!startUrl) {
    const config = await getClientConfig(clientId);
    startUrl = config.companyWebsiteUrl || "";
  }
  if (!startUrl) {
    return res.status(400).json({
      error: "No site URL. Set company_website_url in the client's config, or pass { url } in the body.",
    });
  }
  try {
    new URL(startUrl); // validate before launching a browser
  } catch {
    return res.status(400).json({ error: `Invalid site URL: ${startUrl}` });
  }

  const status = await startScrape(clientId, startUrl);
  res.json(status);
});

// Poll the status of a client's scrape (state: idle | running | done | error)
// plus info about the currently-saved sitemap.
app.get("/scrape/status", (req, res) => {
  const clientId = req.query.clientId || "";
  if (!clientId) return res.status(400).json({ error: "clientId is required" });
  res.json(scrapeStatus(clientId));
});

// ---------------------------------------------------------------------------
// Voice (ElevenLabs). The browser never sees the API key: it asks us for a
// short-lived signed WebSocket URL and talks to ElevenLabs directly from there,
// which keeps the audio path peer-to-server (no relay hop = lower latency).
// ---------------------------------------------------------------------------

// Is voice available at all? The widget calls this before showing the mic.
app.get("/voice/status", async (_req, res) => {
  const out = { configured: voiceConfigured(), ...voiceDefaults };
  if (voiceConfigured()) {
    try {
      out.voiceId = await resolveDefaultVoice();
    } catch (err) {
      out.voiceError = String(err.message || err).slice(0, 300);
    }
  }
  res.json(out);
});

// Mint a session. Also returns the per-session overrides the widget replays over
// the socket, so a persona edited in Base44 takes effect on the very next call
// without re-provisioning anything.
app.get("/voice/session", async (req, res) => {
  const clientId = req.query.clientId || "";
  if (!voiceConfigured()) {
    return res.status(503).json({ error: "Voice is not configured on this server (set ELEVENLABS_API_KEY)." });
  }
  try {
    const config = await getClientConfig(clientId);
    if (config.voiceEnabled === false) return res.status(403).json({ error: "Voice is disabled for this client." });

    const agentId = await ensureAgent(clientId, config);
    const url = await signedUrl(agentId);
    sendAnalytics(clientId, { event: "voice_session_started" });
    res.json({
      signedUrl: url,
      agentId,
      botName: config.botName,
      voiceId: config.voiceId || (await resolveDefaultVoice()),
      welcomeMessage: config.welcomeMessage,
    });
  } catch (err) {
    console.error("voice session error:", err);
    sendAnalytics(clientId, { event: "error", reason: `voice: ${String(err.message || err).slice(0, 200)}` });
    res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
});

// Force a re-provision (the dashboard's "update my voice agent" button).
app.post("/voice/provision", async (req, res) => {
  const clientId = req.body?.clientId || req.query.clientId || "";
  try {
    const config = await getClientConfig(clientId);
    const agentId = await ensureAgent(clientId, config);
    res.json({ ok: true, agentId });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
});

// Narration mode: speak a line of text. Used when there's no live conversation
// (mic denied, or the visitor typed instead of talking) so the assistant still
// has a voice. Streams the audio through so playback starts before ElevenLabs
// has finished generating.
app.post("/voice/speak", async (req, res) => {
  const { text = "", clientId = "" } = req.body || {};
  const line = String(text).trim().slice(0, 800);
  if (!line) return res.status(400).json({ error: "text is required" });
  try {
    const config = await getClientConfig(clientId);
    const stream = await speak({ text: line, voiceId: config.voiceId });
    res.type("audio/mpeg");
    Readable.fromWeb(stream).pipe(res);
  } catch (err) {
    console.error("tts error:", err);
    res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
});

// Serve the widget so the client's <script src="https://<ngrok>/widget.js"> works.
app.get("/widget.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "..", "widget", "widget.js"));
});

// The voice client, loaded on demand by widget.js the first time someone taps
// the mic — so sites that never use voice don't pay for the code.
app.get("/widget-voice.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "..", "widget", "voice.js"));
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
  console.log(`    voice:   ${voiceConfigured() ? `ElevenLabs (${voiceDefaults.ttsModel})` : "(off — set ELEVENLABS_API_KEY)"}`);
  console.log(`\n    Expose it with:  ngrok http ${PORT}`);
  console.log(`    Then embed:      <script src="https://<your-ngrok>/widget.js?clientId=CLIENT_ID"></script>\n`);
});
