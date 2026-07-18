// NaviNate — Site Map Scraper
// ---------------------------
// Crawls a domain, follows internal links (rendering JS with Puppeteer so it
// works on SPA sites like the Base44 demo), and writes sitemap.json:
//   { "url": "description", ... }
// The backend loads this so the agent knows which subpage to navigate to for a
// general request ("I need EU hosting") without having to blindly click around.
//
// Usage:
//   node scrape.js https://your-demo-site.base44.app
//   node scrape.js https://your-demo-site.base44.app --max 40 --depth 3

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawl } from "./crawl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- args ----
const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const MAX_PAGES = parseInt(getFlag("--max", "40"), 10);
const MAX_DEPTH = parseInt(getFlag("--depth", "3"), 10);
// Which client (tenant) this site map belongs to. The widget sends the same
// clientId on every /chat, so the backend can load the matching map. One
// clientId == one site. Omit for the local demo (writes the default sitemap.json).
const rawClient = getFlag("--client", "");
const CLIENT_ID = rawClient.replace(/[^a-zA-Z0-9_-]/g, ""); // sanitize -> safe filename

if (rawClient && !CLIENT_ID) {
  console.error(`Invalid --client "${rawClient}" — use letters, numbers, "-" or "_".`);
  process.exit(1);
}

const USAGE = "Usage: node scrape.js [startUrl] [--client ID] [--base44 URL] [--max N] [--depth N]";

// Base44 base URL (the control plane). Precedence: --base44 flag > env > server/.env.
function readServerEnvBase44() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, "..", "server", ".env"), "utf8");
    const m = txt.match(/^\s*BASE44_URL\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no server/.env — fine */
  }
  return "";
}
const BASE44_URL = (getFlag("--base44", process.env.BASE44_URL || readServerEnvBase44()) || "").replace(/\/$/, "");

// Ask Base44 which site belongs to this client (company_website_url), so you can
// onboard a client with just `node scrape.js --client <id>` — no URL to remember.
// Base44 serves deployed functions under /functions/<name>.
async function fetchClientSiteUrl(clientId) {
  const endpoint = `${BASE44_URL}/functions/config?clientId=${encodeURIComponent(clientId)}`;
  const res = await fetch(endpoint);
  const body = await res.text(); // read fully so the connection can close cleanly
  if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`);
  let cfg;
  try {
    cfg = JSON.parse(body);
  } catch {
    throw new Error(
      `${endpoint} did not return JSON (got "${body.slice(0, 30)}…"). ` +
        "Check BASE44_URL points at your Base44 app."
    );
  }
  const url = cfg.company_website_url || cfg.companyWebsiteUrl;
  if (!url) throw new Error("config had no company_website_url");
  return url;
}

// Skip args that are values of value-taking flags (e.g. the URL passed to
// --base44) so we don't mistake them for the start URL.
const flagValueIndexes = new Set();
for (const f of ["--max", "--depth", "--client", "--base44"]) {
  const i = args.indexOf(f);
  if (i !== -1) flagValueIndexes.add(i + 1);
}

// Resolve the site to crawl (an explicit URL wins; otherwise look it up from
// Base44 via --client). Throws friendly errors that the promise chain at the
// bottom turns into a clean exit — we deliberately DON'T call process.exit()
// here, since doing so while the config fetch is still closing its socket can
// trip a libuv assertion on Windows.
async function resolveTarget() {
  let startUrl = args.find((a, i) => a.startsWith("http") && !flagValueIndexes.has(i));
  if (!startUrl && CLIENT_ID && BASE44_URL) {
    startUrl = await fetchClientSiteUrl(CLIENT_ID);
    console.log(`🔎  Resolved clientId="${CLIENT_ID}" → ${startUrl}  (from ${BASE44_URL}/functions/config)`);
  }
  if (!startUrl) {
    throw new Error(
      CLIENT_ID && !BASE44_URL
        ? "No startUrl given and no Base44 URL to look one up. Pass a URL, or set BASE44_URL (env / server/.env) or --base44."
        : USAGE
    );
  }
  try {
    new URL(startUrl); // validate
  } catch {
    throw new Error(`Invalid start URL: ${startUrl}`);
  }
  return startUrl;
}

async function run(startUrl) {
  console.log(`🕸  Crawling ${startUrl}  (max ${MAX_PAGES} pages, depth ${MAX_DEPTH})`);
  const siteMap = await crawl({
    startUrl,
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    onProgress: ({ pages, lastUrl, desc, error }) =>
      console.log(error ? `  ✗ ${lastUrl} — ${error}` : `  ✓ [${pages}] ${lastUrl}\n      ${desc || ""}`),
  });

  // Per-client map lives in sitemaps/<clientId>.json; the demo uses sitemap.json.
  let outPath;
  if (CLIENT_ID) {
    const dir = path.join(__dirname, "sitemaps");
    fs.mkdirSync(dir, { recursive: true });
    outPath = path.join(dir, `${CLIENT_ID}.json`);
  } else {
    outPath = path.join(__dirname, "sitemap.json");
  }
  fs.writeFileSync(outPath, JSON.stringify(siteMap, null, 2));
  console.log(`\n✅  Wrote ${Object.keys(siteMap).length} pages to ${outPath}`);
  console.log(
    CLIENT_ID
      ? `   The backend will use this for clientId="${CLIENT_ID}" on its next request.`
      : "   The backend will pick this up automatically on its next request."
  );
}

resolveTarget()
  .then(run)
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1; // clean exit — lets pending handles close (avoids libuv assert)
  });
