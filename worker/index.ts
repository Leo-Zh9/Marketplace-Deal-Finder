import {
  authenticateRequest,
  configuredValue,
  type AuthDependencies,
  type WorkerEnvironment,
} from "./auth/verifyFirebaseToken";
import { handleScheduled, type ScheduledEnvironment } from "./scheduling/scheduled";

/**
 * NOT WIDENED to include DB or CLEANUP_WORKFLOW. `Environment` is the request path's
 * environment, and `worker/index.test.ts` builds literals of it. The scheduled path names
 * its own `ScheduledEnvironment`; the runtime hands both the same object.
 */
export type Environment = WorkerEnvironment;

/**
 * wrangler binds a Workflow to a class exported FROM THE MAIN ENTRY, so this re-export is
 * not tidiness -- without it `wrangler deploy` fails, and with the wrong name it deploys a
 * Cron that fires daily and does nothing. scheduled.test.ts S3 asserts config and entry
 * agree.
 */
export { CleanupWorkflow } from "./scheduling/cleanupWorkflow";

// Content-Type is added by `json` only: a 204 preflight carries no body.
const securityHeaders = {
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const ALLOWED_PREFLIGHT_METHOD = "GET";
const ALLOWED_PREFLIGHT_HEADERS = new Set(["authorization", "accept"]);

const errorMessages: Record<string, string> = {
  AUTH_TOKEN_MISSING: "Authentication is required.",
  AUTH_TOKEN_INVALID: "The authentication token is not valid.",
  AUTH_FORBIDDEN: "This account is not approved for access.",
  CORS_ORIGIN_DENIED: "This origin is not allowed to call the API.",
  AUTH_CONFIG_MISSING: "The service is not configured.",
  AUTH_CONFIG_INVALID: "The service configuration is not usable.",
  AUTH_KEYS_UNAVAILABLE: "Identity verification is temporarily unavailable.",
  NOT_FOUND: "Not found.",
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

const errorResponse = (code: string, status: number, extra: ExtraHeaders = {}) =>
  json({ error: { code, message: errorMessages[code] } }, status, extra);

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
    if (request.headers.get("Access-Control-Request-Method") !== ALLOWED_PREFLIGHT_METHOD) {
      return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
    }

    const requestedHeaders = request.headers.get("Access-Control-Request-Headers") ?? "";
    const requested = requestedHeaders
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== "");
    if (requested.some((name) => !ALLOWED_PREFLIGHT_HEADERS.has(name))) {
      return errorResponse("CORS_ORIGIN_DENIED", 403, { Vary: "Origin" });
    }

    return new Response(null, {
      status: 204,
      headers: {
        ...securityHeaders,
        "Access-Control-Allow-Origin": allowedOrigin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Accept",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  const cors: ExtraHeaders =
    allowedOrigin === null
      ? { Vary: "Origin" }
      : { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" };

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
