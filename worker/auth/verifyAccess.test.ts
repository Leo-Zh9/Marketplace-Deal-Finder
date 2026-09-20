// @vitest-environment node

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticateRequest, verifyAccessJwt } from "./verifyAccess";

const issuer = "https://deal-finder-test.cloudflareaccess.com";
const audience = "phase-2-test-audience";

describe("Cloudflare Access verification", () => {
  it("allows local development only on a loopback host", async () => {
    const local = await authenticateRequest(
      new Request("http://127.0.0.1:8787/api/auth/session"),
      { APP_ENV: "local" },
    );
    const nonLocal = await authenticateRequest(
      new Request("https://api.example.com/api/auth/session"),
      { APP_ENV: "local" },
    );

    expect(local).toMatchObject({
      ok: true,
      identity: { authenticationMethod: "local-development" },
    });
    expect(nonLocal).toEqual({
      ok: false,
      status: 503,
      code: "ACCESS_CONFIG_MISSING",
    });
  });

  it("fails closed when production configuration or a token is missing", async () => {
    const request = new Request("https://api.example.com/api/auth/session");

    await expect(authenticateRequest(request, { APP_ENV: "production" })).resolves.toEqual({
      ok: false,
      status: 503,
      code: "ACCESS_CONFIG_MISSING",
    });
    await expect(
      authenticateRequest(request, {
        APP_ENV: "production",
        CLOUDFLARE_ACCESS_AUD: audience,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: issuer,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 401,
      code: "ACCESS_TOKEN_MISSING",
    });
  });

  it("verifies signature, issuer, audience, expiry, and identity claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "local-test-key";
    publicJwk.alg = "RS256";
    const keySet = createLocalJWKSet({ keys: [publicJwk] });
    const token = await new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("owner-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifyAccessJwt(token, keySet, issuer, audience)).resolves.toMatchObject({
      email: "owner@example.com",
      subject: "owner-subject",
      authenticationMethod: "cloudflare-access",
    });
    await expect(
      verifyAccessJwt(token, keySet, issuer, "wrong-audience"),
    ).rejects.toThrow();
  });
});
