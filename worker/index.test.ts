// @vitest-environment node

import { handleRequest } from "./index";

describe("protected Worker API", () => {
  it("serves the session and status endpoints in local development", async () => {
    const environment = { APP_ENV: "local" };
    const session = await handleRequest(
      new Request("http://localhost/api/auth/session"),
      environment,
    );
    const status = await handleRequest(
      new Request("http://localhost/api/status"),
      environment,
    );

    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      identity: { email: "local-dev@localhost" },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      status: "ok",
      phase: 2,
      authentication: "local-development",
    });
  });

  it("denies a direct production API call without an Access token", async () => {
    const response = await handleRequest(
      new Request("https://api.example.com/api/status"),
      {
        APP_ENV: "production",
        CLOUDFLARE_ACCESS_AUD: "test-audience",
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ACCESS_TOKEN_MISSING", message: "Access denied." },
    });
  });
});
