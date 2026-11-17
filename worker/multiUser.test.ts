// @vitest-environment node

/**
 * MULTI-USER (migrations/0009), through the REAL handleRequest: identity -> `users` row, the local
 * second identity, the owner-claim guard, the user cap, and per-user isolation on every route.
 */

import type { AuthDependencies } from "./auth/verifyFirebaseToken";
import { handleRequest, type Environment } from "./index";
import { createTestDatabase, TEST_OWNER_EMAIL, truncateAll, type TestDatabase } from "./testing/d1";
import { createTokenFactory } from "./testing/firebaseTokens";
import { addMember } from "./testing/users";

const projectId = "multi-user-test";
const appOrigin = "https://deals.pages.dev";
const workerOrigin = "https://api.example.workers.dev";
const NOW = 1_800_000_000;
const SOURCE = "facebook-marketplace";

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

const production = (overrides: Partial<Environment> = {}): Environment => ({
  APP_ENV: "production",
  FIREBASE_PROJECT_ID: projectId,
  ALLOWED_ORIGINS: JSON.stringify([appOrigin]),
  APPROVED_EMAILS: JSON.stringify([
    TEST_OWNER_EMAIL,
    "second@example.com",
    "third@example.com",
    "fourth@example.com",
  ]),
  DB: database.db,
  ...overrides,
});

const local = (): Environment => ({
  APP_ENV: "local",
  ALLOWED_ORIGINS: JSON.stringify(["http://localhost:5173"]),
  DB: database.db,
});

const bearer = async (email: string) => `Bearer ${await factory.sign({ now: NOW, email })}`;

