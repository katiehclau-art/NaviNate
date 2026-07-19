# NaviNate 🧭

An **agentic** chatbot widget for any website. It doesn't just answer questions — it
explores the site and **takes over the cursor to click, type, scroll, and navigate**
on the visitor's behalf, so they don't have to fight a confusing UI.

**Talk to it.** With an ElevenLabs key set, the widget grows a mic: the visitor says
*"find me a hybrid server in the EU and put the cheapest one in my cart"* and watches
the cursor do it while the agent narrates. Voice is optional and degrades cleanly —
no key, no mic button. See [Voice](#voice-elevenlabs) below.

B2B SaaS model: businesses configure their bot in a **Base44 dashboard** and paste one
`<script>` tag onto their site.

```
┌──────────────────────┐        ┌───────────────────────┐        ┌──────────────────────┐
│  Base44 Dashboard    │        │  Local Agent Backend  │        │  Client's Website    │
│  (control plane)     │        │  (this repo /server)  │        │  + widget.js         │
│                      │        │                       │        │                      │
│  /api/config    ─────┼──get──▶│  system prompt,       │◀─chat──┤  scans DOM, sends    │
│  /api/analytics ◀────┼──post──┤  brand color, mode    │──acts─▶│  moves fake cursor,  │
│                      │        │  OpenAI (gpt-4o)      │        │  clicks buttons      │
└──────────────────────┘        │  + /voice/session ────┼─signed─┤          ▲           │
                                └───────────────────────┘  url   │          │ mic/speaker│
                                                                 │          ▼           │
                                          ┌──────────────────────┴──────────────────────┤
                                          │  ElevenLabs Agent (wss, direct)             │
                                          │  speech ⇄ speech, calls client tools:       │
                                          │  navigate_site / read_page / undo           │
                                          └─────────────────────────────────────────────┘
        (already built)              (this repo)                      (widget.js served
                                                                       by the backend)
```

## What's in this repo (the local portion)

| Folder | What it is |
|--------|-----------|
| `server/`  | The **agent brain**. Express + OpenAI SDK. `/chat` takes the user's message + a JSON snapshot of the page's clickable elements and returns actions. Pulls per-client config from Base44 and pushes analytics back. Also serves `widget.js` and a **multi-page demo site** (`server/public/` — Home, Cloud, Telecom, Storage, Solutions, Pricing, Configure, Support, Contact, Status, Cart) for testing the agent locally. |
| `widget/`  | The **embeddable widget** (`widget.js`, vanilla JS). Injects a chat window, scans the DOM, and performs the agent's actions with an animated fake cursor. `voice.js` is the ElevenLabs voice client, lazy-loaded on the first mic tap. |
| `scraper/` | Optional Puppeteer crawler that builds `sitemap.json` — a knowledge base of the site's pages so the agent can jump straight to the right subpage. |

The Base44 dashboard + demo site are built separately in Base44.

---

## Quick start

### 1. Run the backend

```bash
cd server
npm install
cp .env.example .env        # then edit .env: add OPENAI_API_KEY + BASE44_URL
npm start
```

You should see it listening on `http://localhost:3000`.

### 2. Expose it publicly (so the Base44 site can reach your laptop)

```bash
ngrok http 3000
```

Copy the `https://<something>.ngrok.app` URL.

### 3. Embed the widget on the demo site

In the Base44 demo site's page `<head>` (or a Custom HTML block), paste:

```html
<script src="https://<your-ngrok>.ngrok.app/widget.js?clientId=CLIENT_ID"></script>
```

`CLIENT_ID` is the user id / client id whose settings live in the Base44 dashboard.
The widget reads it, themes itself from `/api/config`, and every action it takes is
reported to `/api/analytics` so the dashboard charts move live.

### Split hosting: widget on Base44, brain on your machine

By default the widget calls whatever origin served it, which is right when the
backend serves `widget.js` itself. To host the two **static** widget files on
Base44 (or any CDN) while the agent backend stays local behind a tunnel, point the
tag at the backend explicitly:

```html
<script src="https://your-app.base44.app/widget.js"
        data-client-id="acme"
        data-api="https://agent.example.com"></script>
```

| Attribute | Purpose |
|---|---|
| `data-api` | Base URL of the agent backend (your cloudflared/ngrok hostname). Falls back to the script's own origin. `?api=` on the src works too, for hosts that won't let you set attributes. |
| `data-client-id` | Same as `?clientId=` — whichever is present wins. |
| `data-voice-src` | Only if your host renames or relocates `widget-voice.js`. |

Upload **both** `widget/widget.js` and `widget/voice.js` (as `widget-voice.js`,
next to it). The voice module is resolved relative to `widget.js`, not to the API,
so the browser fetches assets from Base44 and only API calls cross the tunnel:

```
Base44   →  widget.js, widget-voice.js
tunnel   →  /config, /chat, /analytics, /voice/session, /voice/speak, /scrape
```

The backend already sends permissive CORS, so no extra setup is needed. Two things
to watch: a **quick** cloudflared tunnel gets a new hostname every restart, which
means editing the script tag each time — use a *named* tunnel for a stable URL. And
the tunnel must be **https**, or the browser blocks the calls as mixed content and
denies microphone access.

### 4. (Optional) Build the site map

With the backend running (step 1), crawl the bundled multi-page demo site:

```bash
cd scraper
npm install
node scrape.js http://localhost:3000        # or your live Base44 site URL
```

This writes `scraper/sitemap.json` (url → description for every subpage — Cloud,
Telecom, Storage, Pricing, Configure, Support, etc.), which the backend loads
automatically and injects into the agent's system prompt. The agent can then
`navigate` straight to the right subpage — e.g. "I need a hybrid EU server" jumps
directly to `/cloud.html?type=hybrid` instead of hunting through menus.

The crawler renders JS with Puppeteer, so the nav (which `assets/site.js` builds as
real `<a href>` links) is fully discoverable; deep-linked filter variants like
`?type=enterprise` are captured too.

### Multiple client sites

`widget.js` is embedded on many client sites, so each client (tenant) gets its **own**
site map, keyed by the `clientId` in their `<script>` tag. Build a client's map with
`--client <id>` — the URL is looked up automatically from Base44
(`GET /functions/config?clientId=<id>` → `company_website_url`):

```bash
node scrape.js --client acme            # URL pulled from Base44
node scrape.js https://acme.com --client acme   # or pass the URL explicitly
```

This writes `scraper/sitemaps/<clientId>.json`. On each `/chat`, the backend loads the
map matching the request's `clientId`, falling back to the shared `sitemap.json`. The
scraper finds `BASE44_URL` from `--base44`, the environment, or `server/.env`.

### Rescanning from the dashboard (no CLI)

Clients can trigger and monitor a rescan from the Base44 dashboard instead of running
the CLI. The dashboard talks to the **agent backend** (the crawler needs Puppeteer,
which Base44 can't run), which crawls in the background and writes the same
`sitemaps/<clientId>.json`. Two endpoints on the backend (`AGENT_BACKEND_URL`, i.e.
your ngrok/cloudflared URL):

**`POST /scrape`** — start a rescan. Body `{ "clientId": "<id>" }` (the site URL is
read from that client's `company_website_url`; pass `{ "url": "..." }` to override).
Returns the initial status; a crawl already running for that client isn't duplicated.

**`GET /scrape/status?clientId=<id>`** — poll while it runs:
```json
{
  "state": "running",             // idle | running | done | error
  "pages": 12,                     // live count as it crawls
  "url": "https://acme.com",
  "startedAt": "…", "finishedAt": null, "error": null,
  "found": [                       // fills in live, one entry per page crawled
    { "url": "https://acme.com/", "description": "Acme home — …", "error": null }
  ],
  "sitemap": {                     // the saved map the agent actually uses
    "exists": true, "pages": 16, "updatedAt": "…",
    "urls": [ { "url": "https://acme.com/pricing", "description": "Pricing — …" } ]
  }
}
```

`found` is the live feed (append-only while `state` is `running`, and it can
include a page that errored). `sitemap.urls` is the authoritative result — the
exact set of pages injected into the agent's system prompt, so showing it to the
client tells them precisely which pages their assistant can reach. Once the crawl
finishes, `found` is replaced by that same list. Descriptions are capped at 300
characters.
The crawl runs in the backend process (single job per client). `SCRAPE_MAX_PAGES` /
`SCRAPE_MAX_DEPTH` env vars tune the limits (default 40 / 3). Requires the scraper's
deps to be installed (`cd scraper && npm install`) — Puppeteer is imported lazily, so
the server still boots without them and only errors when a scrape is triggered.

---

## Voice (ElevenLabs)

Add one line to `server/.env` and the widget grows a microphone:

```bash
ELEVENLABS_API_KEY=sk_...
```

That's the whole setup. On the first `/voice/session` the backend **provisions an
ElevenLabs agent for that client automatically** — persona built from their Base44
config, client tools registered, overrides enabled — and caches the id in
`server/voice-agents.json`. Edit `system_prompt` or `bot_name` in Base44 and the next
session patches the same agent. Pin `ELEVENLABS_AGENT_ID` instead if you'd rather
build the agent by hand in the ElevenLabs dashboard.

### Why it's not just text-to-speech

The voice agent has **hands**. NaviNate's page-driving loop is exposed to it as
ElevenLabs **client tools**, so it can act, look, and reverse — not just talk:

| Client tool | What the widget does with it |
|---|---|
| `navigate_site(goal)` | Hands the spoken goal to the existing GPT-4o cursor loop. Real cursor, real clicks, multi-step, across pages. Returns a summary of what actually happened. |
| `read_page(question)` | Live snapshot of the visible page, so the agent answers from what's on screen instead of hallucinating a price. |
| `undo_last_action()` | Rewinds the last command — page, scroll, field values, selections. Fires the moment someone says "no, go back". |

So two brains, one visitor: **ElevenLabs runs the conversation** (turn-taking,
barge-in, clarifying questions, emotion) while **NaviNate runs the browser**. The
voice agent announces what it's about to do, the cursor does it, and the agent
reports back — all while the visitor can interrupt at any point.

### The parts that were actually hard

- **Conversation survives navigation.** The WebSocket dies with the document every
  time the agent opens a new page. Before any navigation the widget stashes the last
  turns in `sessionStorage`, then reconnects on the next page with `first_message`
  blanked and the thread replayed as a `contextual_update`. To the visitor it's one
  conversation that walked across five pages.
- **The agent can see the page it's standing on.** After every action and every
  navigation the widget pushes the visible page text as a `contextual_update`, so the
  agent never answers about the page the visitor already left.
- **Barge-in is instant.** On the `interruption` event every queued audio buffer is
  killed immediately rather than left to drain — talking over it actually works.
- **Mic capture runs off the main thread** (AudioWorklet, with a ScriptProcessor
  fallback for strict-CSP sites), because the agent is mutating the DOM *while* the
  visitor is talking and a main-thread processor drops frames on every re-layout.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /voice/status` | Is voice configured on this server? |
| `GET /voice/session?clientId=` | Provisions/patches the agent and mints a short-lived signed `wss://` URL. **The API key never reaches the browser** — audio goes browser↔ElevenLabs directly, no relay hop. |
| `POST /voice/provision` | Force a re-provision after a persona edit. |
| `POST /voice/speak` | One-shot streaming TTS — powers the 🔊 on each reply for people who'd rather read but want a line read back. |

### Extra Base44 config fields

| Field | Effect |
|-------|--------|
| `voice_id` | ElevenLabs voice for this client (defaults to `ELEVENLABS_VOICE_ID`). |
| `voice_enabled` | `false` hides the mic for this client without touching the server. |

Tuning knobs — `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL` (default
`eleven_flash_v2_5`, the lowest time-to-first-audio), `ELEVENLABS_LANGUAGE`,
`ELEVENLABS_AGENT_LLM` — are all documented in `.env.example`.

> The `_v2_5` TTS models are the multilingual ones and an English-locked agent
> rejects them (*"English Agents must use turbo or flash v2"*). When
> `ELEVENLABS_LANGUAGE=en` the backend automatically uses the English-only
> `eleven_flash_v2` for the agent; one-shot TTS is unaffected.

### The voice stage

Starting a call hides the chat panel and floats a bare stage over the site at the
bottom of the screen — captions, a visualiser driven by live audio (the halo is the
agent's voice, the core is the visitor's), and three controls: **⌨** switch to
typing, **🎙** mute, **✕** hang up. No card, no backdrop, and the container ignores
pointer events, so the whole page stays visible and clickable — by the visitor and
by the agent's cursor.

Voice mode and text mode are two views of the same live call. **⌨** returns to the
transcript and keyboard without hanging up; the mic button in the input bar (accent
filled while a call is up) goes back to the stage. Only **✕** ends the call.

### Demo tips

- Voice + cursor together is the moment that lands: **say** the goal, then stop
  talking and let people watch the page drive itself. The stage stays up while the
  cursor works, so nothing is hidden behind a chat window.
- Interrupt it mid-sentence on purpose. It stops instantly, and that sells "live"
  better than any feature list.
- Then say *"no, undo that"* — watching a website take something back because you
  asked out loud is the second-best moment.
- Mic access needs **HTTPS** (or `localhost`). Use the ngrok URL when demoing, not
  a LAN IP.

---

## The Base44 ↔ local contract

The backend expects these two endpoints on your Base44 app (`BASE44_URL`). Base44
serves deployed functions under `/functions/<name>`:

**`GET /functions/config?clientId=<id>` → JSON** (per-client customization)
```json
{
  "brand_color": "#e11d48",
  "system_prompt": "You are a helpful sales assistant. Never offer discounts over 10%.",
  "aggressiveness": "autonomous",
  "company_website_url": "https://acme.com",
  "bot_name": "Acme Helper",
  "welcome_message": "Hi! I'm Acme's assistant — what can I help you find?",
  "launcher_icon": "🤖",
  "suggested_prompts": ["Find an EU server", "Compare pricing", "Contact support"],
  "widget_position": "bottom-right",
  "max_auto_steps": 8,
  "enabled": true
}
```
| Field | Effect |
|-------|--------|
| `brand_color` | Widget accent color (launcher, header, buttons, chips). |
| `system_prompt` | Client's instructions, spliced into the agent's system prompt. |
| `aggressiveness` | `"autonomous"` / `"fully_autonomous"` (bot acts itself) or `"suggestive"` (highlights + explains, won't complete purchases unprompted). |
| `company_website_url` | The client's site; the scraper crawls this (`node scrape.js --client <id>`). |
| `bot_name` | Name shown in the header + launcher tooltip. |
| `welcome_message` | First greeting bubble. |
| `launcher_icon` | Emoji on the launcher bubble + header. |
| `suggested_prompts` | Starter chips shown before the first message (array, or comma/newline string; max 6). |
| `widget_position` | `"bottom-right"` (default) or `"bottom-left"`. |
| `max_auto_steps` | Cap on autonomous steps per goal (1–20). |
| `enabled` | `false` disables the widget without removing the `<script>` tag. |

All fields are optional (sensible defaults apply). Names are snake_case as above;
the backend also accepts the camelCase equivalents (`systemPrompt`, `primaryColor`, …).

**`POST /functions/analytics?clientId=<id>`** — the backend posts one JSON body per
event. Every event includes `action` (a copy of `event`, since the endpoint requires
it), `event`, `ts`, and — for widget events — `session_id`, `visitor_id`, and `url`.

| `event` | When | Extra fields | Dashboard use |
|---------|------|--------------|---------------|
| `widget_loaded` | Widget shown on a page load | — | Reach / page views (denominator) |
| `widget_opened` | Visitor opens the panel (once/session) | — | **Adoption %** = opened ÷ loaded |
| `message_sent` | Visitor sends a message | `message` | Volume + **common questions/issues** (cluster the text) |
| `action_taken` | Agent performs a browser action | `type`, `target`, `reason`, `time_saved_seconds` | **Actions Automated** / **Time Saved** |
| `goal_completed` | A goal finished normally | `steps` | Resolution rate |
| `goal_stuck` | Agent gave up or hit the step cap | `steps` | **Failure/friction rate** (issues to fix) |
| `feedback` | Visitor clicks 👍/👎 on an answer | `value` (`up`/`down`), `message` | **CSAT** |
| `error` | Backend/LLM failure during `/chat` | `reason` | Reliability |
| `chat_reply` | Agent answered in text with no action | — | Q&A volume |
| `voice_started` / `voice_ended` | Visitor opened/closed a voice conversation | — | **Voice adoption** |
| `voice_resumed` | Voice reconnected after the agent changed pages | — | Continuity health |
| `voice_session_started` | Backend minted a signed URL | — | Voice cost/usage |
| `voice_narration` | Visitor tapped 🔊 on a reply | — | Read-aloud demand |
| `scrape_completed` | A site crawl finished | `pages`, `url`, `urls` (array) | **Pages the agent knows** — store and render the list |
| `scrape_failed` | A crawl errored out | `reason`, `url` | Crawl reliability |

Suggested dashboard cards: **Adoption %** (`widget_opened` sessions ÷ `widget_loaded`
sessions), **Actions Automated** & **Time Saved** (sum `action_taken`), **Resolution
rate** (`goal_completed` ÷ `goal_completed`+`goal_stuck`), **CSAT** (👍 ÷ feedback),
and a **Top questions/issues** list built by clustering `message_sent` text (and
`goal_stuck` messages). Group by `session_id`/`visitor_id` for per-user rollups.

> If `BASE44_URL` is blank, the backend runs with sensible built-in defaults so you can
> develop the agent without the dashboard wired up yet.

---

## How a turn works

1. User types a goal (e.g. *"I need a hybrid compute server in the EU"*).
2. `widget.js` scans the DOM, tagging every interactive element with `data-agent-id`,
   and POSTs `{ message, clientId, pageElements, history }` to `/chat`.
3. The backend prompts **OpenAI** with the client's system prompt + the element list and
   the `execute_browser_action` tool.
4. The model returns one action (`click` / `type` / `select` / `scroll` / `navigate` / `highlight`).
5. The widget animates the fake cursor to that element and performs it, then loops —
   re-scanning the now-updated page and taking the next step (up to a safety cap), even
   across page navigations (state is kept in `sessionStorage`).

## Demo tips

- **The fake cursor is the "wow".** Keep the browser window visible when you present.
- Use a deliberately **maze-like demo site** so the agent looks like a superpower.
- Set `aggressiveness: "suggestive"` if you want the bot to point-and-explain instead of
  auto-clicking during a live demo.
- Out of time on the scraper? Skip it — the agent works fine without `sitemap.json`.
