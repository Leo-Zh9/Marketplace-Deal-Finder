import {
  authenticateRequest,
  configuredValue,
  type AuthDependencies,
  type WorkerEnvironment,
} from "./auth/verifyFirebaseToken";
import { authorizeCollector, type CollectorEnvironment } from "./auth/collectorToken";
import { handlePostListings } from "./api/listings";
import { handleGetSettings, handlePutSettings } from "./api/settings";
import { handleGetVerdicts } from "./api/verdicts";
import { handleGetWatch, handlePutWatch } from "./api/watch";
import { handleGetWatchTargets } from "./api/watchTargets";
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
  ["/api/verdicts", ["GET"]],
  /**
   * THE BROWSER'S WATCH-LIST ROUTE, and it is a different route from `/api/watch-targets` on a
   * different credential. This row is what makes `OPTIONS /api/watch` answer 204 advertising
   * `GET, PUT, OPTIONS` and -- because PUT is a body method, through `preflightHeadersFor` and
   * nothing else -- `Content-Type`. Without it the browser cannot save cross-origin in production
   * while every curl check and every unit test still passes, because curl never preflights and
   * `npm run dev` reaches the Worker through Vite's same-origin /api proxy. X-w1 is the guard.
   */
  ["/api/watch", ["GET", "PUT"]],
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
  // Distinct from SETTINGS_STORAGE_FAILED and INGEST_STORAGE_FAILED for the reason the
  // COLLECTOR_CONFIG_* comment above already gives: three different fixes behind one code sends
  // an operator to the wrong one.
  WATCH_TARGETS_STORAGE_FAILED: "The watch list could not be read.",
  // DISTINCT FROM THE LINE ABOVE ON PURPOSE, and the distinction is the same one the three
  // COLLECTOR_CONFIG_* and *_STORAGE_FAILED codes already draw: that one means the READ failed,
  // this one means the BATCH failed. One sends an operator to the read path, the other to the
  // write -- and collapsing them would put two fixes behind one code.
  WATCH_STORAGE_FAILED: "The watch list could not be written.",
  // NOT SETTINGS_FIELD_UNSUPPORTED's message: these are two different request bodies with two
  // different field sets, and an operator reading "fields this API cannot store" on a watch save
  // would go looking in search_revisions.
  WATCH_FIELD_UNSUPPORTED: "The watch list request contains fields this API cannot store.",
  INVALID_WATCH: "The watch list in the request is not valid.",
  // The cap REFUSES rather than truncating, at the collector as well as here: a list over the cap
  // collects NOTHING on every run, so saving 10 and running 9 would be the worse answer.
  WATCH_TARGETS_EXCEEDED: "The watch list would hold more searches than the collector can run.",
  INVALID_VERDICTS_QUERY: "The component or model filter in the request is not valid.",
  VERDICTS_STORAGE_FAILED: "The evaluated listings could not be read.",
  // DISTINCT FROM THE LINE ABOVE ON PURPOSE: that one means the read failed, this one means the
  // read succeeded and every row was unpresentable. One sends an operator to D1, the other to
  // the catalog and the collector.
  VERDICTS_ROWS_UNUSABLE: "No stored listing could be presented.",
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

  // THE WATCH LIST IS READ ON THE COLLECTOR CREDENTIAL, for the same reason the ingest route is
  // written on it: `authenticateRequest` admits exactly a loopback-only development identity and
  // a Firebase ID token on APPROVED_EMAILS, and a headless `node collector/main.ts` on the
  // operator's Mac reaching a public Worker is NEITHER. Reading its own configuration is
  // strictly LESS privileged than the write the same token already buys, and it keeps the two
  // credential systems disjoint in both directions.
  //
  // `/api/watch-targets` is ABSENT FROM ROUTE_METHODS for the reason X6c records for
  // `/api/listings`: that table is the ADVERTISED BROWSER SURFACE and feeds only the OPTIONS
  // preflight. Adding a row would make `OPTIONS /api/watch-targets` answer 204 advertising
  // `GET, OPTIONS` -- a real browser channel -- while every existing test stayed green. X-a is
  // the only guard on that.
  //
  // COLLECTOR_TOKEN IS REACHED THROUGH `authorizeCollector(request, environment)` AND NOTHING
  // ELSE. It lives on `CollectorEnvironment` so that a direct read inside a `WorkerEnvironment`
  // function does not compile. Do not widen a parameter or cast to reach it.
  if (request.method === "GET" && url.pathname === "/api/watch-targets") {
    const authorized = await authorizeCollector(request, environment);
    if (!authorized.ok) {
      return errorResponse(authorized.code, authorized.status, { Vary: "Origin" });
    }

    const db = environment.DB;
    if (db === undefined) return errorResponse("DATABASE_UNAVAILABLE", 503, { Vary: "Origin" });

    const result = await handleGetWatchTargets(db);

    // `{ Vary: "Origin" }`, NEVER `cors`: `authorizeCollector` refuses a request bearing ANY
    // Origin, so no watch-list response can ever carry Access-Control-Allow-Origin. X-e pins it
    // on every outcome.
    return result.ok
      ? json(result.body, result.status, { Vary: "Origin" })
      : errorResponse(result.code, result.status, { Vary: "Origin" });
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

  if (request.method === "GET" && url.pathname === "/api/verdicts") {
    const db = environment.DB;
    if (db === undefined) return errorResponse("DATABASE_UNAVAILABLE", 503, cors);

    const result = await handleGetVerdicts(db, url.searchParams);

    return result.ok
      ? json(result.body, result.status, cors)
      : errorResponse(result.code, result.status, cors, result.details);
  }

  /**
   * `/api/watch` IS A BROWSER ROUTE AND `/api/watch-targets` IS NOT, and the two credential
   * systems stay disjoint in both directions. This one sits BELOW `authenticateRequest`, so it
   * admits exactly the loopback development identity and a Firebase ID token on APPROVED_EMAILS
   * -- the same two every other browser route admits -- and a collector token buys nothing here
   * (X-w2). The collector's own route stays above, on `authorizeCollector`, and stays OUT of
   * ROUTE_METHODS (X-w3).
   *
   * THE DB GUARD IS BEFORE THE HANDLER AND THEREFORE BEFORE ANY VALIDATION, which is why a
   * missing binding is 503 DATABASE_UNAVAILABLE and no request body reaches an unguarded path.
   */
  if (url.pathname === "/api/watch" && (request.method === "GET" || request.method === "PUT")) {
    const db = environment.DB;
    if (db === undefined) return errorResponse("DATABASE_UNAVAILABLE", 503, cors);

    const result =
      request.method === "GET" ? await handleGetWatch(db) : await handlePutWatch(request, db);

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
