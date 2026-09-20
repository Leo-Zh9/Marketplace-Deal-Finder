import { decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import {
  createCertificateStore,
  defaultNow,
  type KeySource,
} from "./firebaseCertificates";

export interface WorkerEnvironment {
  APP_ENV?: string;
  FIREBASE_PROJECT_ID?: string;
  /** JSON array of exact origins. A var. */
  ALLOWED_ORIGINS?: string;
  /** JSON array of emails. A secret — never committed. */
  APPROVED_EMAILS?: string;
}

export type AuthenticationMethod = "firebase-google" | "local-development";

export interface AuthenticatedIdentity {
  email: string;
  subject: string;
  expiresAt: number;
  authenticationMethod: AuthenticationMethod;
}

export type AuthFailureCode =
  | "AUTH_TOKEN_MISSING"
  | "AUTH_TOKEN_INVALID"
  | "AUTH_FORBIDDEN"
  | "AUTH_CONFIG_MISSING"
  | "AUTH_CONFIG_INVALID"
  | "AUTH_KEYS_UNAVAILABLE";

export type AuthenticationResult =
  | { ok: true; identity: AuthenticatedIdentity }
  | { ok: false; status: 401 | 403 | 503; code: AuthFailureCode };

export interface AuthDependencies {
  keys: KeySource;
  now: () => number;
}

/** Trims; returns null for "" and for any value still holding a setup placeholder. */
export const configuredValue = (raw: string | undefined): string | null => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  if (trimmed.startsWith("REPLACE_WITH_")) return null;
  return trimmed;
};

/** Exact set. No substring or suffix matching. */
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]";

export const parseApprovedEmails = (
  raw: string | undefined,
):
  | { ok: true; emails: Set<string> }
  | { ok: false; code: "AUTH_CONFIG_MISSING" | "AUTH_CONFIG_INVALID" } => {
  const configured = configuredValue(raw);
  if (configured === null) return { ok: false, code: "AUTH_CONFIG_MISSING" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    return { ok: false, code: "AUTH_CONFIG_INVALID" };
  }

  if (!Array.isArray(parsed)) return { ok: false, code: "AUTH_CONFIG_INVALID" };

  const emails = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string") return { ok: false, code: "AUTH_CONFIG_INVALID" };
    const normalized = entry.trim().toLowerCase();
    if (normalized !== "") emails.add(normalized);
  }

  if (emails.size === 0) return { ok: false, code: "AUTH_CONFIG_INVALID" };
  return { ok: true, emails };
};

export const validateFirebaseClaims = (
  payload: JWTPayload,
  projectId: string,
  now: number,
): { ok: true; subject: string; expiresAt: number } | { ok: false } => {
  const { sub, aud, iss, exp, iat } = payload;
  const authTime = payload.auth_time;

  if (typeof sub !== "string" || sub.trim() === "") return { ok: false };
  if (typeof aud !== "string" || aud !== projectId) return { ok: false };
  if (typeof iss !== "string" || iss !== `https://securetoken.google.com/${projectId}`) {
    return { ok: false };
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false };
  if (typeof iat !== "number" || !Number.isFinite(iat)) return { ok: false };
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return { ok: false };
  if (exp <= now) return { ok: false };
  if (iat > now) return { ok: false };
  if (authTime > now) return { ok: false };

  return { ok: true, subject: sub, expiresAt: exp };
};

let defaults: AuthDependencies | null = null;

/** Lazy so an injecting test never builds a store; a singleton so the cache survives an isolate. */
const defaultDependencies = (): AuthDependencies =>
  (defaults ??= { keys: createCertificateStore(), now: defaultNow });

const invalidToken = {
  ok: false,
  status: 401,
  code: "AUTH_TOKEN_INVALID",
} as const satisfies AuthenticationResult;

const forbidden = {
  ok: false,
  status: 403,
  code: "AUTH_FORBIDDEN",
} as const satisfies AuthenticationResult;

const signInProviderOf = (payload: JWTPayload): unknown => {
  const firebase = payload.firebase;
  if (typeof firebase !== "object" || firebase === null) return undefined;
  return (firebase as { sign_in_provider?: unknown }).sign_in_provider;
};

export const authenticateRequest = async (
  request: Request,
  environment: WorkerEnvironment,
  dependencies: AuthDependencies = defaultDependencies(),
): Promise<AuthenticationResult> => {
  const now = dependencies.now();

  // 1. The guarded local-development identity is checked before any Firebase
  //    configuration, so `npm run dev:full` needs no project and no secret.
  //    APP_ENV is the only factor an attacker cannot influence: in workerd
  //    request.url is itself built from the incoming Host/:authority, so the
  //    loopback check is defence in depth, not an independent second factor.
  if (
    environment.APP_ENV === "local" &&
    isLoopbackHostname(new URL(request.url).hostname)
  ) {
    return {
      ok: true,
      identity: {
        email: "local-dev@localhost",
        subject: "local-development",
        expiresAt: now + 86_400,
        authenticationMethod: "local-development",
      },
    };
  }

  const projectId = configuredValue(environment.FIREBASE_PROJECT_ID);
  if (projectId === null) {
    return { ok: false, status: 503, code: "AUTH_CONFIG_MISSING" };
  }

  // Re-parsed on every request: removing an allowlist entry denies the next call.
  const approved = parseApprovedEmails(environment.APPROVED_EMAILS);
  if (!approved.ok) return { ok: false, status: 503, code: approved.code };

  const authorization = request.headers.get("Authorization");
  if (authorization === null) {
    return { ok: false, status: 401, code: "AUTH_TOKEN_MISSING" };
  }

  const bearer = /^Bearer (\S+)$/i.exec(authorization);
  if (bearer === null) return invalidToken;
  const token = bearer[1];

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return invalidToken;
  }

  if (header.alg !== "RS256") return invalidToken;
  if (typeof header.kid !== "string" || header.kid === "") return invalidToken;

  let key: CryptoKey | null;
  try {
    key = await dependencies.keys.getKey(header.kid);
  } catch {
    return { ok: false, status: 503, code: "AUTH_KEYS_UNAVAILABLE" };
  }
  if (key === null) return invalidToken;

  let payload: JWTPayload;
  try {
    // Issuer and audience are deliberately not jose options: jose matches an
    // audience array that *contains* the value, and the contract is an exact string.
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"],
      currentDate: new Date(now * 1_000),
      clockTolerance: 0,
    }));
  } catch {
    return invalidToken;
  }

  const claims = validateFirebaseClaims(payload, projectId, now);
  if (!claims.ok) return invalidToken;

  const email = payload.email;
  if (typeof email !== "string" || email.trim() === "") return forbidden;
  if (payload.email_verified !== true) return forbidden;
  if (signInProviderOf(payload) !== "google.com") return forbidden;

  const normalizedEmail = email.trim().toLowerCase();
  if (!approved.emails.has(normalizedEmail)) return forbidden;

  return {
    ok: true,
    identity: {
      email: normalizedEmail,
      subject: claims.subject,
      expiresAt: claims.expiresAt,
      authenticationMethod: "firebase-google",
    },
  };
};
