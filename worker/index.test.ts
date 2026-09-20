// @vitest-environment node

import type { AuthDependencies } from "./auth/verifyFirebaseToken";
import worker, { handleRequest, type Environment } from "./index";
import { createTokenFactory, type TokenClaims } from "./testing/firebaseTokens";

const projectId = "deal-finder-test";
const pagesOrigin = "https://deal-finder.pages.dev";
const workerOrigin = "https://marketplace-deal-finder-api.example.workers.dev";
const now = 1_800_000_000;

let factory!: Awaited<ReturnType<typeof createTokenFactory>>;
let dependencies!: AuthDependencies;

beforeAll(async () => {
  factory = await createTokenFactory(projectId);
  dependencies = { keys: factory.keys, now: () => now };
});

const environment = (overrides: Partial<Environment> = {}): Environment => ({
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: projectId,
  ALLOWED_ORIGINS: JSON.stringify([pagesOrigin]),
  APPROVED_EMAILS: JSON.stringify(["owner@example.com"]),
  ...overrides,
});

const bearerFor = async (claims: Partial<TokenClaims> = {}) =>
  `Bearer ${await factory.sign({ now, ...claims })}`;

const call = (
  path: string,
  init: RequestInit = {},
  env: Environment = environment(),
  deps: AuthDependencies | undefined = dependencies,
) => handleRequest(new Request(`${workerOrigin}${path}`, init), env, deps);

