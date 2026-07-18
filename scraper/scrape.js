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
const startUrl = args.find((a) => a.startsWith("http"));
const getFlag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const MAX_PAGES = parseInt(getFlag("--max", "40"), 10);
const MAX_DEPTH = parseInt(getFlag("--depth", "3"), 10);

if (!startUrl) {
  console.error("Usage: node scrape.js <startUrl> [--max N] [--depth N]");
  process.exit(1);
}

const origin = new URL(startUrl).origin;

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

async function run() {
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

  const outPath = path.join(__dirname, "sitemap.json");
  fs.writeFileSync(outPath, JSON.stringify(siteMap, null, 2));
  console.log(`\n✅  Wrote ${Object.keys(siteMap).length} pages to ${outPath}`);
  console.log("   The backend will pick this up automatically on its next request.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
