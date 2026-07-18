# NaviNate 🧭

An **agentic** chatbot widget for any website. It doesn't just answer questions — it
explores the site and **takes over the cursor to click, type, scroll, and navigate**
on the visitor's behalf, so they don't have to fight a confusing UI.

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
└──────────────────────┘        └───────────────────────┘        └──────────────────────┘
        (already built)              (this repo)                      (widget.js served
                                                                       by the backend)
```

## What's in this repo (the local portion)

| Folder | What it is |
|--------|-----------|
| `server/`  | The **agent brain**. Express + OpenAI SDK. `/chat` takes the user's message + a JSON snapshot of the page's clickable elements and returns actions. Pulls per-client config from Base44 and pushes analytics back. Also serves `widget.js` and a **multi-page demo site** (`server/public/` — Home, Cloud, Telecom, Storage, Solutions, Pricing, Configure, Support, Contact, Status, Cart) for testing the agent locally. |
| `widget/`  | The **embeddable widget** (`widget.js`, vanilla JS). Injects a chat window, scans the DOM, and performs the agent's actions with an animated fake cursor. |
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
