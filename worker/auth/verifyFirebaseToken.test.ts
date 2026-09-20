// @vitest-environment node

import type { JWTPayload } from "jose";
import { KeysUnavailableError, type KeySource } from "./firebaseCertificates";
import {
  authenticateRequest,
  validateFirebaseClaims,
  type AuthDependencies,
  type WorkerEnvironment,
} from "./verifyFirebaseToken";
import { createTokenFactory, type TokenClaims } from "../testing/firebaseTokens";

const projectId = "deal-finder-test";
const now = 1_800_000_000;
const apiUrl = "https://api.example.workers.dev/api/auth/session";

let factory!: Awaited<ReturnType<typeof createTokenFactory>>;
let dependencies!: AuthDependencies;

beforeAll(async () => {
  factory = await createTokenFactory(projectId);
  dependencies = { keys: factory.keys, now: () => now };
});

const productionEnvironment = (
  overrides: Partial<WorkerEnvironment> = {},
): WorkerEnvironment => ({
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: projectId,
  APPROVED_EMAILS: JSON.stringify(["owner@example.com"]),
  ...overrides,
});

const authenticate = (
  headers: Record<string, string>,
  environment: WorkerEnvironment = productionEnvironment(),
  deps: AuthDependencies = dependencies,
  url = apiUrl,
) => authenticateRequest(new Request(url, { headers }), environment, deps);

const bearerFor = async (claims: Partial<TokenClaims> = {}) =>
  `Bearer ${await factory.sign({ now, ...claims })}`;

const baseClaims = (): JWTPayload => ({
  sub: "firebase-uid-1",
  aud: projectId,
  iss: `https://securetoken.google.com/${projectId}`,
  exp: now + 3_600,
  iat: now,
  auth_time: now,
});

