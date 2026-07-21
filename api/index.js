// Vercel entry point. Everything else (routes, config, voice, scrape) lives in
// server/server.js — this just hands Vercel the Express app as a request
// handler instead of the app calling app.listen() itself.
export { default } from "../server/server.js";
