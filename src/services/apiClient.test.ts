import { ApiRequestError } from "../auth/authTypes";
import { requestErrorMessage, requestJson } from "./apiClient";

const responseFetcher = (response: Response): typeof fetch =>
  vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;

describe("API authentication handling", () => {
  it("returns JSON for an authorized request", async () => {
    const fetcher = responseFetcher(
      new Response(JSON.stringify({ email: "local-dev@localhost" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(requestJson("/api/auth/session", {}, fetcher)).resolves.toEqual({
      email: "local-dev@localhost",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it.each([
    [401, "unauthenticated", "sign in with Google again"],
    [403, "forbidden", "does not have access"],
  ] as const)("classifies a %s response as %s", async (status, kind, message) => {
    await expect(
      requestJson(
        "/api/auth/session",
        {},
        responseFetcher(new Response(null, { status })),
      ),
    ).rejects.toMatchObject({
      kind,
      status,
      message: expect.stringContaining(message),
    });
  });

  it("keeps provider failures separate from authentication failures", () => {
    expect(requestErrorMessage(new Error("Facebook unavailable"), "Provider unavailable")).toBe(
      "Provider unavailable",
    );
    expect(
      requestErrorMessage(
        new ApiRequestError("Sign in again", "unauthenticated", 401),
        "Provider unavailable",
      ),
    ).toBe("Sign in again");
  });
});
