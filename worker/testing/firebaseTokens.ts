import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type { KeySource } from "../auth/firebaseCertificates";

/**
 * Test-only. Not reachable from the `worker/index.ts` entry, so wrangler never
 * bundles it. A locally generated RS256 key pair plus a two-line KeySource is
 * how a Firebase-shaped ID token is verified offline, with no Firebase project.
 */
export interface TokenClaims {
  now: number;
  email?: string;
  emailVerified?: unknown;
  provider?: string;
  sub?: string;
  expiresIn?: number;
  audience?: unknown;
  issuer?: string;
  authTime?: number;
  iat?: number;
  kid?: string;
  alg?: string;
}

const HS256_TEST_SECRET = "hs256-test-secret-hs256-test-secret";

export const createTokenFactory = async (projectId: string) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "test-kid";
  const keys: KeySource = {
    getKey: async (requested: string) => (requested === kid ? publicKey : null),
  };

  const sign = async (claims: TokenClaims): Promise<string> => {
    const { now } = claims;
    const payload: JWTPayload = {
      iss: "issuer" in claims ? claims.issuer : `https://securetoken.google.com/${projectId}`,
      aud: ("audience" in claims ? claims.audience : projectId) as JWTPayload["aud"],
      sub: "sub" in claims ? claims.sub : "firebase-uid-1",
      iat: "iat" in claims ? claims.iat : now,
      auth_time: "authTime" in claims ? claims.authTime : now,
      exp: now + (claims.expiresIn ?? 3_600),
      email: "email" in claims ? claims.email : "owner@example.com",
      email_verified: "emailVerified" in claims ? claims.emailVerified : true,
      firebase:
        "provider" in claims
          ? claims.provider === undefined
            ? undefined
            : { sign_in_provider: claims.provider }
          : { sign_in_provider: "google.com" },
    };

    const alg = claims.alg ?? "RS256";
    const signer = new SignJWT(payload).setProtectedHeader({
      alg,
      kid: "kid" in claims ? claims.kid : kid,
    });

    return alg === "RS256"
      ? signer.sign(privateKey)
      : signer.sign(new TextEncoder().encode(HS256_TEST_SECRET));
  };

  return { keys, sign, publicKey, privateKey, kid };
};
