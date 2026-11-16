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
 * The precedence is fixed: no URL, then a bad URL, then the switch. A bad URL with the switch on
 * is `invalid-url`, not `on` -- the operator has to see the thing that is actually wrong.
 */
export const resolveNotifyConfig = (environment: NotifyEnvironment): NotifyConfig => {
  const raw = environment.DISCORD_WEBHOOK_URL?.trim();
  if (raw === undefined || raw === "") return { state: "unconfigured" };
  if (!isValidWebhookUrl(raw, environment.APP_ENV)) return { state: "invalid-url" };
  if (environment.NOTIFICATIONS !== "on") return { state: "off" };
  return { state: "on", url: raw };
};
