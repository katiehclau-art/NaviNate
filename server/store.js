// NaviNate — small persistent JSON store.
// -----------------------------------------
// Locally (and on any host with a normal writable disk — Render, Railway, a VM,
// ngrok'd localhost) this is unused: callers just read/write files as before.
//
// On Vercel the deployment filesystem is read-only outside /tmp, and /tmp does
// NOT survive between invocations or across the multiple instances Vercel may
// spin up for the same function — so anything that needs to outlive a single
// request (the scraped sitemap, the ElevenLabs agent registry, in-flight scrape
// job status) has to live somewhere shared instead. Add a Redis store from the
// Vercel Marketplace (Upstash) and connect it to this project: it injects
// KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN,
// depending on how the integration names them), which is what flips `usingKV`
// on below. (@vercel/kv itself is deprecated in favor of this Marketplace
// integration — same Upstash Redis underneath, just accessed directly.)
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const usingKV = !!(REDIS_URL && REDIS_TOKEN);

let redisClientPromise = null;
async function redis() {
  if (!redisClientPromise) {
    redisClientPromise = import("@upstash/redis").then(
      ({ Redis }) => new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
    );
  }
  return redisClientPromise;
}

// Returns `undefined` when KV isn't configured, so callers know to fall back to
// their own filesystem/in-memory path instead of treating "no store" as "empty".
export async function kvGetOrUndefined(key) {
  if (!usingKV) return undefined;
  const client = await redis();
  const val = await client.get(key);
  return val === null || val === undefined ? null : val;
}

export async function kvSet(key, value) {
  if (!usingKV) return false;
  const client = await redis();
  await client.set(key, value);
  return true;
}

export { usingKV };
