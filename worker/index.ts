import {
  authenticateRequest,
  configuredValue,
  type AuthDependencies,
  type WorkerEnvironment,
} from "./auth/verifyFirebaseToken";
import { authorizeCollector, type CollectorEnvironment } from "./auth/collectorToken";
import { handlePostListings } from "./api/listings";
import { handleGetSettings, handlePutSettings } from "./api/settings";
import { handleScheduled, type ScheduledEnvironment } from "./scheduling/scheduled";

/**
 * Widened by exactly one member, and that member is OPTIONAL. `Environment` is the request
 * path's environment and `worker/index.test.ts` builds 16 literals of it, so a required `DB`
 * would break all of them on typecheck; `DB?` is what lets the settings route read a binding
 * without touching a single merged literal, and it is why a MISSING binding is a runtime 503
 * (`DATABASE_UNAVAILABLE`, pinned by W6) rather than a compile error. `CLEANUP_WORKFLOW` and
 * `MONITOR_WORKFLOW` stay OUT: the scheduled path names its own `ScheduledEnvironment`, and
 * the runtime hands both the same object.
 */
export type Environment = WorkerEnvironment & { DB?: D1Database } & CollectorEnvironment;

/**
 * wrangler binds a Workflow to a class exported FROM THE MAIN ENTRY, so this re-export is
 * not tidiness -- without it `wrangler deploy` fails, and with the wrong name it deploys a
 * Cron that fires daily and does nothing. scheduled.test.ts S3 asserts config and entry
 * agree.
 */
export { CleanupWorkflow } from "./scheduling/cleanupWorkflow";
export { MonitorWorkflow } from "./scheduling/monitorWorkflow";

// Content-Type is added by `json` only: a 204 preflight carries no body.
const securityHeaders = {
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/**
 * THE ADVERTISED SURFACE IS THIS TABLE, and it is scoped BY PATH.
 */
export const ROUTE_METHODS = new Map<string, readonly string[]>([
  ["/api/auth/session", ["GET"]],
  ["/api/status", ["GET"]],
  ["/api/settings", ["GET", "PUT"]],
]);

const BODY_METHODS = new Set(["PUT", "POST", "PATCH"]);
const BASE_PREFLIGHT_HEADERS = ["Authorization", "Accept"] as const;
const BODY_PREFLIGHT_HEADERS = ["Content-Type"] as const;

/**
 * Content-Type is offered to a path IF AND ONLY IF that path declares a body-bearing
 * method. Exported so the rule can be tested over method sets the table does not yet
 * contain -- three rows cannot tell this rule apart from `methods.length > 1`.
 */
export const preflightHeadersFor = (methods: readonly string[]): readonly string[] =>
  methods.some((method) => BODY_METHODS.has(method))
    ? [...BASE_PREFLIGHT_HEADERS, ...BODY_PREFLIGHT_HEADERS]
    : BASE_PREFLIGHT_HEADERS;

const errorMessages: Record<string, string> = {
  AUTH_TOKEN_MISSING: "Authentication is required.",
  AUTH_TOKEN_INVALID: "The authentication token is not valid.",
  AUTH_FORBIDDEN: "This account is not approved for access.",
  CORS_ORIGIN_DENIED: "This origin is not allowed to call the API.",
  AUTH_CONFIG_MISSING: "The service is not configured.",
  AUTH_CONFIG_INVALID: "The service configuration is not usable.",
  AUTH_KEYS_UNAVAILABLE: "Identity verification is temporarily unavailable.",
  NOT_FOUND: "Not found.",
  DATABASE_UNAVAILABLE: "The database is not configured.",
  SETTINGS_STORAGE_FAILED: "The settings could not be read or written.",
  UNSUPPORTED_MEDIA_TYPE: "The request body must be application/json.",
  PAYLOAD_TOO_LARGE: "The request body is too large.",
  INVALID_JSON: "The request body is not a JSON object.",
  INVALID_SETTINGS: "The settings in the request are not valid.",
  SETTINGS_FIELD_UNSUPPORTED: "The request contains fields this API cannot store.",
  // Distinct from AUTH_CONFIG_MISSING / AUTH_CONFIG_INVALID on purpose: those already stand for
  // an unset ALLOWED_ORIGINS and an unset FIREBASE_PROJECT_ID, and three different fixes behind
  // one code sends an operator to the wrong one.
  COLLECTOR_CONFIG_MISSING: "The collector credential is not configured.",
  COLLECTOR_CONFIG_INVALID: "The collector credential is not usable.",
  INGEST_EMPTY_BATCH: "The request contains no listings.",
  INGEST_BATCH_TOO_LARGE: "The request contains too many listings.",
  INVALID_LISTINGS: "The listings in the request are not valid.",
  INGEST_STORAGE_FAILED: "The listings could not be stored.",
};

type ExtraHeaders = Record<string, string>;

const json = (body: unknown, status: number, extra: ExtraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...securityHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });

