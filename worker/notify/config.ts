/**
 * THE NOTIFICATION SWITCH, READ FROM THE ENVIRONMENT AND NOTHING ELSE.
 *
 * Two inputs, both Worker secrets (or `--var` locally), and NEITHER is declared in
 * wrangler.jsonc `vars`: a var and a secret with the same name clash, and the deploy that carries
 * the var would silently overwrite the secret.
 *
 *   DISCORD_WEBHOOK_URL  the destination. Validated here, never logged, never stored.
 *   NOTIFICATIONS        only the exact string "on" enables sending. Absent means off.
 *
 * The four static states this module can name are decided WITHOUT D1. That is the inert
 * guarantee: in `unconfigured`, `invalid-url` and `off`, the notify step and `/api/status` return
 * before any query, so a Worker deployed ahead of migration 0007 cannot degrade monitoring or
 * 503 the status route. `webhook-rejected` is the fifth state and needs a read; it is derived in
 * status.ts, only once this module has said `on`.
 */

export interface NotifyEnvironment {
  DISCORD_WEBHOOK_URL?: string;
  NOTIFICATIONS?: string;
  APP_ENV?: string;
}

export type NotifyState = "unconfigured" | "invalid-url" | "off" | "on" | "webhook-rejected";

export type NotifyConfig =
  | { state: "unconfigured" | "invalid-url" | "off" }
  | { state: "on"; url: string };

/** The hosts Discord serves webhooks from. Exact match; no suffix matching. */
const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

/** `/api/webhooks/<numeric id>/<token>`, nothing after the token. */
const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

/**
 * Production: `https://<discord host>/api/webhooks/<digits>/<token>`, no port, no credentials, no
 * query and no fragment (the sender appends its own `?wait=true`).
 *
 * Local only (`APP_ENV === "local"`): also `http://127.0.0.1:<port>/...`, which is the e2e stub.
 * The exception is keyed on APP_ENV, which wrangler.jsonc sets to "production" for the deployed
 * Worker, so a production secret pointing at a loopback or plain-http URL is `invalid-url`.
 */
export const isValidWebhookUrl = (raw: string, appEnv: string | undefined): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // `.../x?` and `.../x#` parse with an EMPTY search and hash, so they pass the check below; the
  // URL that is sent is therefore rebuilt from the parse (`sendableUrl`), never the raw string.
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    return false;
  }

  if (
    url.protocol === "https:" &&
    url.port === "" &&
    DISCORD_HOSTS.has(url.hostname) &&
    WEBHOOK_PATH.test(url.pathname)
  ) {
    return true;
  }

  return (
    appEnv === "local" &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== ""
  );
};

/**
 * The URL the sender uses: origin + path from the validated parse. Sending the raw string would
 * turn `.../x?` into `.../x??wait=true`, which Discord answers 204 -- recorded as SENT although
 * `wait` never applied.
 */
export const sendableUrl = (raw: string): string => {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
};

/**
 * The precedence is fixed: no URL, then a bad URL, then the switch. A bad URL with the switch on
 * is `invalid-url`, not `on` -- the operator has to see the thing that is actually wrong.
 */
export const resolveNotifyConfig = (environment: NotifyEnvironment): NotifyConfig => {
  const raw = environment.DISCORD_WEBHOOK_URL?.trim();
  if (raw === undefined || raw === "") return { state: "unconfigured" };
  if (!isValidWebhookUrl(raw, environment.APP_ENV)) return { state: "invalid-url" };
  if (environment.NOTIFICATIONS !== "on") return { state: "off" };
  return { state: "on", url: sendableUrl(raw) };
};

/**
 * THE MASTER SWITCH (multi-user, PR3). `NOTIFICATIONS=on` enables the notify step for EVERY user;
 * anything else makes the step and `/api/status` inert, with no D1 query. The DISCORD_WEBHOOK_URL
 * secret is no longer the step's on/off: it is only the owner's fallback destination.
 */
export const notificationsOn = (environment: NotifyEnvironment): boolean =>
  environment.NOTIFICATIONS === "on";

export type Destination =
  | { state: "unconfigured" | "invalid-url" }
  | { state: "ok"; url: string };

/**
 * WHERE ONE USER'S ALERTS GO: their own `webhook_url` (migrations/0010); else, FOR USER 1 ONLY, the
 * DISCORD_WEBHOOK_URL secret, which keeps the owner's install exactly as it was. Re-validated here,
 * at use, and sent by the rebuilt URL -- a stored value that a deploy's APP_ENV no longer accepts
 * (a local stub URL in production) is `invalid-url`, never fetched. The URL is returned to the
 * sender and nowhere else.
 */
export const destinationFor = (
  user: { userId: number; webhookUrl: string | null },
  environment: NotifyEnvironment,
): Destination => {
  const own = user.webhookUrl?.trim();
  const raw =
    own !== undefined && own !== ""
      ? own
      : user.userId === 1
        ? environment.DISCORD_WEBHOOK_URL?.trim()
        : undefined;
  if (raw === undefined || raw === "") return { state: "unconfigured" };
  if (!isValidWebhookUrl(raw, environment.APP_ENV)) return { state: "invalid-url" };
  return { state: "ok", url: sendableUrl(raw) };
};
