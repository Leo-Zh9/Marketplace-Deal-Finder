// @vitest-environment node

/**
 * GET and PUT /api/webhook through the REAL handleRequest: the caller's own Discord webhook,
 * write-only (migrations/0010).
 */

import type { AuthDependencies } from "../auth/verifyFirebaseToken";
import { handleRequest, type Environment } from "../index";
import { createTestDatabase, TEST_OWNER_EMAIL, truncateAll, type TestDatabase } from "../testing/d1";
import { createTokenFactory } from "../testing/firebaseTokens";

const projectId = "webhook-api-test";
const appOrigin = "https://deals.pages.dev";
const workerOrigin = "https://api.example.workers.dev";
const NOW = 1_800_000_000;
const HOOK = "https://discord.com/api/webhooks/123456789/secret-token_A";
const HOOK_B = "https://discord.com/api/webhooks/987654321/secret-token_B";
const COLLECTOR = "e2e-collector-token-4d81f0ba75c9e236";

let database!: TestDatabase;
let factory!: Awaited<ReturnType<typeof createTokenFactory>>;
let dependencies!: AuthDependencies;

beforeAll(async () => {
  database = await createTestDatabase();
  factory = await createTokenFactory(projectId);
  dependencies = { keys: factory.keys, now: () => NOW };
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(database.db);
});

const environment = (): Environment => ({
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: projectId,
  ALLOWED_ORIGINS: JSON.stringify([appOrigin]),
  APPROVED_EMAILS: JSON.stringify([TEST_OWNER_EMAIL, "second@example.com"]),
  COLLECTOR_TOKEN: COLLECTOR,
  DB: database.db,
});

