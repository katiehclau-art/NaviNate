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

import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

let origin;
// Resolve the site to crawl (an explicit URL wins; otherwise look it up from
// Base44 via --client) and its origin. Throws friendly errors that the promise
// chain at the bottom turns into a clean exit — we deliberately DON'T call
// process.exit() here, since doing so while the config fetch is still closing its
// socket can trip a libuv assertion on Windows.
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
    origin = new URL(startUrl).origin;
  } catch {
    throw new Error(`Invalid start URL: ${startUrl}`);
  }
  return startUrl;
}

// Normalize a URL to dedupe (strip hash + trailing slash).
function normalize(href, base) {
  try {
    const u = new URL(href, base);
    if (u.origin !== origin) return null; // internal links only
    u.hash = "";
    let s = u.href.replace(/\/$/, "");
    return s || u.href;
  } catch {
    return null;
  }
}

// Pull a human description of a page from its title / h1 / meta description.
// Titles, h1s, and meta descriptions on real sites overlap heavily (and usually
// repeat the brand name), so we clean and dedupe the segments — the result is a
// tight one-liner the agent's LLM can actually reason over.
function describe(html) {
  const $ = cheerio.load(html);
  const title = ($("title").first().text() || "").trim();
  const h1 = ($("h1").first().text() || "").trim();
  const meta = ($('meta[name="description"]').attr("content") || "").trim();

  // Brand is whatever trails the last " — " / " | " in the <title> (e.g. "NimbusCore").
  const brand = (title.split(/\s+[—|]\s+/).pop() || "").trim();
  const stripBrand = (s) =>
    brand ? s.replace(new RegExp(`\\s*[—|]\\s*${brand}\\s*$`), "").trim() : s;

  // Keep title/h1/meta, minus the brand suffix, dropping any segment already
  // contained in one we've kept (case-insensitive) so nothing repeats.
  const kept = [];
  for (const raw of [stripBrand(title), stripBrand(h1), meta]) {
    const seg = raw.trim();
    if (!seg) continue;
    const low = seg.toLowerCase();
    if (kept.some((k) => k.toLowerCase().includes(low))) continue;
    // If this new segment supersets an existing shorter one, replace it.
    const supersedes = kept.findIndex((k) => low.includes(k.toLowerCase()));
    if (supersedes !== -1) kept[supersedes] = seg;
    else kept.push(seg);
  }

  const desc = kept.join(" — ").slice(0, 200);
  return desc || "(no description)";
}

async function run(startUrl) {
  console.log(`🕸  Crawling ${startUrl}  (max ${MAX_PAGES} pages, depth ${MAX_DEPTH})`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const siteMap = {};
  const seen = new Set();
  const queue = [{ url: normalize(startUrl, startUrl), depth: 0 }];

  while (queue.length && Object.keys(siteMap).length < MAX_PAGES) {
    const { url, depth } = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 600)); // let late JS render
      const html = await page.content();
      siteMap[url] = describe(html);
      console.log(`  ✓ ${url}\n      ${siteMap[url]}`);

      if (depth < MAX_DEPTH) {
        const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
        for (const href of links) {
          const n = normalize(href, url);
          if (n && !seen.has(n)) queue.push({ url: n, depth: depth + 1 });
        }
      }
    } catch (err) {
      console.warn(`  ✗ ${url} — ${err.message}`);
    }
  }

  await browser.close();

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
