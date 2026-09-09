import webpush from "web-push";
import { loadDB, saveDB } from "./db.js";
import { logger } from "./logger.js";
import type { PushSubscription as PushSub } from "./src/types";

// Web Push notifications — deadline reminders, status changes, new comments
// delivered to the browser even when the app tab isn't open. Requires VAPID
// keys in .env (generate with `npx web-push generate-vapid-keys`); until
// those are set, isPushConfigured() is false and the frontend simply won't
// offer to subscribe. No pretending a push was sent when it wasn't — the
// previous /api/push/test stub claimed success without calling web-push at
// all, which is exactly the kind of false-positive this module replaces.

let vapidConfigured = false;

function ensureVapidConfigured(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || "mailto:admin@clm.app";
  if (!publicKey || !privateKey) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(email, publicKey, privateKey);
    vapidConfigured = true;
  }
  return true;
}

export function isPushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string; // where to navigate when the notification is clicked
  tag?: string; // groups/replaces notifications with the same tag
}

export interface SendPushResult {
  sent: number;
  failed: number;
  configured: boolean;
}

/** Sends a push notification to every subscription owned by the given user. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<SendPushResult> {
  return sendPushToSubscriptions((db) => (db.pushSubscriptions as PushSub[] || []).filter((s) => s.userId === userId), payload);
}

/** Sends a push notification to every subscription within a tenant. */
export async function sendPushToTenant(tenantId: string, payload: PushPayload): Promise<SendPushResult> {
  return sendPushToSubscriptions((db) => (db.pushSubscriptions as PushSub[] || []).filter((s) => s.tenantId === tenantId), payload);
}

async function sendPushToSubscriptions(
  select: (db: any) => PushSub[],
  payload: PushPayload,
): Promise<SendPushResult> {
  if (!ensureVapidConfigured()) {
    return { sent: 0, failed: 0, configured: false };
  }
  const db = loadDB();
  const subs = select(db);
  if (subs.length === 0) return { sent: 0, failed: 0, configured: true };

  let sent = 0;
  let failed = 0;
  const deadEndpoints = new Set<string>();

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
        );
        sent++;
      } catch (err: any) {
        failed++;
        // 404/410 = the browser subscription is gone (uninstalled, cleared
        // storage, etc) — clean it up so we stop retrying it forever.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          deadEndpoints.add(sub.endpoint);
        } else {
          logger.warn({ err: err?.message, endpoint: sub.endpoint }, "Push notification send failed");
        }
      }
    }),
  );

  if (deadEndpoints.size > 0) {
    db.pushSubscriptions = (db.pushSubscriptions as PushSub[]).filter((s) => !deadEndpoints.has(s.endpoint));
    saveDB(db);
  }

  return { sent, failed, configured: true };
}
