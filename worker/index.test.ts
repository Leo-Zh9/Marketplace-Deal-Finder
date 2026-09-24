// @vitest-environment node

import type { AuthDependencies } from "./auth/verifyFirebaseToken";
import worker, {
  handleRequest,
  preflightHeadersFor,
  ROUTE_METHODS,
  type Environment,
} from "./index";
import { createTestDatabase, truncateAll, type TestDatabase } from "./testing/d1";
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

/**
 * The mutating route widens a boundary that until now answered exactly one method. These
 * tests are about the WIDTH of that widening, not about what the handler stores.
 */
describe("the mutating route's CORS and auth boundary", () => {
  /** Any touch is a failure: auth and the origin check both run before the handler. */
  const untouchableDb = () =>
    ({
      prepare: () => {
        throw new Error("the database must not be reached");
      },
      batch: () => {
        throw new Error("the database must not be reached");
      },
    }) as unknown as D1Database;

  const preflight = (
    path: string,
    headers: Record<string, string>,
    env: Environment = environment(),
  ) => call(path, { method: "OPTIONS", headers: { Origin: pagesOrigin, ...headers } }, env);

  it("W1: advertises GET, PUT and Content-Type on the settings path and nowhere else", async () => {
    const settings = await preflight("/api/settings", {
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "authorization, content-type",
    });

    expect(settings.status).toBe(204);
    expect(settings.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);
    expect(settings.headers.get("Access-Control-Allow-Methods")).toBe("GET, PUT, OPTIONS");
    expect(settings.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Accept, Content-Type",
    );
    expect(settings.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const status = await preflight("/api/status", { "Access-Control-Request-Method": "GET" });
    expect(status.status).toBe(204);
    expect(status.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(status.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Accept");
  });

  it.each([
    ["PUT on a read-only path", "/api/status", { "Access-Control-Request-Method": "PUT" }],
    [
      "PUT on the session path",
      "/api/auth/session",
      { "Access-Control-Request-Method": "PUT" },
    ],
    [
      "Content-Type on a read-only path",
      "/api/status",
      {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    ],
    ["a method no route declares", "/api/settings", { "Access-Control-Request-Method": "DELETE" }],
    ["POST on the settings path", "/api/settings", { "Access-Control-Request-Method": "POST" }],
    [
      "an unknown header on the settings path",
      "/api/settings",
      {
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type, x-admin",
      },
    ],
    ["an unrouted path", "/api/nope", { "Access-Control-Request-Method": "GET" }],
    ["a cased spelling of a real path", "/api/Settings", { "Access-Control-Request-Method": "PUT" }],
    ["no requested method at all", "/api/settings", {}],
    ["a trailing slash", "/api/settings/", { "Access-Control-Request-Method": "PUT" }],
  ])("W2: refuses a preflight for %s", async (_label, path, headers) => {
    const response = await preflight(path, headers);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CORS_ORIGIN_DENIED" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("W3: every method the table NAMES is accepted exactly as advertised", async () => {
    for (const path of ROUTE_METHODS.keys()) {
      const methods = ROUTE_METHODS.get(path) ?? [];
      const advertised = await preflight(path, {
        "Access-Control-Request-Method": methods[0],
      });
      const headerList = advertised.headers.get("Access-Control-Allow-Headers") ?? "";
      const tokens = (advertised.headers.get("Access-Control-Allow-Methods") ?? "").split(", ");

      // OPTIONS is advertised for the browser's benefit and is THE ONE DECLARED EXCEPTION
      // to "advertised == accepted": a preflight is never itself preflighted, so asking for
      // the OPTIONS method is refused. Asserted here, not filtered out of the list -- a
      // filter would be the test agreeing with itself about the one case that differs.
      expect([path, tokens]).toEqual([path, [...methods, "OPTIONS"]]);
      const itself = await preflight(path, { "Access-Control-Request-Method": "OPTIONS" });
      expect([path, itself.status]).toEqual([path, 403]);

      for (const method of methods) {
        const echoed = await preflight(path, {
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": headerList,
        });
        expect([path, method, echoed.status]).toEqual([path, method, 204]);
      }
    }
  });

  it.each([
    "https://other.pages.dev",
    "https://deal-finder.pages.dev.evil.com",
    "http://deal-finder.pages.dev",
    "null",
  ])("W4: refuses the evil origin %s on PUT and on its preflight", async (origin) => {
    const env = environment({ DB: untouchableDb() });
    const write = await call(
      "/api/settings",
      {
        method: "PUT",
        body: '{"mode":"DISCOUNT","minimumDiscountPercent":23.5}',
        headers: {
          Origin: origin,
          Authorization: await bearerFor(),
          "Content-Type": "application/json",
        },
      },
      env,
    );
    const ahead = await call(
      "/api/settings",
      {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "PUT" },
      },
      env,
    );

    for (const response of [write, ahead]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "CORS_ORIGIN_DENIED" },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it.each([
    ["no token", undefined, 401, "AUTH_TOKEN_MISSING"],
    ["a token for an unapproved account", "stranger@example.com", 403, "AUTH_FORBIDDEN"],
  ])("W5: refuses a PUT with %s before the database is reached", async (_l, email, status, code) => {
    const response = await call(
      "/api/settings",
      {
        method: "PUT",
        body: '{"mode":"DISCOUNT","minimumDiscountPercent":23.5}',
        headers: {
          Origin: pagesOrigin,
          "Content-Type": "application/json",
          ...(email === undefined ? {} : { Authorization: await bearerFor({ email }) }),
        },
      },
      environment({ DB: untouchableDb() }),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(pagesOrigin);
  });

  it.each([["GET"], ["PUT"]])(
    "W6: reports a missing database binding as 503, not as a 404 or a throw",
    async (method) => {
      const response = await call("/api/settings", {
        method,
        headers: { Authorization: await bearerFor(), Origin: pagesOrigin },
        ...(method === "PUT" ? { body: "{}" } : {}),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "DATABASE_UNAVAILABLE" },
      });
    },
  );

  it("W7: every method the route table advertises is actually routed", async () => {
    for (const [path, methods] of ROUTE_METHODS) {
      for (const method of methods) {
        const response = await call(path, {
          method,
          headers: { Authorization: await bearerFor(), Origin: pagesOrigin },
          ...(method === "PUT" ? { body: "{}" } : {}),
        });
        expect([path, method, response.status]).not.toEqual([path, method, 404]);
      }
    }
  });

  /**
   * The table has three rows and only one of them is multi-method, so W1/W2/W3 cannot tell
   * "Content-Type follows a body-bearing method" apart from "Content-Type follows any path
   * with more than one method". This is the only test that can.
   */
  it.each([
    [["GET"], false],
    [["GET", "HEAD"], false],
    [["GET", "OPTIONS"], false],
    [["GET", "PUT"], true],
    [["POST"], true],
    [["PATCH"], true],
    [["DELETE"], false],
  ])("W9: Content-Type is offered to %s exactly when it takes a body", (methods, offered) => {
    expect(preflightHeadersFor(methods).includes("Content-Type")).toBe(offered);
  });

  /**
   * W7 proves every method the table ADVERTISES is routed. This is the converse on the PATH
   * axis: every path the route block accepts must be in the table, spelled EXACTLY. Two
   * mutants survived all 422 tests without it -- `.startsWith("/api/settings")`, under which
   * `PUT /api/settings-evil` answers 200 and writes revision 0 while its own preflight still
   * 403s (reachable but never advertised), and `.toLowerCase()`, which reopens at the route
   * the cased spelling W2 already refuses at the preflight.
   *
   * The database throws on contact, so a spelling that reaches the handler cannot answer 404:
   * it lands on 503, 400 or 200 instead, and every one of those fails this test.
   */
  it.each([
    ["a trailing slash", "/api/settings/"],
    ["a cased spelling", "/api/Settings"],
    ["a longer path with the same prefix", "/api/settings-evil"],
    ["a sub-path", "/api/settings/extra"],
  ])("W10: %s is not the settings route, on GET or on PUT", async (_label, path) => {
    const env = environment({ DB: untouchableDb() });
    const read = await call(
      path,
      { headers: { Authorization: await bearerFor(), Origin: pagesOrigin } },
      env,
    );
    const write = await call(
      path,
      {
        method: "PUT",
        body: '{"mode":"DISCOUNT","minimumDiscountPercent":11.75}',
        headers: {
          Authorization: await bearerFor(),
          Origin: pagesOrigin,
          "Content-Type": "application/json",
        },
      },
      env,
    );

    for (const response of [read, write]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });

  it("W8: a method no route declares is a 404, and the preflight never let it through", async () => {
    const response = await call("/api/settings", {
      method: "POST",
      body: "{}",
      headers: { Authorization: await bearerFor(), Origin: pagesOrigin },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

/**
 * THE INGEST ROUTE'S CREDENTIAL BOUNDARY.
 *
 * `POST /api/listings` admits exactly one identity -- a bearer secret with no human behind it --
 * and every other route admits exactly the two it admitted before. These tests are what enforce
 * that the two sets are disjoint IN BOTH DIRECTIONS; the type split between `WorkerEnvironment`
 * and `CollectorEnvironment` is a tripwire that catches the careless edit and nothing more.
 */
describe("the ingest route's credential boundary", () => {
  const collectorToken = "index-suite-ingest-token-3ce70b48a91d";
  const ingestPath = "/api/listings";

  /** Any touch is a failure: the credential check runs before the handler. */
  const untouchableDb = () =>
    ({
      prepare: () => {
        throw new Error("the database must not be reached");
      },
      batch: () => {
        throw new Error("the database must not be reached");
      },
    }) as unknown as D1Database;

  let ingestDatabase!: TestDatabase;

  beforeAll(async () => {
    ingestDatabase = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ingestDatabase.dispose();
  });

  // X7's 200 row is the only test here that writes; truncating keeps the rest order-independent.
  beforeEach(async () => {
    await truncateAll(ingestDatabase.db);
  });

  const ingestEnvironment = (overrides: Partial<Environment> = {}): Environment =>
    environment({ COLLECTOR_TOKEN: collectorToken, DB: untouchableDb(), ...overrides });

  /** Deliberately unlike every other suite's fixture values. */
  const validBody = JSON.stringify({
    source: "index-suite-market",
    componentType: "case_fan",
    market: { latitude: 51.0447, longitude: -114.0719, radiusKm: 7 },
    listings: [
      {
        listingId: "X-11",
        title: "a case fan",
        priceText: "CA$19",
        locationText: "Calgary, Alberta",
        url: "https://www.facebook.com/marketplace/item/X-11",
      },
    ],
  });

  const ingest = (
    init: RequestInit = {},
    env: Environment = ingestEnvironment(),
    origin: string = workerOrigin,
    path: string = ingestPath,
  ) =>
    handleRequest(
      new Request(`${origin}${path}`, {
        method: "POST",
        body: validBody,
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
      }),
      env,
      dependencies,
    );

  const listingCount = async (): Promise<number> => {
    const row = await ingestDatabase.db
      .prepare("SELECT COUNT(*) AS n FROM listings")
      .first<{ n: number }>();
    return row?.n ?? -1;
  };

  it.each([
    ["the deployed worker origin", workerOrigin, "production"],
    ["http://localhost", "http://localhost:8787", "local"],
    ["http://127.0.0.1", "http://127.0.0.1:8787", "local"],
  ])(
    "X1: no collector token is a 401 on %s -- the loopback dev identity does not open ingest",
    async (_label, origin, appEnv) => {
      const response = await ingest({}, ingestEnvironment({ APP_ENV: appEnv }), origin);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "AUTH_TOKEN_MISSING" },
      });
    },
  );

  it("X2: a wrong collector token is a 401 INVALID, and the database is untouched", async () => {
    const response = await ingest({
      headers: { "X-Collector-Token": "not-the-collector-token-but-long-enough" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_TOKEN_INVALID" },
    });
  });

  it.each([
    ["with a plausible header", { "X-Collector-Token": "any-value-at-all-32-characters-x" }],
    ["with no header at all", {}],
  ])("X3: an unconfigured secret is a 503 %s, never an open route", async (_label, headers) => {
    const response = await ingest({ headers }, ingestEnvironment({ COLLECTOR_TOKEN: undefined }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      // NOT AUTH_CONFIG_MISSING: that code already means an unset ALLOWED_ORIGINS or
      // FIREBASE_PROJECT_ID, and an operator reading it would run the wrong command.
      error: { code: "COLLECTOR_CONFIG_MISSING" },
    });
  });

  /**
   * X4 IS THE ENFORCEMENT OF THE CREDENTIAL BOUNDARY, NOT THE TYPE SYSTEM. DO NOT DELETE IT AS
   * REDUNDANT. `CollectorEnvironment` makes the NAIVE leak -- a direct property read inside an
   * `authenticateRequest`-shaped function -- fail to compile, and that is all it does: three
   * casts and a one-word parameter widening all compile clean under this repo's strict config,
   * and eslint bans none of them. If the collector check were ever wired into
   * `authenticateRequest`, every row here would go red and nothing else would.
   */
  it.each([
    ["GET", "/api/auth/session"],
    ["GET", "/api/status"],
    ["GET", "/api/settings"],
    ["PUT", "/api/settings"],
  ])(
    "X4: a VALID collector token buys nothing on %s %s",
    async (method, path) => {
      const response = await call(
        path,
        {
          method,
          headers: {
            "X-Collector-Token": collectorToken,
            ...(method === "PUT"
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(method === "PUT"
            ? { body: '{"mode":"DISCOUNT","minimumDiscountPercent":11.75}' }
            : {}),
        },
        ingestEnvironment(),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "AUTH_TOKEN_MISSING" },
      });
    },
  );

  /**
   * X5 is a REGRESSION GUARD, and it says so: these origins are refused by the PRE-EXISTING CORS
   * block in `handleRequest`, measured, so this test survives removing the ingest branch's own
   * Origin refusal. X6(a) -- the ALLOWED origin -- is the row that kills that mutation.
   */
  it.each([
    ["an evil origin", "https://evil.example"],
    ["the literal null origin", "null"],
    ["an empty origin", ""],
  ])("X5: %s is refused and never reflected, even with a valid token", async (_label, origin) => {
    const response = await ingest({
      headers: { Origin: origin, "X-Collector-Token": collectorToken },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CORS_ORIGIN_DENIED" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("X6a: even the ALLOWED origin is refused -- there is no browser channel at all", async () => {
    const response = await ingest({
      headers: { Origin: pagesOrigin, "X-Collector-Token": collectorToken },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CORS_ORIGIN_DENIED" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("X6b: the preflight for POST /api/listings is refused", async () => {
    const response = await call(
      ingestPath,
      {
        method: "OPTIONS",
        headers: { Origin: pagesOrigin, "Access-Control-Request-Method": "POST" },
      },
      ingestEnvironment(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  /**
   * X6c PINS A DELIBERATE INVERSION OF W10's NORM, and it is the ONLY guard on it.
   * MEASURED: adding `["/api/listings", ["POST"]]` to ROUTE_METHODS leaves every other test in
   * this file passing -- all of them -- while `OPTIONS /api/listings` from the allowed origin
   * then answers 204 advertising `Access-Control-Allow-Methods: POST, OPTIONS`. That is a real
   * browser channel invisible to every existing test. The table is the ADVERTISED BROWSER
   * SURFACE; this route has no browser caller and must never advertise one.
   */
  it("X6c: /api/listings is deliberately absent from the advertised surface", () => {
    expect(ROUTE_METHODS.has(ingestPath)).toBe(false);
  });

  it.each([
    [
      "a successful ingest",
      200,
      () => ingest({ headers: { "X-Collector-Token": collectorToken } }, ingestEnvironment({ DB: ingestDatabase.db })),
    ],
    ["a missing credential", 401, () => ingest({})],
    [
      "an allowed browser origin",
      403,
      () => ingest({ headers: { Origin: pagesOrigin, "X-Collector-Token": collectorToken } }),
    ],
    [
      "a malformed body",
      400,
      () => ingest({ body: "{", headers: { "X-Collector-Token": collectorToken } }),
    ],
    [
      "an unconfigured credential",
      503,
      () => ingest({ headers: { "X-Collector-Token": collectorToken } }, ingestEnvironment({ COLLECTOR_TOKEN: undefined })),
    ],
    [
      "a missing database binding",
      503,
      () => ingest({ headers: { "X-Collector-Token": collectorToken } }, ingestEnvironment({ DB: undefined })),
    ],
  ])("X7: %s carries Vary, every security header and NO CORS header", async (_label, status, send) => {
    const response = await send();

    expect(response.status).toBe(status);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  /**
   * X8: the path is matched EXACTLY. `.startsWith("/api/listings")` reaches the handler on every
   * row but the last, and `.toLowerCase()` reopens the cased spelling. The database throws on
   * contact, so a spelling that reached the handler could not answer 401 -- it would land on a
   * 503, a 400 or a 200 instead, and every one of those fails this test.
   */
  it.each([
    ["a trailing slash", "/api/listings/", 401, "AUTH_TOKEN_MISSING"],
    ["a cased spelling", "/api/Listings", 401, "AUTH_TOKEN_MISSING"],
    ["a longer path with the same prefix", "/api/listings-evil", 401, "AUTH_TOKEN_MISSING"],
    ["a sub-path", "/api/listings/extra", 401, "AUTH_TOKEN_MISSING"],
    ["an encoded slash", "/api/listings%2f", 401, "AUTH_TOKEN_MISSING"],
    ["a doubled inner slash", "/api//listings", 401, "AUTH_TOKEN_MISSING"],
    // This one never enters /api/ at all, so it is refused one branch earlier.
    ["a doubled leading slash", "//api/listings", 404, "NOT_FOUND"],
  ])("X8: %s is not the ingest route", async (_label, path, status, code) => {
    const response = await ingest(
      { headers: { "X-Collector-Token": collectorToken } },
      ingestEnvironment(),
      workerOrigin,
      path,
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  /**
   * X9: the method is matched exactly too. NOTE THE SHAPES, which are not what a first guess
   * predicts: the collector-token rows answer 401 because they carry no `Authorization` and fall
   * through to `authenticateRequest`, and the Firebase rows answer 404 because no route table
   * entry matches. Dropping the method check sends the collector-token rows into the ingest
   * handler instead, where they answer 400 or 415 depending on Content-Type.
   */
  it.each([["GET"], ["PUT"], ["DELETE"], ["PATCH"], ["HEAD"]])(
    "X9: %s /api/listings is not the ingest route",
    async (method) => {
      const withCollectorToken = await call(
        ingestPath,
        { method, headers: { "X-Collector-Token": collectorToken } },
        ingestEnvironment(),
      );
      expect(withCollectorToken.status).toBe(401);

      const withFirebaseIdentity = await call(
        ingestPath,
        { method, headers: { Authorization: await bearerFor() } },
        ingestEnvironment(),
      );
      expect(withFirebaseIdentity.status).toBe(404);
    },
  );

  /**
   * THE REAL DATABASE IS BOUND HERE ON PURPOSE -- but this buys LEGIBILITY, NOT KILL-POWER, and
   * saying so is the point. With `untouchableDb()` the row count was 0 on every path, mutated or
   * not: an assertion satisfiable by an empty input, the shape this project's brief flags.
   * MEASURED, however, that the status assertion below already caught every mutation this one
   * does -- no path can both write a row and answer 401. What changed is which failure the run
   * reports: "a row was written" rather than the weaker "the status was wrong". The count is
   * asserted FIRST so that it is the one that fires.
   */
  it("X10: an approved Firebase identity does not open the ingest route", async () => {
    const response = await ingest(
      { headers: { Authorization: await bearerFor() } },
      ingestEnvironment({ DB: ingestDatabase.db }),
    );

    // THE COUNT IS ASSERTED FIRST so that it is the assertion that fires: any mutation which lets
    // a Firebase identity through writes a row, and a status check above this line would mask it.
    expect(await listingCount()).toBe(0);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_TOKEN_MISSING" },
    });
  });
});
