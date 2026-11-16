/**
 * ONE POST TO THE WEBHOOK, REDUCED TO WHAT classifyResponse NEEDS.
 *
 * `?wait=true` makes Discord answer 200 with the created message, so a 2xx is an acknowledged
 * delivery; without it Discord answers 204 before the message exists.
 *
 * The payload carries two guards on every message, whatever the content:
 *   - `allowed_mentions: {parse: []}`: no @everyone, @here, role or user ping can fire.
 *   - `flags: 4` (SUPPRESS_EMBEDS): no link in the message unfurls into a preview.
 *
 * `redirect: "manual"`: a webhook never redirects, and following one would re-POST the message to
 * a host nobody validated. A 3xx comes back as a response and is classified as a failure.
 *
 * THE URL IS NEVER LOGGED OR RETURNED. Errors are reduced to `timeout` / `network` with no
 * message, because a fetch error's message can quote the URL, and the URL is the credential.
 */

export const NOTIFY_FETCH_TIMEOUT_MS = 10_000;

/** SUPPRESS_EMBEDS. */
export const SUPPRESS_EMBEDS = 4;

export type NotifyFetch = (input: string, init: RequestInit) => Promise<Response>;

export type DeliveryOutcome =
  | {
      kind: "response";
      status: number;
      /** Seconds, from the body's `retry_after` or the Retry-After header; null when absent. */
      retryAfterSeconds: number | null;
      /** True when the response carried `X-RateLimit-Remaining: 0`. */
      bucketEmpty: boolean;
      /** Discord's numeric JSON error `code`, when the body had one. */
      errorCode: number | null;
    }
  | { kind: "timeout" }
  | { kind: "network" };

export const webhookPayload = (content: string) => ({
  content,
  allowed_mentions: { parse: [] as string[] },
  flags: SUPPRESS_EMBEDS,
});

const finiteNonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const deliver = async (
  fetchFn: NotifyFetch,
  url: string,
  content: string,
  timeoutMs: number = NOTIFY_FETCH_TIMEOUT_MS,
): Promise<DeliveryOutcome> => {
  let response: Response;
  try {
    response = await fetchFn(`${url}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload(content)),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "network" };
  }

  const bucketEmpty = response.headers.get("X-RateLimit-Remaining") === "0";
  const headerRetry = Number.parseFloat(response.headers.get("Retry-After") ?? "");

  // A 2xx is already the answer; its body is the created message and is not needed. Reading it
  // could only turn a delivered message into a thrown error, so it is released unread.
  if (response.status >= 200 && response.status < 300) {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to do: the status is what was measured.
    }
    return { kind: "response", status: response.status, retryAfterSeconds: null, bucketEmpty, errorCode: null };
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }

  const retryAfterSeconds =
    finiteNonNegative(body?.retry_after) ?? finiteNonNegative(headerRetry);
  const code = body?.code;
  return {
    kind: "response",
    status: response.status,
    retryAfterSeconds,
    bucketEmpty,
    errorCode: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
  };
};