const errorResponse = (
  code: string,
  status: number,
  extra: ExtraHeaders = {},
  details: Record<string, unknown> = {},
) => json({ error: { ...details, code, message: errorMessages[code] } }, status, extra);

const readAllowedOrigins = (
  environment: Environment,
):
  | { ok: true; origins: string[] }
  | { ok: false; code: "AUTH_CONFIG_MISSING" | "AUTH_CONFIG_INVALID" } => {
  const configured = configuredValue(environment.ALLOWED_ORIGINS);
  if (configured === null) return { ok: false, code: "AUTH_CONFIG_MISSING" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    return { ok: false, code: "AUTH_CONFIG_INVALID" };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, code: "AUTH_CONFIG_INVALID" };
  }

  const origins: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") return { ok: false, code: "AUTH_CONFIG_INVALID" };

    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return { ok: false, code: "AUTH_CONFIG_INVALID" };
    }

    // One identity test rejects trailing slashes, paths, wildcards and "null".
    if (url.origin !== entry) return { ok: false, code: "AUTH_CONFIG_INVALID" };
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, code: "AUTH_CONFIG_INVALID" };
    }

    origins.push(entry);
  }

  return { ok: true, origins };
};

export const handleRequest = async (
  request: Request,
  environment: Environment,
  dependencies?: AuthDependencies,
): Promise<Response> => {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/api/")) {
    return errorResponse("NOT_FOUND", 404);
  }

  // Origin configuration is validated for every /api/* request, local ones
  // included, so a direct no-Origin call still reads the diagnostic body.
  const originConfig = readAllowedOrigins(environment);
  if (!originConfig.ok) {
    return errorResponse(originConfig.code, 503, { Vary: "Origin" });
  }

  const origin = request.headers.get("Origin");
  const allowedOrigin =
    origin !== null && originConfig.origins.includes(origin) ? origin : null;

  if (origin !== null && allowedOrigin === null) {
    return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
  }

  if (request.method === "OPTIONS") {
    if (allowedOrigin === null) {
      return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
    }
    // PATH-SCOPED. A global allowance would let /api/status advertise PUT the moment
    // /api/settings needed it, and every future GET-only route would inherit a
    // browser-usable mutating channel it never asked for.
    const methods = ROUTE_METHODS.get(url.pathname);
    if (methods === undefined) {
      return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
    }
    if (!methods.includes(request.headers.get("Access-Control-Request-Method") ?? "")) {
      return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
    }

    // ONE list feeds both the enforcement set and the advertised string, so what the
    // preflight accepts and what it advertises cannot drift. Content-Type is added only for
    // a path that actually takes a body.
    const headerNames = preflightHeadersFor(methods);
    const allowedHeaders = new Set(headerNames.map((name) => name.toLowerCase()));

    const requestedHeaders = request.headers.get("Access-Control-Request-Headers") ?? "";
    const requested = requestedHeaders
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== "");
    if (requested.some((name) => !allowedHeaders.has(name))) {
      return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
    }

    return new Response(null, {
      status: 204,
      headers: {
        ...securityHeaders,
        "Access-Control-Allow-Origin": allowedOrigin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": [...methods, "OPTIONS"].join(", "),
        "Access-Control-Allow-Headers": headerNames.join(", "),
        "Access-Control-Max-Age": "600",
      },
    });
  }

  const cors: ExtraHeaders =
    allowedOrigin === null
      ? { Vary: "Origin" }
      : { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" };

  // THE INGEST ROUTE IS DELIBERATELY NOT BEHIND authenticateRequest. It admits exactly ONE
  // identity -- the collector secret -- and every other route admits exactly the two it
  // admitted before. The two sets are disjoint in BOTH directions, and TESTS are what enforce
  // that, not the type system: X4 proves a collector token buys nothing on the Firebase routes,
  // X1 and X10 prove that neither the loopback development identity nor a Firebase token opens
  // this one. DO NOT delete X4 because CollectorEnvironment "makes it impossible" -- it does
  // not; three casts and a one-word parameter widening all compile.
  //
  // `/api/listings` is NOT in ROUTE_METHODS, which inverts W10's stated norm. That is
  // deliberate and flagged: the table is the ADVERTISED BROWSER SURFACE and feeds only the
  // OPTIONS preflight. MEASURED: adding the row makes OPTIONS /api/listings answer 204
  // advertising "POST, OPTIONS" -- a real browser channel -- while every existing test in this
  // file still passes. X6(c) is the only guard on that.
  if (request.method === "POST" && url.pathname === "/api/listings") {
    const authorized = await authorizeCollector(request, environment);
    if (!authorized.ok) {
      return errorResponse(authorized.code, authorized.status, { Vary: "Origin" });
    }

    const db = environment.DB;
    if (db === undefined) return errorResponse("DATABASE_UNAVAILABLE", 503, { Vary: "Origin" });

    const result = await handlePostListings(
      request,
      db,
      dependencies?.now() ?? Math.floor(Date.now() / 1000),
    );

    // `{ Vary: "Origin" }`, NEVER `cors`: a request carrying ANY Origin was refused above, so no
    // ingest response can ever carry Access-Control-Allow-Origin. X7 pins it on every outcome.
    return result.ok
      ? json(result.body, result.status, { Vary: "Origin" })
      : errorResponse(result.code, result.status, { Vary: "Origin" }, result.details);
  }

  const authentication = await authenticateRequest(request, environment, dependencies);
  if (!authentication.ok) {
    return errorResponse(authentication.code, authentication.status, cors);
  }

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return json({ identity: authentication.identity }, 200, cors);
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    return json(
      {
        status: "ok",
        phase: 2,
        authentication: authentication.identity.authenticationMethod,
      },
      200,
      cors,
    );
  }

  if (
    url.pathname === "/api/settings" &&
    (request.method === "GET" || request.method === "PUT")
  ) {
    const db = environment.DB;
    if (db === undefined) return errorResponse("DATABASE_UNAVAILABLE", 503, cors);

    const result =
      request.method === "GET"
        ? await handleGetSettings(db)
        : await handlePutSettings(
            request,
            db,
            dependencies?.now() ?? Math.floor(Date.now() / 1000),
          );

    return result.ok
      ? json(result.body, result.status, cors)
      : errorResponse(result.code, result.status, cors, result.details);
  }

  return errorResponse("NOT_FOUND", 404, cors);
};

// Written out explicitly: the Workers runtime passes ExecutionContext as the
// third argument, which `fetch: handleRequest` would read as `dependencies`.
export default {
  fetch: (request: Request, environment: Environment) =>
    handleRequest(request, environment),
  // The Cron entry point. The return value is discarded by the runtime, so it is dropped
  // here rather than pretended to matter; `handleScheduled` returns it for the tests.
  scheduled: async (
    controller: ScheduledController,
    environment: ScheduledEnvironment,
  ): Promise<void> => {
    await handleScheduled(controller, environment);
  },
};
