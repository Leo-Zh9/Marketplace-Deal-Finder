import { ApiRequestError } from "../auth/authTypes";

type FetchImplementation = typeof fetch;

const API_PATH_PATTERN = /^\/api\/[A-Za-z0-9._~\-/]*$/;

const resolveUrl = (path: string): string => {
  // The traversal guard is part of the same check: "/api/../secret" matches the
  // character class but resolves outside the API surface.
  if (!API_PATH_PATTERN.test(path) || path.includes("..")) {
    throw new ApiRequestError("Invalid API path.", "unexpected");
  }

  // Read at call time, not at module load, so vi.stubEnv works.
  const base = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!base || base.startsWith("REPLACE_WITH_")) return path;

  const resolved = new URL(path, base);
  if (resolved.origin !== new URL(base).origin) {
    throw new ApiRequestError("Invalid API path.", "unexpected");
  }
  return resolved.toString();
};

const errorCodeFrom = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const errorForResponse = async (response: Response) => {
  const body: unknown = await response.json().catch(() => null);
  const code = errorCodeFrom(body);

  if (response.status === 401) {
    return new ApiRequestError(
      "Your session has expired. Sign in with Google again.",
      "unauthenticated",
      response.status,
      code,
    );
  }

  if (response.status === 403) {
    return new ApiRequestError(
      "This Google account does not have access to the application.",
      "forbidden",
      response.status,
      code,
    );
  }

  if (response.status >= 500) {
    return new ApiRequestError(
      "The application service is temporarily unavailable.",
      "server",
      response.status,
      code,
    );
  }

  return new ApiRequestError(
    `The request failed with status ${response.status}.`,
    "unexpected",
    response.status,
    code,
  );
};

export const requestJson = async <T>(
  path: string,
  options: {
    token?: string | null;
    signal?: AbortSignal;
    fetchImplementation?: FetchImplementation;
  } = {},
): Promise<T> => {
  const url = resolveUrl(path);

  const headers = new Headers({ Accept: "application/json" });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(url, {
      method: "GET",
      credentials: "omit",
      // Also how a cross-origin redirect surfaces, rather than forwarding the token.
      redirect: "error",
      headers,
      signal: options.signal,
    });
  } catch {
    throw new ApiRequestError(
      "Could not connect to the application service.",
      "network",
    );
  }

  if (!response.ok) throw await errorForResponse(response);

  return (await response.json()) as T;
};

export const requestJsonWithAuth = async <T>(
  path: string,
  getToken: (forceRefresh: boolean) => Promise<string | null>,
  options: { signal?: AbortSignal; fetchImplementation?: FetchImplementation } = {},
): Promise<T> => {
  const token = await getToken(false);

  try {
    return await requestJson<T>(path, { ...options, token });
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.kind !== "unauthenticated") {
      throw error;
    }

    const refreshed = await getToken(true);
    if (refreshed === null) throw error;

    return await requestJson<T>(path, { ...options, token: refreshed });
  }
};

export const requestErrorMessage = (
  error: unknown,
  fallback: string | null = null,
) => (error instanceof ApiRequestError ? error.message : fallback);
