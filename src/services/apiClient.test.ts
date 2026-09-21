import { ApiRequestError } from "../auth/authTypes";
import { requestErrorMessage, requestJson, requestJsonWithAuth } from "./apiClient";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetcherFor = (...responses: Response[]) => {
  const queue = [...responses];
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(queue.shift() ?? responses[responses.length - 1]),
  );
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bearer-token API transport", () => {
  it("sends the ID token and never uses credentials or redirects", async () => {
    const fetchImplementation = fetcherFor(jsonResponse({ ok: true }));

    await expect(
      requestJson("/api/auth/session", {
        token: "id-token-value",
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ ok: true });

    const [url, init] = fetchImplementation.mock.calls[0];
    expect(url).toBe("/api/auth/session");
    expect(url).not.toContain("id-token-value");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer id-token-value");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
  });

  it("prefixes the configured Worker origin, read at call time", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.workers.dev");
    const fetchImplementation = fetcherFor(jsonResponse({ ok: true }));

    await requestJson("/api/auth/session", {
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    expect(fetchImplementation.mock.calls[0][0]).toBe(
      "https://api.example.workers.dev/api/auth/session",
    );
  });

  it.each([
    "https://evil.example/steal",
    "//evil.example/x",
    "/status",
    "/api/../secret",
  ])("refuses to fetch the path %s", async (path) => {
    const fetchImplementation = fetcherFor(jsonResponse({ ok: true }));

    await expect(
      requestJson(path, {
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "unexpected" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [500, "server"],
    [503, "server"],
    [418, "unexpected"],
  ] as const)("maps status %s to kind %s", async (status, kind) => {
    await expect(
      requestJson("/api/status", {
        fetchImplementation: fetcherFor(
          jsonResponse({ error: { code: "X" } }, status),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind, status });
  });

  it("maps a thrown fetch to a network error", async () => {
    await expect(
      requestJson("/api/status", {
        fetchImplementation: (() =>
          Promise.reject(new TypeError("failed"))) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "network", code: null });
  });

  it("lifts the server error code and tolerates a non-JSON body", async () => {
    await expect(
      requestJson("/api/status", {
        fetchImplementation: fetcherFor(
          jsonResponse({ error: { code: "AUTH_KEYS_UNAVAILABLE" } }, 503),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "AUTH_KEYS_UNAVAILABLE" });

    await expect(
      requestJson("/api/status", {
        fetchImplementation: (() =>
          Promise.resolve(new Response("<html>", { status: 503 }))) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: null, kind: "server" });
  });

  it("refreshes the token once after a 401 and retries once", async () => {
    const getToken = vi
      .fn<(forceRefresh: boolean) => Promise<string | null>>()
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("fresh");
    const fetchImplementation = fetcherFor(
      jsonResponse({ error: { code: "AUTH_TOKEN_INVALID" } }, 401),
      jsonResponse({ identity: { email: "owner@example.com" } }),
    );

    await expect(
      requestJsonWithAuth("/api/auth/session", getToken, {
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ identity: { email: "owner@example.com" } });

    expect(getToken.mock.calls).toEqual([[false], [true]]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("stops after one retry when the 401 persists", async () => {
    const getToken = vi.fn(() => Promise.resolve("token"));
    const fetchImplementation = fetcherFor(
      jsonResponse({ error: { code: "AUTH_TOKEN_INVALID" } }, 401),
      jsonResponse({ error: { code: "AUTH_TOKEN_INVALID" } }, 401),
    );

    await expect(
      requestJsonWithAuth("/api/auth/session", getToken, {
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "unauthenticated" });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("never retries a 403", async () => {
    const getToken = vi.fn(() => Promise.resolve("token"));
    const fetchImplementation = fetcherFor(
      jsonResponse({ error: { code: "AUTH_FORBIDDEN" } }, 403),
    );

    await expect(
      requestJsonWithAuth("/api/auth/session", getToken, {
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken).not.toHaveBeenCalledWith(true);
  });

  it("does not retry when the refreshed token is null", async () => {
    const getToken = vi
      .fn<(forceRefresh: boolean) => Promise<string | null>>()
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce(null);
    const fetchImplementation = fetcherFor(
      jsonResponse({ error: { code: "AUTH_TOKEN_INVALID" } }, 401),
    );

    await expect(
      requestJsonWithAuth("/api/auth/session", getToken, {
        fetchImplementation: fetchImplementation as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "unauthenticated" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("keeps provider failures separate from authentication failures", () => {
    expect(
      requestErrorMessage(new Error("Facebook unavailable"), "Provider unavailable"),
    ).toBe("Provider unavailable");
    expect(
      requestErrorMessage(
        new ApiRequestError("Sign in again", "unauthenticated", 401),
        "Provider unavailable",
      ),
    ).toBe("Sign in again");
  });
});
