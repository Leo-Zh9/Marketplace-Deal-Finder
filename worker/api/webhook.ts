/**
 * GET/PUT /api/webhook -- THE CALLER'S OWN Discord webhook (migrations/0010).
 *
 * WRITE-ONLY BY DESIGN. A webhook URL is a bearer credential: anyone holding it can post to that
 * channel. So `GET` answers `{configured}` and nothing else, `PUT` answers the same, no error body
 * carries the submitted value, and nothing here logs. The URL leaves the Worker only as the target
 * of the notify step's fetch.
 *
 * `{url: "<webhook>"}` sets it, validated by the notify sender's own `isValidWebhookUrl`, so a URL
 * this route accepts is a URL the step will send to. `{url: null}` clears it; user 1 then falls back
 * to the DISCORD_WEBHOOK_URL secret (worker/notify/config.ts destinationFor).
 *
 * A URL RE-OPENS THE CALLER'S ALERTS (`alerts_reopened_at`) ONLY IF THEY HAD NO WORKING DESTINATION
 * BEFORE IT. The notify step skips a user with no destination entirely -- it builds no rows it cannot
 * send -- so without the stamp, deals that qualified while a new user was still setting up would
 * never alert. A user who already had one was already being alerted: switching channels, re-pasting
 * the same webhook in another spelling (discordapp.com / discord.com), or the owner moving from the
 * DISCORD_WEBHOOK_URL secret to the field must NOT re-open a day of backlog into the channel.
 * Clearing never stamps.
 *
 * Returns a RESULT, never a Response, like every file in worker/api/.
 */

import { destinationFor, isValidWebhookUrl, type NotifyEnvironment } from "../notify/config";
import type { User } from "../users/users";

/** A Discord webhook URL is ~120 bytes; the bound and its two-step are worker/api/settings.ts's. */
export const MAX_WEBHOOK_BODY_BYTES = 1024;

export interface WebhookBody {
  configured: boolean;
}

export type WebhookResult =
  | { ok: true; status: 200; body: WebhookBody }
  | { ok: false; status: number; code: string; details?: Record<string, unknown> };

const fail = (status: number, code: string, details?: Record<string, unknown>): WebhookResult =>
  details === undefined ? { ok: false, status, code } : { ok: false, status, code, details };

/** The caller's row was read by provisioning in this request, so GET costs no further read. */
export const handleGetWebhook = (user: User): WebhookResult => ({
  ok: true,
  status: 200,
  body: { configured: user.webhookUrl !== null },
});

/**
 * Scoped to the caller. ?1 the URL or NULL, ?2 now, ?3 user_id, ?4 1 when this gives a user with no
 * working destination their first one.
 * RETURNING only whether one is stored -- the value itself is never read back.
 */
const SET_WEBHOOK = `UPDATE users
   SET webhook_url = ?1,
       alerts_reopened_at = CASE WHEN ?4 = 1 THEN ?2 ELSE alerts_reopened_at END
 WHERE user_id = ?3
RETURNING webhook_url IS NOT NULL AS configured`;

export const handlePutWebhook = async (
  request: Request,
  db: D1Database,
  user: User,
  environment: NotifyEnvironment,
  now: number,
): Promise<WebhookResult> => {
  const appEnv = environment.APP_ENV;
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return fail(415, "UNSUPPORTED_MEDIA_TYPE");
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) return fail(413, "PAYLOAD_TOO_LARGE");

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(400, "INVALID_JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(400, "INVALID_JSON");
  }
  const body = parsed as Record<string, unknown>;
  const unsupported = Object.keys(body).filter((key) => key !== "url").sort();
  if (unsupported.length > 0) return fail(400, "WEBHOOK_FIELD_UNSUPPORTED", { fields: unsupported });
  if (!("url" in body)) return fail(400, "INVALID_WEBHOOK");

  // THE REFUSAL NAMES NO VALUE: echoing a near-miss URL would put a credential in a response.
  let url: string | null;
  if (body.url === null) {
    url = null;
  } else if (typeof body.url === "string" && isValidWebhookUrl(body.url.trim(), appEnv)) {
    url = body.url.trim();
  } else {
    return fail(400, "INVALID_WEBHOOK");
  }

  // destinationFor reads the row AS IT WAS: the owner's secret counts as a working destination.
  const reopens = url !== null && destinationFor(user, environment).state !== "ok";
  try {
    const written = await db
      .prepare(SET_WEBHOOK)
      .bind(url, now, user.userId, reopens ? 1 : 0)
      .all<{ configured: number }>();
    const row = written.results[0];
    if (row === undefined) return fail(503, "WEBHOOK_STORAGE_FAILED");
    return { ok: true, status: 200, body: { configured: row.configured === 1 } };
  } catch {
    return fail(503, "WEBHOOK_STORAGE_FAILED");
  }
};
