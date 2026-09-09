import type { IncomingMessage, ServerResponse } from "http";
import { app, readyPromise } from "../server.js";
import { flushPendingWrites } from "../db.js";

// Vercel serverless entrypoint. All /api/* requests are rewritten here (see
// vercel.json) and handled by the same Express app used on Render/VPS/local
// dev — no route logic is duplicated or reimplemented.
//
// Vercel's Node builder transpiles each /api/*.ts file individually (it does
// NOT bundle when package.json has "type": "module") and relies on Node's
// native ESM resolver to load the resulting relative imports at runtime.
// That resolver requires explicit file extensions on relative specifiers, so
// every import reachable from this file — here and transitively through
// server.ts/db.ts/etc — is written with a ".js" extension pointing at the
// compiled sibling, even though the source is ".ts". Omitting it produces
// `ERR_MODULE_NOT_FOUND` in production despite working fine locally, where
// tsx/vite resolve extensionless specifiers without complaint.
//
// Two things a long-lived process gets for free that a serverless function
// doesn't, handled explicitly below:
//  1. Routes/DB hydration only need to happen once per process, not once per
//     request — `readyPromise` (set by server.ts on module load) is awaited
//     so a cold start finishes booting before the first request is handled,
//     and is already-resolved for every later invocation of a warm instance.
//  2. db.ts's saveDB() queues its actual Postgres write on a background
//     promise chain instead of awaiting it inline (kept that way so ~100
//     call sites didn't need to become async). On a persistent server that
//     queue drains on its own between requests; on Vercel the function can
//     be frozen the instant the HTTP response finishes, which could silently
//     drop a write still in flight. Awaiting flushPendingWrites() after the
//     response is sent (but before this handler resolves) closes that gap.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await readyPromise;
  await new Promise<void>((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
    app(req as any, res as any);
  });
  await flushPendingWrites();
}
