// @vitest-environment node

// The production wiring — the lazily created module singleton, the module URL
// constant, the default X.509 importer and the default seconds clock — is
// injected away by every other test, so it is exercised here. Its own file so
// vitest's per-file module registry keeps that singleton isolated.
//
// Case order matters: case 1 caches nothing on failure, so it cannot pollute case 2.

import { googleCertificateFixture } from "../testing/googleCertificateFixture";
import { createTokenFactory } from "../testing/firebaseTokens";
import { authenticateRequest } from "./verifyFirebaseToken";

const projectId = "deal-finder-test";
const apiUrl = "https://api.example.workers.dev/api/auth/session";

const productionEnvironment = {
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: projectId,
  APPROVED_EMAILS: JSON.stringify(["owner@example.com"]),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default authentication dependencies", () => {
  it("fails closed with 503 when the real certificate fetch cannot complete", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));

    const factory = await createTokenFactory(projectId);
    const token = await factory.sign({ now: Math.floor(Date.now() / 1_000) });

    await expect(
      authenticateRequest(new Request(apiUrl, { headers: { Authorization: `Bearer ${token}` } }), productionEnvironment),
    ).resolves.toEqual({ ok: false, status: 503, code: "AUTH_KEYS_UNAVAILABLE" });
  });

  it("imports the real certificate and answers 401 for a foreign signature", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ [googleCertificateFixture.kid]: googleCertificateFixture.pem }),
          { headers: { "Cache-Control": "public, max-age=300" } },
        ),
      ),
    );

    const factory = await createTokenFactory(projectId);
    const token = await factory.sign({
      now: Math.floor(Date.now() / 1_000),
      kid: googleCertificateFixture.kid,
    });

    // 401, not 503: the default importer produced a key and it was actually used.
    await expect(
      authenticateRequest(new Request(apiUrl, { headers: { Authorization: `Bearer ${token}` } }), productionEnvironment),
    ).resolves.toEqual({ ok: false, status: 401, code: "AUTH_TOKEN_INVALID" });
  });

  it("uses a seconds clock, not a milliseconds one", async () => {
    const result = await authenticateRequest(
      new Request("http://localhost:8787/api/auth/session"),
      { APP_ENV: "local" },
    );

    expect(result.ok).toBe(true);
    const expiresAt = result.ok ? result.identity.expiresAt : 0;
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000) + 86_400 - 5);
    expect(expiresAt).toBeLessThan(Math.floor(Date.now() / 1_000) + 86_400 + 5);
  });
});
