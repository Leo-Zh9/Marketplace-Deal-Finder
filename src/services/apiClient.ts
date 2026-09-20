import { ApiRequestError } from "../auth/authTypes";

type FetchImplementation = typeof fetch;

const isAccessLoginRedirect = (response: Response) => {
  if (!response.redirected) return false;

  try {
    return new URL(response.url).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
};

const errorForResponse = (response: Response) => {
  if (response.status === 401 || isAccessLoginRedirect(response)) {
    return new ApiRequestError(
      "Your session has expired. Refresh the page to sign in with Google again.",
      "unauthenticated",
      response.status,
    );
  }

  if (response.status === 403) {
    return new ApiRequestError(
      "This Google account does not have access to the application.",
      "forbidden",
      response.status,
    );
  }

  if (response.status >= 500) {
    return new ApiRequestError(
      "The application service is temporarily unavailable.",
      "server",
      response.status,
    );
  }

  return new ApiRequestError(
    `The request failed with status ${response.status}.`,
    "unexpected",
    response.status,
  );
};

export const requestJson = async <T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImplementation: FetchImplementation = fetch,
): Promise<T> => {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let response: Response;

  try {
    response = await fetchImplementation(input, {
      ...init,
      credentials: init.credentials ?? "same-origin",
      headers,
    });
  } catch {
    throw new ApiRequestError(
      "Could not connect to the application service.",
      "network",
    );
  }

  if (!response.ok || isAccessLoginRedirect(response)) {
    throw errorForResponse(response);
  }

  return response.json() as Promise<T>;
};

export const requestErrorMessage = (
  error: unknown,
  fallback: string | null = null,
) => (error instanceof ApiRequestError ? error.message : fallback);