describe("protected Worker API", () => {
  it("admits an approved Firebase identity and denies an unapproved one (reproduction)", async () => {
    const approvedEnvironment = environment({
      // Normalization is part of the contract.
      APPROVED_EMAILS: JSON.stringify(["  Owner@Example.com  "]),
    });

    const approved = await call(
      "/api/auth/session",
      {
        headers: {
          Authorization: await bearerFor({ email: "owner@example.com" }),
          Origin: pagesOrigin,
        },
      },
      approvedEnvironment,
    );

    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toEqual({
      identity: {
        email: "owner@example.com",
        subject: "firebase-uid-1",
        expiresAt: now + 3_600,
        authenticationMethod: "firebase-google",
      },
    });
    expect(approved.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);

    const stranger = await call(
      "/api/auth/session",
      {
        headers: {
          Authorization: await bearerFor({ email: "stranger@example.com" }),
          Origin: pagesOrigin,
        },
      },
      approvedEnvironment,
    );

    expect(stranger.status).toBe(403);
    await expect(stranger.json()).resolves.toEqual({
      error: {
        code: "AUTH_FORBIDDEN",
        message: "This account is not approved for access.",
      },
    });
  });

  it("answers a valid preflight without authenticating it", async () => {
    const preflight = await call("/api/auth/session", {
      method: "OPTIONS",
      headers: {
        Origin: pagesOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, accept",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);
    expect(preflight.headers.get("Vary")).toBe("Origin");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Accept",
    );
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    // A successful preflight authorizes nothing.
    const followUp = await call("/api/auth/session", {
      headers: { Origin: pagesOrigin },
    });
    expect(followUp.status).toBe(401);
    await expect(followUp.json()).resolves.toMatchObject({
      error: { code: "AUTH_TOKEN_MISSING" },
    });
    expect(followUp.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);
  });

  it("keeps 403 and 503 answers readable by an allowed origin", async () => {
    const denied = await call("/api/status", {
      headers: {
        Authorization: await bearerFor({ email: "stranger@example.com" }),
        Origin: pagesOrigin,
      },
    });
    const unconfigured = await call(
      "/api/status",
      { headers: { Origin: pagesOrigin } },
      environment({ FIREBASE_PROJECT_ID: undefined }),
    );

    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);
  });

  it.each([
    "https://other.pages.dev",
    "https://deal-finder.pages.dev.evil.com",
    "http://deal-finder.pages.dev",
    "https://deal-finder.pages.dev:8443",
    "null",
  ])("denies the unapproved origin %s on GET and OPTIONS", async (origin) => {
    const get = await call("/api/status", {
      headers: { Origin: origin, Authorization: await bearerFor() },
    });
    const preflight = await call("/api/status", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });

    for (const response of [get, preflight]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "CORS_ORIGIN_DENIED" },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it.each([
    ["a disallowed method", { "Access-Control-Request-Method": "POST" }],
    [
      "an unknown requested header",
      { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-custom" },
    ],
    [
      "a mixed requested header list",
      {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, x-custom",
      },
    ],
  ])("denies a preflight with %s", async (_label, headers) => {
    const response = await call("/api/status", {
      method: "OPTIONS",
      headers: { Origin: pagesOrigin, ...headers },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CORS_ORIGIN_DENIED" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("denies an OPTIONS request that carries no Origin", async () => {
    const response = await call("/api/status", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "GET" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CORS_ORIGIN_DENIED" },
    });
  });

  it.each([
    ["absent", undefined, "AUTH_CONFIG_MISSING"],
    ["a placeholder", "REPLACE_WITH_ALLOWED_ORIGINS_JSON_ARRAY", "AUTH_CONFIG_MISSING"],
    ["empty", "[]", "AUTH_CONFIG_INVALID"],
    ["not JSON", "not json", "AUTH_CONFIG_INVALID"],
    ["a wildcard", '["*"]', "AUTH_CONFIG_INVALID"],
    ["trailing-slashed", '["https://x.pages.dev/"]', "AUTH_CONFIG_INVALID"],
    ["a path", '["https://x.pages.dev/app"]', "AUTH_CONFIG_INVALID"],
    ["a foreign scheme", '["ftp://x"]', "AUTH_CONFIG_INVALID"],
  ])(
    "fails closed when ALLOWED_ORIGINS is %s",
    async (_label, allowedOrigins, code) => {
      const env = environment({ ALLOWED_ORIGINS: allowedOrigins });

      const get = await call(
        "/api/status",
        { headers: { Origin: pagesOrigin, Authorization: await bearerFor() } },
        env,
      );
      const preflight = await call(
        "/api/status",
        {
          method: "OPTIONS",
          headers: { Origin: pagesOrigin, "Access-Control-Request-Method": "GET" },
        },
        env,
      );

      for (const response of [get, preflight]) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ error: { code } });
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
    },
  );

  it("still requires origin configuration in local development", async () => {
    const response = await handleRequest(
      new Request("http://localhost:8787/api/status"),
      { APP_ENV: "local" },
      dependencies,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_CONFIG_MISSING" },
    });
  });

  it("authenticates requests that carry no Origin at all", async () => {
    const anonymous = await call("/api/status", {});
    const approved = await call("/api/status", {
      headers: { Authorization: await bearerFor() },
    });

    expect(anonymous.status).toBe(401);
    expect(approved.status).toBe(200);
    expect(approved.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("authenticates before routing, including unknown API paths", async () => {
    const unauthenticated = await call("/api/nope", {});
    const authenticated = await call("/api/nope", {
      headers: { Authorization: await bearerFor() },
    });

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(404);
    await expect(authenticated.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("never authenticates a non-API path", async () => {
    const now = vi.fn(() => 0);
    const response = await call(
      "/not-api",
      {},
      environment(),
      { keys: { getKey: () => Promise.reject(new Error("unreachable")) }, now },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBeNull();
    expect(now).not.toHaveBeenCalled();
  });

  it.each([
    ["firebase-google", undefined],
    ["local-development", "local"],
  ])("reports %s on the status endpoint", async (method, appEnv) => {
    const response =
      appEnv === "local"
        ? await handleRequest(
            new Request("http://localhost:8787/api/status"),
            { APP_ENV: "local", ALLOWED_ORIGINS: JSON.stringify(["http://localhost:5173"]) },
            dependencies,
          )
        : await call("/api/status", { headers: { Authorization: await bearerFor() } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      phase: 2,
      authentication: method,
    });
  });

  it("leaks neither the email nor the token in a denial", async () => {
    const authorization = await bearerFor({ email: "owner@example.com" });
    const token = authorization.slice("Bearer ".length);
    // The allowlist deliberately excludes the token's email.
    const response = await call(
      "/api/status",
      { headers: { Authorization: `Bearer ${token}`, Origin: pagesOrigin } },
      environment({ APPROVED_EMAILS: JSON.stringify(["someone-else@example.com"]) }),
    );

    const serialized = JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.json(),
    });

    expect(response.status).toBe(403);
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain(token.split(".")[2]);
  });

  it.each([
    ["a success", async () => call("/api/status", { headers: { Authorization: await bearerFor() } })],
    ["an unauthenticated failure", () => call("/api/status", {})],
    [
      "a configuration failure",
      () => call("/api/status", {}, environment({ FIREBASE_PROJECT_ID: undefined })),
    ],
  ])("keeps the security headers on %s", async (_label, build) => {
    const response = await build();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("ignores the runtime's ExecutionContext argument", async () => {
    // The runtime passes ExecutionContext third; `fetch: handleRequest` would
    // read it as `dependencies` and blow up on `dependencies.now()`.
    const runtimeFetch = worker.fetch as unknown as (
      request: Request,
      environment: Environment,
      context: unknown,
    ) => Promise<Response>;

    const response = await runtimeFetch(
      new Request("http://localhost:8787/api/status"),
      { APP_ENV: "local", ALLOWED_ORIGINS: JSON.stringify(["http://localhost:5173"]) },
      {},
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      phase: 2,
      authentication: "local-development",
    });
  });
});
