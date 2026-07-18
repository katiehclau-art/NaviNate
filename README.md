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
| `server/`  | The **agent brain**. Express + OpenAI SDK. `/chat` takes the user's message + a JSON snapshot of the page's clickable elements and returns actions. Pulls per-client config from Base44 and pushes analytics back. Also serves `widget.js`. |
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

```bash
cd scraper
npm install
node scrape.js https://your-demo-site.base44.app
```

This writes `scraper/sitemap.json`, which the backend loads automatically — the agent
can then `navigate` straight to the right subpage instead of hunting for it.

---

## The Base44 ↔ local contract

The backend expects these two endpoints on your Base44 app (`BASE44_URL`):

**`GET /api/config?clientId=<id>` → JSON**
```json
{
  "systemPrompt": "You are a helpful sales assistant. Never offer discounts over 10%.",
  "primaryColor": "#e11d48",
  "botName": "Acme Helper",
  "aggressiveness": "autonomous"
}
```
- `aggressiveness`: `"autonomous"` (bot clicks things itself) or `"suggestive"` (bot
  highlights + explains, and won't complete purchases without confirmation).

**`POST /api/analytics?clientId=<id>`** — body like:
```json
{ "event": "action_taken", "type": "click", "target": "42", "reason": "Opening the Laptops category", "time_saved_seconds": 12 }
```
Increment your dashboard's "Actions Automated" / "Time Saved" cards from these.

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
