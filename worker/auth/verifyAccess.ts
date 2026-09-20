import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export interface AccessEnvironment {
  APP_ENV?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
}

export interface AccessIdentity {
  email: string;
  subject: string;
  expiresAt: number;
  authenticationMethod: "cloudflare-access" | "local-development";
}

export type AuthenticationResult =
  | { ok: true; identity: AccessIdentity }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code: "ACCESS_TOKEN_MISSING" | "ACCESS_TOKEN_INVALID" | "ACCESS_CONFIG_MISSING";
    };

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

const normalizedTeamDomain = (value: string) => value.trim().replace(/\/$/, "");

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const localIdentity = (): AccessIdentity => ({
  email: "local-dev@localhost",
  subject: "local-development",
  expiresAt: Math.floor(Date.now() / 1_000) + 86_400,
  authenticationMethod: "local-development",
});

const identityFromClaims = (claims: JWTPayload): AccessIdentity => {
  if (
    typeof claims.email !== "string" ||
    typeof claims.sub !== "string" ||
    typeof claims.exp !== "number"
  ) {
    throw new Error("The Access token is missing required identity claims.");
  }

  return {
    email: claims.email,
    subject: claims.sub,
    expiresAt: claims.exp,
    authenticationMethod: "cloudflare-access",
  };
};

export const verifyAccessJwt = async (
  token: string,
  keySet: JWTVerifyGetKey,
  teamDomain: string,
  audience: string,
) => {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: teamDomain,
    audience,
  });

  return identityFromClaims(payload);
};

const remoteKeySetFor = (teamDomain: string) => {
  const existing = remoteKeySets.get(teamDomain);
  if (existing) return existing;

  const keySet = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`),
  );
  remoteKeySets.set(teamDomain, keySet);
  return keySet;
};

export const authenticateRequest = async (
  request: Request,
  environment: AccessEnvironment,
): Promise<AuthenticationResult> => {
  const requestUrl = new URL(request.url);

  if (environment.APP_ENV === "local" && isLoopbackHost(requestUrl.hostname)) {
    return { ok: true, identity: localIdentity() };
  }

  const audience = environment.CLOUDFLARE_ACCESS_AUD?.trim();
  const teamDomainValue = environment.CLOUDFLARE_ACCESS_TEAM_DOMAIN;

  if (!audience || !teamDomainValue) {
    return { ok: false, status: 503, code: "ACCESS_CONFIG_MISSING" };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return { ok: false, status: 401, code: "ACCESS_TOKEN_MISSING" };
  }

  const teamDomain = normalizedTeamDomain(teamDomainValue);

  try {
    const identity = await verifyAccessJwt(
      token,
      remoteKeySetFor(teamDomain),
      teamDomain,
      audience,
    );
    return { ok: true, identity };
  } catch {
    return { ok: false, status: 403, code: "ACCESS_TOKEN_INVALID" };
  }
};