describe("Firebase ID token verification", () => {
  it("admits an approved, verified Google identity", async () => {
    await expect(
      authenticate({ Authorization: await bearerFor() }),
    ).resolves.toEqual({
      ok: true,
      identity: {
        email: "owner@example.com",
        subject: "firebase-uid-1",
        expiresAt: now + 3_600,
        authenticationMethod: "firebase-google",
      },
    });
  });

  it("reports a missing credential distinctly from a malformed one", async () => {
    await expect(authenticate({})).resolves.toEqual({
      ok: false,
      status: 401,
      code: "AUTH_TOKEN_MISSING",
    });
  });

  it("never reads the Cloudflare Access assertion header as a credential", async () => {
    await expect(
      authenticate({ "Cf-Access-Jwt-Assertion": await factory.sign({ now }) }),
    ).resolves.toEqual({ ok: false, status: 401, code: "AUTH_TOKEN_MISSING" });
  });

  it("accepts a lowercase Bearer scheme", async () => {
    const token = await factory.sign({ now });
    await expect(
      authenticate({ Authorization: `bearer ${token}` }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects every Authorization header that is not exactly one Bearer token", async () => {
    const token = await factory.sign({ now });

    for (const header of [
      `Basic ${token}`,
      token,
      `Bearer ${token}, Bearer ${token}`,
      "Bearer",
      "Bearer ",
    ]) {
      await expect(authenticate({ Authorization: header })).resolves.toEqual({
        ok: false,
        status: 401,
        code: "AUTH_TOKEN_INVALID",
      });
    }
  });

  it("rejects a tampered signature", async () => {
    const [header, payload, signature] = (await factory.sign({ now })).split(".");
    // The first character always carries meaningful bits; the last one can be
    // pure base64url padding, where a flip would decode to the same bytes.
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);

    await expect(
      authenticate({ Authorization: `Bearer ${header}.${payload}.${flipped}` }),
    ).resolves.toEqual({ ok: false, status: 401, code: "AUTH_TOKEN_INVALID" });
  });

  it("rejects an unknown kid without promoting it to an outage", async () => {
    await expect(
      authenticate({ Authorization: await bearerFor({ kid: "rotated-away" }) }),
    ).resolves.toEqual({ ok: false, status: 401, code: "AUTH_TOKEN_INVALID" });
  });

  it.each([
    ["a symmetric algorithm", { alg: "HS256" } as Partial<TokenClaims>],
    ["no kid", { kid: undefined } as Partial<TokenClaims>],
    ["an empty kid", { kid: "" } as Partial<TokenClaims>],
  ])(
    "rejects %s without ever consulting the key source",
    async (_label, claims) => {
      const getKey = vi.fn(() => Promise.resolve(null));

      await expect(
        authenticate({ Authorization: await bearerFor(claims) }, productionEnvironment(), {
          keys: { getKey },
          now: () => now,
        }),
      ).resolves.toEqual({ ok: false, status: 401, code: "AUTH_TOKEN_INVALID" });
      expect(getKey).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the key source cannot reach Google", async () => {
    const keys: KeySource = {
      getKey: () => Promise.reject(new KeysUnavailableError("offline")),
    };

    await expect(
      authenticate(
        { Authorization: await bearerFor() },
        productionEnvironment(),
        { keys, now: () => now },
      ),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_KEYS_UNAVAILABLE" });
  });

  it.each([
    ["a foreign issuer", { issuer: "https://securetoken.google.com/other-project" }],
    ["a foreign audience", { audience: "other-project" }],
    ["an audience array containing the project", { audience: [projectId] }],
    ["a non-string audience", { audience: 123 }],
    ["no subject", { sub: undefined }],
    ["an empty subject", { sub: "" }],
    ["a blank subject", { sub: "   " }],
    ["an expiry one second in the past", { expiresIn: -1 }],
    ["an expiry exactly now", { expiresIn: 0 }],
    ["a future issued-at", { iat: now + 1 }],
    ["a future auth_time", { authTime: now + 1 }],
    ["no auth_time", { authTime: undefined }],
  ])("rejects a token with %s", async (_label, claims) => {
    await expect(
      authenticate({ Authorization: await bearerFor(claims as Partial<TokenClaims>) }),
    ).resolves.toEqual({ ok: false, status: 401, code: "AUTH_TOKEN_INVALID" });
  });

  it.each([
    ["an expiry one second away", { expiresIn: 1 }],
    ["an issued-at of exactly now", { iat: now }],
    ["an auth_time of exactly now", { authTime: now }],
  ])("accepts a token with %s", async (_label, claims) => {
    await expect(
      authenticate({ Authorization: await bearerFor(claims as Partial<TokenClaims>) }),
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["an expiry of exactly now", { exp: now }, false],
    ["an expiry one second away", { exp: now + 1 }, true],
    ["an issued-at of exactly now", { iat: now }, true],
    ["an issued-at one second ahead", { iat: now + 1 }, false],
    ["an auth_time of exactly now", { auth_time: now }, true],
    ["an auth_time one second ahead", { auth_time: now + 1 }, false],
  ])("validates %s at the second boundary", (_label, overrides, accepted) => {
    const payload = { ...baseClaims(), ...overrides } as JWTPayload;
    expect(validateFirebaseClaims(payload, projectId, now).ok).toBe(accepted);
  });

  it.each([
    ["exp Infinity", { exp: Infinity }],
    ["iat NaN", { iat: NaN }],
    ["auth_time -Infinity", { auth_time: -Infinity }],
    ["a stringified exp", { exp: "1800000000" }],
  ])("rejects non-finite numeric claims: %s", (_label, overrides) => {
    const payload = { ...baseClaims(), ...overrides } as unknown as JWTPayload;
    expect(validateFirebaseClaims(payload, projectId, now)).toEqual({ ok: false });
  });

  it.each([
    ["an unverified email", { emailVerified: false }],
    ["no email_verified claim", { emailVerified: undefined }],
    ["a stringified email_verified", { emailVerified: "true" }],
    ["no email", { email: undefined }],
    ["a password sign-in provider", { provider: "password" }],
    ["no firebase claim", { provider: undefined }],
  ])("denies a verified token carrying %s", async (_label, claims) => {
    await expect(
      authenticate({ Authorization: await bearerFor(claims as Partial<TokenClaims>) }),
    ).resolves.toEqual({ ok: false, status: 403, code: "AUTH_FORBIDDEN" });
  });

  it.each([
    "owner@example.com.evil.com",
    "xowner@example.com",
    "o.wner@example.com",
    "owner+test@example.com",
    "owner@example.co",
  ])("denies the allowlist lookalike %s", async (email) => {
    await expect(
      authenticate({ Authorization: await bearerFor({ email }) }),
    ).resolves.toEqual({ ok: false, status: 403, code: "AUTH_FORBIDDEN" });
  });

  it("normalizes allowlist entries by trimming and lowercasing only", async () => {
    await expect(
      authenticate(
        { Authorization: await bearerFor() },
        productionEnvironment({ APPROVED_EMAILS: '["  Owner@Example.COM "]' }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("re-reads the allowlist on every request", async () => {
    const header = { Authorization: await bearerFor() };

    await expect(
      authenticate(header, productionEnvironment()),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authenticate(
        header,
        productionEnvironment({ APPROVED_EMAILS: '["someone-else@example.com"]' }),
      ),
    ).resolves.toEqual({ ok: false, status: 403, code: "AUTH_FORBIDDEN" });
  });

  it.each([
    ["an absent project id", { FIREBASE_PROJECT_ID: undefined }],
    ["a placeholder project id", { FIREBASE_PROJECT_ID: "REPLACE_WITH_FIREBASE_PROJECT_ID" }],
    ["an absent allowlist", { APPROVED_EMAILS: undefined }],
  ])("fails closed with AUTH_CONFIG_MISSING for %s", async (_label, overrides) => {
    await expect(
      authenticate(
        { Authorization: await bearerFor() },
        productionEnvironment(overrides),
      ),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_CONFIG_MISSING" });
  });

  it.each(["not json", "{}", "[]", '[""]', '["   "]', "[1]", '["a@b.c", 2]'])(
    "fails closed with AUTH_CONFIG_INVALID for an allowlist of %s",
    async (approved) => {
      await expect(
        authenticate(
          { Authorization: await bearerFor() },
          productionEnvironment({ APPROVED_EMAILS: approved }),
        ),
      ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_CONFIG_INVALID" });
    },
  );

  it("reports unusable configuration before a missing token", async () => {
    await expect(
      authenticate({}, { APP_ENV: "production" }),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_CONFIG_MISSING" });
  });
});

describe("local development identity", () => {
  const localIdentity = {
    ok: true,
    identity: {
      email: "local-dev@localhost",
      subject: "local-development",
      expiresAt: now + 86_400,
      authenticationMethod: "local-development",
    },
  };

  it.each([
    "http://localhost:8787/api/auth/session",
    "http://127.0.0.1:8787/api/auth/session",
    "http://[::1]:8787/api/auth/session",
  ])("admits %s with no Firebase configuration at all", async (url) => {
    await expect(
      authenticate({}, { APP_ENV: "local" }, dependencies, url),
    ).resolves.toEqual(localIdentity);
  });

  it.each([
    ["a public hostname", "https://api.example.workers.dev/api/status"],
    ["a loopback lookalike", "http://localhost.evil.com/api/status"],
    ["a loopback-prefixed host", "http://127.0.0.1.evil.com/api/status"],
    ["the wildcard address", "http://0.0.0.0/api/status"],
    ["a neighbouring loopback address", "http://127.0.0.2/api/status"],
  ])("refuses a local identity for %s", async (_label, url) => {
    await expect(
      authenticate({}, { APP_ENV: "local" }, dependencies, url),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_CONFIG_MISSING" });
  });

  it.each([
    ["production", { APP_ENV: "production" }],
    ["absent", {}],
  ])("refuses a local identity on loopback when APP_ENV is %s", async (_label, environment) => {
    await expect(
      authenticate(
        {},
        environment,
        dependencies,
        "http://localhost:8787/api/auth/session",
      ),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_CONFIG_MISSING" });
  });

  it("ignores host headers when deciding whether a request is loopback", async () => {
    await expect(
      authenticate(
        { Host: "localhost", "X-Forwarded-Host": "localhost" },
        { APP_ENV: "local" },
        dependencies,
        "https://api.example.workers.dev/api/status",
      ),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_CONFIG_MISSING" });
  });
});
