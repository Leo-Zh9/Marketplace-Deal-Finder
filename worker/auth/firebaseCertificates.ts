import { importX509 } from "jose";

/**
 * Google's public signing certificates for Firebase ID tokens. The URL is a module
 * constant on purpose: a token-supplied key location (`jku`, `x5u`) is never read.
 */
export const FIREBASE_CERTIFICATE_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/**
 * The single default clock for the whole Worker auth path, in Unix SECONDS.
 * Both createCertificateStore's default `now` and authenticateRequest's default
 * dependencies resolve to this one function, so a single test pins both.
 */
export const defaultNow = (): number => Math.floor(Date.now() / 1_000);

/** Thrown when a *required* certificate fetch fails, so the caller can fail closed with 503. */
export class KeysUnavailableError extends Error {}

export interface KeySource {
  /**
   * Resolves null when the kid is unknown after a controlled refresh.
   * Throws KeysUnavailableError when a *required* fetch fails.
   */
  getKey(kid: string): Promise<CryptoKey | null>;
}

export interface CertificateStoreOptions {
  fetchImplementation?: typeof fetch;
  importKey?: (material: string) => Promise<CryptoKey>;
  now?: () => number;
  timeoutMs?: number;
  cooldownSeconds?: number;
  defaultMaxAgeSeconds?: number;
}

const maxAgeFrom = (header: string | null, fallbackSeconds: number): number => {
  const match = header === null ? null : /(?:^|,)\s*max-age=(\d+)/.exec(header);
  return match === null ? fallbackSeconds : Number(match[1]);
};

export const createCertificateStore = (
  options: CertificateStoreOptions = {},
): KeySource => {
  const importKey =
    options.importKey ?? ((material: string) => importX509(material, "RS256"));
  const now = options.now ?? defaultNow;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const cooldownSeconds = options.cooldownSeconds ?? 30;
  const defaultMaxAgeSeconds = options.defaultMaxAgeSeconds ?? 300;

  let keys = new Map<string, CryptoKey>();
  let expiresAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const doFetch = async (): Promise<void> => {
    // Read at call time so a globally stubbed fetch is honoured by a store that
    // was created earlier in the isolate.
    const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

    let response: Response;
    try {
      response = await fetchImplementation(FIREBASE_CERTIFICATE_URL, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new KeysUnavailableError("The certificate request failed.");
    }

    if (!response.ok) {
      throw new KeysUnavailableError("The certificate endpoint returned an error.");
    }

    let imported: Map<string, CryptoKey>;
    try {
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("The certificate body is not an object.");
      }

      const entries = Object.entries(body);
      if (entries.length === 0) {
        throw new Error("The certificate body is empty.");
      }

      imported = new Map<string, CryptoKey>();
      for (const [kid, material] of entries) {
        if (typeof material !== "string") {
          throw new Error("A certificate entry is not a string.");
        }
        imported.set(kid, await importKey(material));
      }
    } catch {
      throw new KeysUnavailableError("The certificate response was not usable.");
    }

    // Replace wholesale so a rotation removes retired kids.
    keys = imported;
    expiresAt =
      now() + maxAgeFrom(response.headers.get("Cache-Control"), defaultMaxAgeSeconds);
  };

  const refresh = async (): Promise<void> => {
    if (inFlight !== null) {
      await inFlight;
      return;
    }

    lastAttemptAt = now();
    inFlight = doFetch();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  return {
    async getKey(kid) {
      if (now() < expiresAt) {
        const cached = keys.get(kid);
        if (cached !== undefined) return cached;

        // Optional refresh: the cache is still usable, so a failure is swallowed.
        if (now() - lastAttemptAt < cooldownSeconds) return null;
        try {
          await refresh();
        } catch {
          return keys.get(kid) ?? null;
        }
        return keys.get(kid) ?? null;
      }

      // Required refresh: a failure must fail closed.
      await refresh();
      return keys.get(kid) ?? null;
    },
  };
};