const asFirebase = async (email: string, path: string, init: RequestInit = {}, env = production()) =>
  handleRequest(
    new Request(`${workerOrigin}${path}`, {
      ...init,
      headers: {
        Authorization: await bearer(email),
        Origin: appOrigin,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
    env,
    dependencies,
  );

/** The local identity, optionally a NAMED second one through X-Local-User. */
const asLocal = (name: string | null, path: string, init: RequestInit = {}) =>
  handleRequest(
    new Request(`http://localhost:8787${path}`, {
      ...init,
      headers: {
        ...(name === null ? {} : { "X-Local-User": name }),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    }),
    local(),
    dependencies,
  );

const userRows = async () =>
  (await database.db.prepare("SELECT user_id, email, monitoring_enabled FROM users ORDER BY user_id").all())
    .results;

describe("identity -> users row", () => {
  /**
   * U-local-1: X-Local-User NAMES A SECOND LOCAL IDENTITY, local + loopback only. A malformed name
   * is refused rather than silently read as the default user.
   */
  it("U-local-1: under APP_ENV=local the header selects <name>@localhost; a bad name is 401", async () => {
    const named = await asLocal("alice", "/api/auth/session");
    await expect(named.json()).resolves.toMatchObject({ identity: { email: "alice@localhost" } });
    const plain = await asLocal(null, "/api/auth/session");
    await expect(plain.json()).resolves.toMatchObject({ identity: { email: "local-dev@localhost" } });
    for (const bad of ["Alice", "a@b", "x".repeat(21), ""]) {
      expect((await asLocal(bad, "/api/auth/session")).status, bad).toBe(401);
    }
  });

  /**
   * U-local-2: PRODUCTION IGNORES THE HEADER. A Firebase owner sending X-Local-User is still the
   * owner, and a loopback request with the header and no token is 401 -- the header is read only
   * inside the local + loopback branch. Mutation: reading it before the APP_ENV check.
   */
  it("U-local-2: APP_ENV=production never reads X-Local-User", async () => {
    const response = await asFirebase(TEST_OWNER_EMAIL, "/api/auth/session", {
      headers: { "X-Local-User": "mallory" },
    });
    await expect(response.json()).resolves.toMatchObject({
      identity: { email: TEST_OWNER_EMAIL, authenticationMethod: "firebase-google" },
    });

    const loopback = await handleRequest(
      new Request("http://localhost:8787/api/settings", { headers: { "X-Local-User": "mallory" } }),
      production(),
      dependencies,
    );
    expect(loopback.status).toBe(401);
    expect(await userRows()).toEqual([{ user_id: 1, email: TEST_OWNER_EMAIL, monitoring_enabled: 1 }]);
  });

  /**
   * U-claim: AN UNCLAIMED OWNER IS 503 OWNER_UNCLAIMED, and NO empty user 2 is created for the
   * owner's own first sign-in. Mutation: dropping the owner-claimed term from PROVISION.
   */
  it("U-claim: with user 1 unclaimed, every data route is 503 OWNER_UNCLAIMED and creates nobody", async () => {
    await database.db.prepare("UPDATE users SET email = NULL WHERE user_id = 1").run();
    for (const path of ["/api/settings", "/api/watch", "/api/verdicts", "/api/status"]) {
      const response = await asFirebase("second@example.com", path);
      expect(response.status, path).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "OWNER_UNCLAIMED" } });
    }
    expect(await userRows()).toEqual([{ user_id: 1, email: null, monitoring_enabled: 1 }]);

    // The operator's claim clears it.
    await database.db
      .prepare("UPDATE users SET email = ?1 WHERE user_id = 1 AND email IS NULL")
      .bind(TEST_OWNER_EMAIL)
      .run();
    expect((await asFirebase(TEST_OWNER_EMAIL, "/api/settings")).status).toBe(200);
  });

  /** U-cap: a new user is provisioned STOPPED; the fourth distinct person is 403 USER_LIMIT_REACHED. */
  it("U-cap: provisioning creates stopped users up to MAX_USERS = 3, then refuses", async () => {
    expect((await asFirebase("second@example.com", "/api/settings")).status).toBe(200);
    expect((await asFirebase("third@example.com", "/api/settings")).status).toBe(200);
    expect((await asFirebase("second@example.com", "/api/settings")).status).toBe(200);
    const fourth = await asFirebase("fourth@example.com", "/api/settings");
    expect(fourth.status).toBe(403);
    await expect(fourth.json()).resolves.toMatchObject({ error: { code: "USER_LIMIT_REACHED" } });
    expect(await userRows()).toEqual([
      { user_id: 1, email: TEST_OWNER_EMAIL, monitoring_enabled: 1 },
      { user_id: 2, email: "second@example.com", monitoring_enabled: 0 },
      { user_id: 3, email: "third@example.com", monitoring_enabled: 0 },
    ]);
  });
});

describe("isolation: a user cannot read or write another user's data", () => {
  const TORONTO = { slug: "toronto", latitude: 43.6532, longitude: -79.3832 };
  const watchBody = (query: string, radiusKm: number) =>
    JSON.stringify({
      components: ["gpu"],
      models: { gpu: { mode: "all", values: [], query } },
      location: TORONTO,
      radiusKm,
      preservedTargetIds: [],
    });

  /**
   * U-iso: TWO LOCAL IDENTITIES WITH OVERLAPPING AREAS. Each saves their own rule and searches;
   * each reads back only their own; Stop by one leaves the other running; one shared listing seen
   * in both areas is on both pages, LABELLED BY EACH USER'S OWN RULE. No route takes a user id, so
   * there is no request that names someone else.
   */
  it("U-iso: rules, searches, areas, Start/Stop and labels are each user's own", async () => {
    await database.db
      .prepare("UPDATE users SET email = 'local-dev@localhost' WHERE user_id = 1")
      .run();
    const put = (name: string, path: string, body: string) => asLocal(name, path, { method: "PUT", body });
    expect((await put("alice", "/api/watch", watchBody("graphics card", 25))).status).toBe(200);
    expect((await put("bob", "/api/watch", watchBody("rtx", 10))).status).toBe(200);
    expect(
      (await put("alice", "/api/settings", '{"mode":"MAXIMUM_PRICE","maximumPriceCents":500000}')).status,
    ).toBe(200);
    expect(
      (await put("bob", "/api/settings", '{"mode":"MAXIMUM_PRICE","maximumPriceCents":100000}')).status,
    ).toBe(200);

    const settingsOf = async (name: string) => (await (await asLocal(name, "/api/settings")).json()) as unknown;
    expect(await settingsOf("alice")).toEqual({
      settings: { mode: "MAXIMUM_PRICE", minimumDiscountPercent: null, maximumPriceCents: 500000 },
    });
    expect(await settingsOf("bob")).toEqual({
      settings: { mode: "MAXIMUM_PRICE", minimumDiscountPercent: null, maximumPriceCents: 100000 },
    });
    const watchOf = async (name: string) =>
      (await (await asLocal(name, "/api/watch")).json()) as {
        storedTargets: { query: string }[];
        selection: { radiusKm: number };
      };
    expect((await watchOf("alice")).storedTargets.map((row) => row.query)).toEqual(["graphics card"]);
    expect((await watchOf("bob")).storedTargets.map((row) => row.query)).toEqual(["rtx"]);
    expect((await watchOf("bob")).selection.radiusKm).toBe(10);

    // Start/Stop: alice starts, bob stays stopped; bob's stop does not stop alice.
    expect((await asLocal("alice", "/api/monitoring/start", { method: "POST" })).status).toBe(200);
    expect((await asLocal("bob", "/api/monitoring/stop", { method: "POST" })).status).toBe(200);
    const statusOf = async (name: string) =>
      ((await (await asLocal(name, "/api/status")).json()) as { monitoring: { state: string } }).monitoring;
    expect(await statusOf("alice")).toMatchObject({ state: "running" });
    expect(await statusOf("bob")).toMatchObject({ state: "stopped" });

    // ONE listing, seen in BOTH areas (the 25 km and the 10 km Toronto areas overlap), priced
    // between the two maximums: a DEAL for alice, NOT_DEAL for bob.
    await database.db
      .prepare(
        `INSERT INTO listings (source, listing_id, market_key, component_type, model_key, variant_key,
           title, price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at)
         VALUES (?1, 'shared', '43.6532,-79.3832|25km', 'gpu', 'GeForce RTX 5080', '', 'RTX 5080',
                 300000, 'Toronto', 'https://e/x', 'VALID', 'h', 1, ?2)`,
      )
      .bind(SOURCE, NOW)
      .run();
    await database.db
      .prepare(
        `INSERT INTO evaluation_tasks (source, listing_id, status, created_at, verdict,
           evaluated_revision, evaluated_at, lease_expires_at, lease_token)
         VALUES (?1, 'shared', 'COMPLETE', 1, 'NEEDS_REVIEW', 0, 1, 0, '')`,
      )
      .bind(SOURCE)
      .run();
    await addMember(database.db, "43.6532,-79.3832|25km", "shared");
    await addMember(database.db, "43.6532,-79.3832|10km", "shared");

    const labelOf = async (name: string | null) =>
      ((await (await asLocal(name, "/api/verdicts")).json()) as {
        listings: { listingId: string; evaluation: { status: string } }[];
      }).listings.map((row) => `${row.listingId}:${row.evaluation.status}`);
    expect(await labelOf("alice")).toEqual(["shared:DEAL"]);
    expect(await labelOf("bob")).toEqual(["shared:NOT_DEAL"]);
    // The default local identity (the owner) has no area: nothing is shown to it.
    expect(await labelOf(null)).toEqual([]);
  });
});
