/**
 * The collector credential: a bearer secret with no human behind it, admitted on ONE route.
 *
 * `authenticateRequest` admits exactly two identities -- a loopback-only development identity
 * and a Firebase ID token whose email is on APPROVED_EMAILS. This module is a THIRD identity
 * and it is deliberately NOT one of them: `authorizeCollector` returns `{ ok: true }`, never an
 * `AuthenticatedIdentity`, so nothing it admits can flow into /api/auth/session or be reported
 * as an `authenticationMethod`, and `authenticateRequest` is not edited by one line.
 *
 * COLLECTOR_TOKEN LIVES ON ITS OWN ENVIRONMENT TYPE, AND THAT IS A TRIPWIRE, NOT A PROHIBITION.
 * A direct `environment.COLLECTOR_TOKEN` inside a `WorkerEnvironment` function does not compile
 * (TS2339) -- which catches the careless edit. It is NOT a guarantee: `(e as any)`,
 * `(e as Record<string, unknown>)["COLLECTOR_TOKEN"]`, `(e as unknown as CollectorEnvironment)`
 * and widening one parameter to `WorkerEnvironment & CollectorEnvironment` ALL compile clean
 * under this repo's strict config, and eslint bans none of them (measured).
 * `worker/index.test.ts` X4 IS WHAT ENFORCES THE BOUNDARY. Do not delete X4 as redundant
 * because this type split "makes the leak impossible" -- it does not.
 */

import { configuredValue } from "./verifyFirebaseToken";

/** Separate from `WorkerEnvironment` on purpose. See the module comment. */
export interface CollectorEnvironment {
  /** A Worker secret. Never a `vars` entry, never committed. */
  COLLECTOR_TOKEN?: string;
}

/**
 * 32 characters, which is `openssl rand -hex 32` halved and then some -- the documented
 * generator emits 64. A configured value below this is a setup mistake, and a setup mistake
 * must be a loud 503 rather than a route that works with a guessable secret.
 * Pinned directly by T7: every behavioural test would pass with another value.
 */
export const MIN_COLLECTOR_TOKEN_LENGTH = 32;

/**
 * A CUSTOM header, not `Authorization: Bearer`. With `Authorization` this secret would be
 * parsed by `authenticateRequest`'s bearer regex on every other route and the two credential
 * systems would be one `if` away from converging. MEASURED: the correct token presented in
 * `Authorization` answers 401 AUTH_TOKEN_MISSING here (T5) and 401 AUTH_TOKEN_INVALID there.
 */
export const COLLECTOR_TOKEN_HEADER = "X-Collector-Token";

export type CollectorAuthResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code:
        | "CORS_ORIGIN_DENIED"
        | "COLLECTOR_CONFIG_MISSING"
        | "COLLECTOR_CONFIG_INVALID"
        | "AUTH_TOKEN_MISSING"
        | "AUTH_TOKEN_INVALID";
    };

const encoder = new TextEncoder();

/**
 * SHA-256 both sides, then XOR the two 32-byte digests. The loop length is 32 whatever the
 * inputs are, so neither the length nor the content of the presented value steers it.
 *
 * `crypto.subtle.timingSafeEqual` is rejected: it is workerd-only and absent in Node, where
 * every worker test in this repo runs.
 *
 * MEASURED, and it is why the config check runs BEFORE this function is ever reached:
 * `timingSafeEqualStrings("", "")` is TRUE. An unset secret plus a missing header would open
 * the route if the order were the other way round.
 */
export const timingSafeEqualStrings = async (a: string, b: string): Promise<boolean> => {
  const [first, second] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(first);
  const right = new Uint8Array(second);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
};

/**
 * THE GATE ORDER IS THE DESIGN. Each step's reason:
 *
 * 1. Any `Origin` header at all is refused, before the token is read. Browsers append `Origin`
 *    to every non-GET/HEAD request -- the real origin, or the literal "null" -- so refusing it
 *    makes "no ingest response ever carries Access-Control-Allow-Origin" structural rather than
 *    incidental. Node `fetch` and curl send none. In practice only an ALLOWED origin reaches
 *    this line: `handleRequest`'s pre-existing CORS block already refuses every other one with
 *    the same 403 CORS_ORIGIN_DENIED, which is why index.test.ts X6(a) -- the allowed-origin
 *    row -- is the only test that can kill this check.
 * 2/3. Configuration BEFORE the comparison, for the `("", "")` reason above. The two codes are
 *    NEW and distinct from AUTH_CONFIG_MISSING / AUTH_CONFIG_INVALID, which `readAllowedOrigins`
 *    and `authenticateRequest` already return: three different fixes behind one code sends an
 *    operator to the wrong one.
 * 4/5. The REQUEST-level codes stay shared with the Firebase path deliberately, so a prober
 *    cannot tell from a 401 which credential system it is probing.
 *
 * Anyone can elicit the 503s, including a caller with no header at all. That is accepted: they
 * say only that the route is unconfigured, and unconfigured means there is no credential to
 * guess.
 */
export const authorizeCollector = async (
  request: Request,
  environment: CollectorEnvironment,
): Promise<CollectorAuthResult> => {
  if (request.headers.get("Origin") !== null) {
    return { ok: false, status: 403, code: "CORS_ORIGIN_DENIED" };
  }

  const configured = configuredValue(environment.COLLECTOR_TOKEN);
  if (configured === null) {
    return { ok: false, status: 503, code: "COLLECTOR_CONFIG_MISSING" };
  }
  if (configured.length < MIN_COLLECTOR_TOKEN_LENGTH) {
    return { ok: false, status: 503, code: "COLLECTOR_CONFIG_INVALID" };
  }

  const presented = request.headers.get(COLLECTOR_TOKEN_HEADER);
  if (presented === null) {
    return { ok: false, status: 401, code: "AUTH_TOKEN_MISSING" };
  }
  if (!(await timingSafeEqualStrings(presented, configured))) {
    return { ok: false, status: 401, code: "AUTH_TOKEN_INVALID" };
  }

  return { ok: true };
};