const call = async (email: string | null, init: RequestInit = {}, headers: Record<string, string> = {}) =>
  handleRequest(
    new Request(`${workerOrigin}/api/webhook`, {
      ...init,
      headers: {
        Origin: appOrigin,
        ...(email === null ? {} : { Authorization: `Bearer ${await factory.sign({ now: NOW, email })}` }),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
    }),
    environment(),
    dependencies,
  );

const put = (email: string, url: unknown) => call(email, { method: "PUT", body: JSON.stringify({ url }) });

const stored = async (userId: number) =>
  database.db
    .prepare("SELECT webhook_url, alerts_reopened_at FROM users WHERE user_id = ?1")
    .bind(userId)
    .first<{ webhook_url: string | null; alerts_reopened_at: number | null }>();

describe("the webhook API", () => {
  /**
   * WH-1. WRITE-ONLY: a set, a read, a re-set and a clear, and NO response body ever carries the
   * URL. Kills: echoing the stored value in GET or PUT.
   */
  it("WH-1: set, read and clear answer {configured} only, never the URL", async () => {
    const bodies: string[] = [];
    const record = async (response: Response) => {
      const text = await response.text();
      bodies.push(text);
      return { status: response.status, body: JSON.parse(text) as unknown };
    };

    expect(await record(await call(TEST_OWNER_EMAIL))).toEqual({ status: 200, body: { configured: false } });
    expect(await record(await put(TEST_OWNER_EMAIL, HOOK))).toEqual({ status: 200, body: { configured: true } });
    expect((await stored(1))?.webhook_url).toBe(HOOK);
    expect(await record(await call(TEST_OWNER_EMAIL))).toEqual({ status: 200, body: { configured: true } });
    expect(await record(await put(TEST_OWNER_EMAIL, null))).toEqual({ status: 200, body: { configured: false } });
    expect((await stored(1))?.webhook_url).toBeNull();
    expect(bodies.join("\n")).not.toMatch(/discord|webhooks|secret-token/);
  });

  /**
   * WH-2. A URL THE SENDER WOULD NOT ACCEPT IS REFUSED, and the refusal does not repeat it. Kills:
   * skipping isValidWebhookUrl; naming the value in the error.
   */
  it.each([
    ["plain http", "http://discord.com/api/webhooks/1/secret-token_X"],
    ["another host", "https://evil.example/api/webhooks/1/secret-token_X"],
    ["a query", `${HOOK}?thread_id=1`],
    ["a loopback stub in production", "http://127.0.0.1:8798/api/webhooks/1/secret-token_X"],
    ["a number", 42],
    ["an empty string", ""],
  ])("WH-2: %s is 400 INVALID_WEBHOOK and stores nothing", async (_label, url) => {
    const response = await put(TEST_OWNER_EMAIL, url);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "INVALID_WEBHOOK" } });
    expect(text).not.toMatch(/secret-token|evil|8798/);
    expect((await stored(1))?.webhook_url).toBeNull();
  });

  it("WH-3: an unknown field is refused by name, and an absent url is invalid", async () => {
    const extra = await call(TEST_OWNER_EMAIL, { method: "PUT", body: JSON.stringify({ url: HOOK, name: "x" }) });
    expect(extra.status).toBe(400);
    await expect(extra.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_FIELD_UNSUPPORTED", fields: ["name"] },
    });
    const absent = await call(TEST_OWNER_EMAIL, { method: "PUT", body: "{}" });
    await expect(absent.json()).resolves.toMatchObject({ error: { code: "INVALID_WEBHOOK" } });
    expect((await stored(1))?.webhook_url).toBeNull();
  });

  /**
   * WH-iso. A USER CANNOT SET OR READ ANOTHER USER'S WEBHOOK. Two users set two URLs; each reads
   * only their own `configured`, and one's clear leaves the other's row alone. Kills: dropping
   * `WHERE user_id = ?3` from SET_WEBHOOK.
   */
  it("WH-iso: each user's webhook is their own", async () => {
    await put(TEST_OWNER_EMAIL, HOOK);
    await call("second@example.com");
    await expect((await call("second@example.com")).json()).resolves.toEqual({ configured: false });
    await put("second@example.com", HOOK_B);
    expect((await stored(1))?.webhook_url).toBe(HOOK);
    expect((await stored(2))?.webhook_url).toBe(HOOK_B);
    await put("second@example.com", null);
    expect((await stored(1))?.webhook_url).toBe(HOOK);
    await expect((await call(TEST_OWNER_EMAIL)).json()).resolves.toEqual({ configured: true });
  });

  /**
   * WH-reopen. SETTING A NEW URL RE-OPENS THE CALLER'S ALERTS; the same URL again, or a clear, does
   * not. A user with no destination builds no rows, so this is what lets their current deals alert.
   */
  it("WH-reopen: a new URL stamps alerts_reopened_at; the same URL and a clear do not", async () => {
    await put(TEST_OWNER_EMAIL, HOOK);
    expect((await stored(1))?.alerts_reopened_at).toBe(NOW);
    await database.db.prepare("UPDATE users SET alerts_reopened_at = 5 WHERE user_id = 1").run();
    await put(TEST_OWNER_EMAIL, HOOK);
    await put(TEST_OWNER_EMAIL, null);
    expect((await stored(1))?.alerts_reopened_at).toBe(5);
  });

  /** WH-cred. The collector's token opens nothing here, and there is no tokenless access. */
  it("WH-cred: a collector token or no token is 401", async () => {
    expect((await call(null, {}, { "X-Collector-Token": COLLECTOR })).status).toBe(401);
    expect((await call(null)).status).toBe(401);
  });

  /** WH-cors. The browser can preflight GET and PUT with Content-Type, and nothing else. */
  it("WH-cors: the preflight advertises GET, PUT and Content-Type; DELETE is refused", async () => {
    const preflight = (method: string, headers = "") =>
      handleRequest(
        new Request(`${workerOrigin}/api/webhook`, {
          method: "OPTIONS",
          headers: {
            Origin: appOrigin,
            "Access-Control-Request-Method": method,
            ...(headers === "" ? {} : { "Access-Control-Request-Headers": headers }),
          },
        }),
        environment(),
        dependencies,
      );
    const ok = await preflight("PUT", "content-type");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Methods")).toBe("GET, PUT, OPTIONS");
    expect((await preflight("DELETE")).status).toBe(403);
  });
});
