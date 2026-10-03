import { ApiRequestError } from "../auth/authTypes";

type FetchImplementation = typeof fetch;

const API_PATH_PATTERN = /^\/api\/[A-Za-z0-9._~\-/]*$/;

const resolveUrl = (path: string): string => {
  // THE QUERY HALF IS SPLIT OFF BEFORE THE PATTERN SEES IT, AND THE PATTERN IS UNCHANGED.
  // `API_PATH_PATTERN` has no `?`, `=`, `&` or `%`, so applying it to the whole string refused
  // every query string: MEASURED, the shipped client answered `ApiRequestError("Invalid API
  // path.")` with ZERO fetch calls for `/api/verdicts?all=%5B%22gpu%22%5D`, and App's catch
  // rendered "Could not load Facebook Marketplace results" -- so server-side filtering would have
  // been replaced by a hard error on the one button the page has.
  //
  // Splitting means the pattern does NOT need loosening, which is what keeps the traversal guard
  // exactly as strict as it was. Callers build the query with `URLSearchParams`, never by hand.
  const mark = path.indexOf("?");
  const pathHalf = mark === -1 ? path : path.slice(0, mark);
  const queryHalf = mark === -1 ? "" : path.slice(mark);

  // The traversal guard is part of the same check: "/api/../secret" matches the
  // character class but resolves outside the API surface. It runs on the PATH half, so a `..`
  // inside a query VALUE is harmless and a `..` in the path still throws.
  if (!API_PATH_PATTERN.test(pathHalf) || pathHalf.includes("..")) {
    throw new ApiRequestError("Invalid API path.", "unexpected");
  }

  // Read at call time, not at module load, so vi.stubEnv works.
  const base = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!base || base.startsWith("REPLACE_WITH_")) return pathHalf + queryHalf;

  const resolved = new URL(pathHalf + queryHalf, base);
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

export interface RequestOptions {
  token?: string | null;
  signal?: AbortSignal;
  fetchImplementation?: FetchImplementation;
  method?: "GET" | "PUT";
  body?: unknown;
}

export const requestJson = async <T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> => {
  const url = resolveUrl(path);

  const headers = new Headers({ Accept: "application/json" });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  // Content-Type IF AND ONLY IF there is a body: the write handlers refuse anything that is not
  // `application/json` with a 415, and a GET carrying the header would need a wider CORS
  // preflight than `preflightHeadersFor` grants a GET-only path.
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await (options.fetchImplementation ?? fetch)(url, {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
  options: Omit<RequestOptions, "token"> = {},
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
