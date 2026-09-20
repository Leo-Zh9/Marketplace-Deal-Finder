import {
  authenticateRequest,
  type AccessEnvironment,
  type AuthenticationResult,
} from "./auth/verifyAccess";

export type Environment = AccessEnvironment;

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders,
  });

const authenticationFailure = (
  result: Extract<AuthenticationResult, { ok: false }>,
) => json({ error: { code: result.code, message: "Access denied." } }, result.status);

export const handleRequest = async (request: Request, environment: Environment) => {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/api/")) {
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  }

  const authentication = await authenticateRequest(request, environment);
  if (!authentication.ok) return authenticationFailure(authentication);

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return json({ identity: authentication.identity });
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    return json({
      status: "ok",
      phase: 2,
      authentication: authentication.identity.authenticationMethod,
    });
  }

  return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
};

export default {
  fetch: handleRequest,
};
