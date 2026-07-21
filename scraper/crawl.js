// NaviNate — reusable crawler core
// ---------------------------------
// Shared by the scrape.js CLI and the backend's /scrape endpoint (so the client
// can trigger a rescan from the Base44 dashboard). Renders JS with Puppeteer so
// it works on SPA sites, follows internal links, and returns { url: description }.

import * as cheerio from "cheerio";

// Locally (and on hosts with a normal disk) `puppeteer` downloads and bundles a
// full Chromium at install time — too big for a Vercel function. On Vercel we
// instead use puppeteer-core (no bundled browser) pointed at the Chromium build
// @sparticuz/chromium ships specifically for Lambda/Vercel-style environments.
async function launchBrowser() {
  if (process.env.VERCEL) {
    const chromium = (await import("@sparticuz/chromium")).default;
    const { default: puppeteer } = await import("puppeteer-core");
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  const { default: puppeteer } = await import("puppeteer");
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

// Pull a human description of a page from its title / h1 / meta description.
// Titles, h1s, and meta descriptions on real sites overlap heavily (and usually
// repeat the brand name), so we clean and dedupe the segments — the result is a
// tight one-liner the agent's LLM can actually reason over.
export function describe(html) {
  const $ = cheerio.load(html);
  const title = ($("title").first().text() || "").trim();
  const h1 = ($("h1").first().text() || "").trim();
  const meta = ($('meta[name="description"]').attr("content") || "").trim();

  // Brand is whatever trails the last " — " / " | " in the <title> (e.g. "NimbusCore").
  const brand = (title.split(/\s+[—|]\s+/).pop() || "").trim();
  const stripBrand = (s) =>
    brand ? s.replace(new RegExp(`\\s*[—|]\\s*${brand}\\s*$`), "").trim() : s;

  const kept = [];
  for (const raw of [stripBrand(title), stripBrand(h1), meta]) {
    const seg = raw.trim();
    if (!seg) continue;
    const low = seg.toLowerCase();
    if (kept.some((k) => k.toLowerCase().includes(low))) continue;
    const supersedes = kept.findIndex((k) => low.includes(k.toLowerCase()));
    if (supersedes !== -1) kept[supersedes] = seg;
    else kept.push(seg);
  }

  const desc = kept.join(" — ").slice(0, 200);
  return desc || "(no description)";
}

// Crawl a site starting at startUrl and return a { url: description } map.
//   maxPages / maxDepth — crawl limits
//   onProgress({ pages, lastUrl, error }) — called after each page (optional),
//     so callers (the dashboard status endpoint) can show live progress
//   isCancelled() — return true to stop early (optional)
export async function crawl({ startUrl, maxPages = 40, maxDepth = 3, onProgress, isCancelled } = {}) {
  const origin = new URL(startUrl).origin; // throws on a bad URL — caller handles it

  // Normalize a URL to dedupe (internal links only; strip hash + trailing slash).
  const normalize = (href, base) => {
    try {
      const u = new URL(href, base);
      if (u.origin !== origin) return null;
      u.hash = "";
      const s = u.href.replace(/\/$/, "");
      return s || u.href;
    } catch {
      return null;
    }
  };

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const siteMap = {};
    const seen = new Set();
    const queue = [{ url: normalize(startUrl, startUrl), depth: 0 }];

    while (queue.length && Object.keys(siteMap).length < maxPages) {
      if (isCancelled && isCancelled()) break;
      const { url, depth } = queue.shift();
      if (!url || seen.has(url)) continue;
      seen.add(url);

      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
        await new Promise((r) => setTimeout(r, 600)); // let late JS render
        const html = await page.content();
        siteMap[url] = describe(html);
        onProgress && onProgress({ pages: Object.keys(siteMap).length, lastUrl: url, desc: siteMap[url] });

        if (depth < maxDepth) {
          const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
          for (const href of links) {
            const n = normalize(href, url);
            if (n && !seen.has(n)) queue.push({ url: n, depth: depth + 1 });
          }
        }
      } catch (err) {
        onProgress && onProgress({ pages: Object.keys(siteMap).length, lastUrl: url, error: err.message });
      }
    }

    return siteMap;
  } finally {
    await browser.close();
  }
}
