// @vitest-environment node
/**
 * THE SUITE RUNS AGAINST THE SHIPPED MODULE, and that sentence is in this file because twice
 * during planning a fix was reported as measured while the measurement ran against something
 * ADJACENT to what would ship -- once a pure-function re-implementation, once two closures inside
 * a test file that never called a handler. Every row below calls `handleGetWatch`/`handlePutWatch`
 * from `./watch`, the module `worker/index.ts` imports.
 *
 * THE FIXTURE IS PRODUCTION, READ WITH `wrangler d1 execute --remote` ON 2026-10-02. The operator
 * runs MULTIPLE FREE-TEXT QUERIES PER COMPONENT TYPE, which is the shape every rule here is
 * answerable to: a design that assumes one query per type destroys live configuration.
 */

import { readFileSync } from "node:fs";
import { componentById, componentCatalog } from "../../src/data/catalog";
/**
 * THE REAL CLIENT'S HALF OF THE PRESERVATION RULE, IMPORTED RATHER THAN RE-IMPLEMENTED. There were
 * three copies of it -- the client, this file's own body builder and a python block in
 * `scripts/e2e-local.sh` -- and the one that diverged (the python block had no "is this query a
 * catalog model of its type?" term) is why no gate could see the two-save data loss W-twice now
 * pins. The e2e no longer computes the set at all; it echoes the wire's own `keptSearches`, which
 * W-kept-agree proves is the same set for an untouched load.
 */
import { preservableTargets, watchModelsFor } from "../../src/services/watchSelection";
import { allSelection, derivedTargetCount } from "../../src/utils/validation";
import type { ComponentType, ModelSelection } from "../../src/types";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import {
  claim,
  fingerprint,
  seedEvaluationCorpus,
} from "../testing/evaluationFingerprint";
import { buildStorageComponentId } from "../normalize/catalogIndex";
import {
  handleGetWatch,
  handlePutWatch,
  LOCATION_SLUGS,
  MAX_WATCH_BODY_BYTES,
  MAX_WATCH_TARGETS,
  type WatchBody,
} from "./watch";

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await database.dispose();
});

/** PRODUCTION'S NINE ROWS: six component types, nine queries, the cap exactly spent. */
const LIVE: [string, string, string][] = [
  ["cpu-ryzen", "cpu", "ryzen"],
  ["cpu-toronto", "cpu", "cpu"],
  ["gpu-radeon", "gpu", "radeon"],
  ["gpu-rtx", "gpu", "rtx"],
  ["gpu-toronto", "gpu", "graphics card"],
  ["mobo-toronto", "motherboard", "motherboard"],
  ["psu-toronto", "psu", "power supply"],
  ["ram-ddr4", "ram", "ddr4 ram"],
  ["storage-ssd", "storage", "ssd"],
];

const TORONTO = { slug: "toronto", latitude: 43.6532, longitude: -79.3832 };
const WATERLOO = { slug: "waterloo", latitude: 43.4643, longitude: -80.5204 };

const insertMarket = (slug = "toronto", latitude = 43.6532, longitude = -79.3832, radius = 25) =>
  database.db
    .prepare(
      "INSERT INTO watch_market (id, location, latitude, longitude, radius_km) VALUES (1,?1,?2,?3,?4)",
    )
    .bind(slug, latitude, longitude, radius);

const insertTarget = (targetId: string, componentType: string, query: string) =>
  database.db
    .prepare("INSERT INTO watch_targets (target_id, component_type, query) VALUES (?1,?2,?3)")
    .bind(targetId, componentType, query);

const seedLive = async () => {
  await truncateAll(database.db);
  await database.db.batch([
    insertMarket(),
    ...LIVE.map(([id, type, query]) => insertTarget(id, type, query)),
  ]);
};

const rows = async () =>
  (
    await database.db
      .prepare("SELECT target_id, component_type, query FROM watch_targets ORDER BY target_id")
      .all<{ target_id: string; component_type: string; query: string }>()
  ).results;

/** `component_type:query` -- the identity of a SEARCH, which is what must not be lost. */
const searches = async () => (await rows()).map((row) => `${row.component_type}:${row.query}`).sort();

const putRequest = (body: unknown) =>
  new Request("https://worker.example.test/api/watch", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** THE WHOLE HANDLER, body read included, exactly as `worker/index.ts` calls it. */
const put = (body: unknown, db: D1Database = database.db) => handlePutWatch(putRequest(body), db);

const get = async (db: D1Database = database.db): Promise<WatchBody> => {
  const result = await handleGetWatch(db);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.body;
};

/**
 * THE FORM'S OWN STATE, built from a wire response exactly as `src/App.tsx` builds it on load and
 * after a save: `ModelSelection` per type, with the echoed query held OUTSIDE it.
 */
const formStateFrom = (
  state: WatchBody,
  over: Partial<{ components: string[]; models: Record<string, unknown> }> = {},
) => {
  const components = (over.components ?? state.selection.components) as ComponentType[];
  const wireModels = (over.models ?? state.selection.models) as Record<
    string,
    { mode: string; values: string[]; query?: string } | undefined
  >;
  const models: Partial<Record<ComponentType, ModelSelection>> = {};
  const queries: Partial<Record<ComponentType, string>> = {};
  for (const [type, selection] of Object.entries(wireModels)) {
    if (selection === undefined) continue;
    models[type as ComponentType] =
      selection.mode === "selected"
        ? { mode: "selected", values: selection.values }
        : allSelection();
    if (selection.mode === "all" && selection.query !== undefined) {
      queries[type as ComponentType] = selection.query;
    }
  }
  return { components, models, queries, storedTargets: state.storedTargets };
};

type FormState = ReturnType<typeof formStateFrom>;

/** THE BODY `src/App.tsx`'s `save()` SENDS, through the client's own helpers and no copy of them. */
const bodyFromForm = (
  form: FormState,
  over: Partial<{ preservedTargetIds: string[]; location: typeof TORONTO; radiusKm: number }> = {},
) => ({
  components: form.components,
  models: watchModelsFor(form.components, form.models, form.queries),
  location: over.location ?? TORONTO,
  radiusKm: over.radiusKm ?? 25,
  preservedTargetIds:
    over.preservedTargetIds ??
    preservableTargets(form.storedTargets, form.components, form.models, form.queries).map(
      (row) => row.targetId,
    ),
});

/** The number the budget line renders, from the same two helpers the form uses. */
const formBudget = (form: FormState) =>
  derivedTargetCount(form.components, form.models) +
  preservableTargets(form.storedTargets, form.components, form.models, form.queries).length;

const saveBodyFrom = (
  state: WatchBody,
  over: Partial<{
    components: string[];
    models: Record<string, unknown>;
    preservedTargetIds: string[];
    location: typeof TORONTO;
    radiusKm: number;
  }> = {},
) => bodyFromForm(formStateFrom(state, over), over);

describe("the watch list the BROWSER reads and writes", () => {
  /**
   * W-prod: THE SINGLE MOST VALUABLE ROW IN THE SLICE. Nine rows in, nine rows out, no query
   * changed, on a Save the user did not edit.
   *
   * The two mutations it kills are the two that shipped in a prototype. Replace-all (DELETE
   * everything, re-INSERT only what derived) takes 9 rows to 6 and loses
   * `["ddr4 ram","radeon","rtx","ryzen"]` -- RETURNED AS 200. Dropping the `query` echo rewrites
   * `cpu:'ryzen'` to `cpu:'cpu'` while reporting success.
   */
  it("W-prod: an untouched Save over production's nine rows loses NOTHING", async () => {
    await seedLive();
    const before = await searches();
    expect(before).toHaveLength(9);

    const state = await get();
    // The echo, on the wire: the stored free-text query comes back as this type's broad query.
    expect(state.selection.models.cpu).toEqual({ mode: "all", values: [], query: "ryzen" });
    expect(state.selection.models.ram).toEqual({ mode: "all", values: [], query: "ddr4 ram" });
    expect(state.keptSearches.map((row) => row.targetId)).toEqual([
      "cpu-toronto",
      "gpu-rtx",
      "gpu-toronto",
    ]);

    const saved = await put(saveBodyFrom(state));
    expect(saved).toMatchObject({ ok: true, status: 200 });

    const after = await searches();
    expect(after.filter((search) => !before.includes(search))).toEqual([]);
    expect(before.filter((search) => !after.includes(search))).toEqual([]);
    expect(after).toEqual(before);
  });

  /**
   * W-narrow: NARROWING IS THE ACTION THIS SLICE EXISTS TO ENABLE, and the broad query survives
   * it. Under a delete-on-narrow rule `ddr4 ram` -- a query only `wrangler` can author -- is
   * destroyed by the first use of the feature.
   */
  it("W-narrow: narrowing ram to a model preserves 'ddr4 ram' as a kept search", async () => {
    await seedLive();
    const state = await get();
    const models: Record<string, unknown> = {};
    for (const component of state.selection.components) {
      models[component] = state.selection.models[component];
    }
    models.ram = { mode: "selected", values: [componentById.ram.models[0]] };

    const body = saveBodyFrom(state, { models });
    // One kept search is REMOVED to make room: 6 derived + 3 kept = 9. See W-deselect for why
    // nothing else frees a slot.
    body.preservedTargetIds = body.preservedTargetIds.filter((id) => id !== "gpu-rtx");

    expect(await put(body)).toMatchObject({ ok: true });
    const after = await searches();
    expect(after).toContain("ram:ddr4 ram");
    expect(after).toContain(`ram:${componentById.ram.models[0]}`);
    expect(after).toHaveLength(9);
  });

  /**
   * W-twice: TWO SAVES, THROUGH THE REAL CLIENT HELPERS, AGAINST THE REAL HANDLER. This is the one
   * test shape the slice was missing and the reason a 9-row data loss reached review: every other
   * row here stops after ONE save, and the browser suite stubs the wire so the server's `invert`
   * never runs in the browser loop.
   *
   * THE SEQUENCE IS THE SLICE'S HEADLINE ACTION: narrow a type to one model, Remove a kept search
   * to get back under the cap (the only action that frees a slot), Save -- then touch nothing and
   * Save again. Before the `invert` fix the second save deleted BOTH the new model row and the
   * `gpu:'rtx'` that was surrendered to make room for it, and the form showed 8 of 9 while D1 held
   * 9. The models are `ram.models[0]` and `cpu.models[0]`, which are in the 111-of-244 losing set.
   */
  it.each([
    ["ram", () => componentById.ram.models[0]],
    ["cpu", () => componentById.cpu.models[0]],
  ])("W-twice: narrowing %s and saving TWICE keeps every search", async (type, modelOf) => {
    await seedLive();
    const model = modelOf();

    // SAVE 1: narrow the type, and remove one kept search to fit the cap.
    const first = formStateFrom(await get());
    const narrowed: FormState = {
      ...first,
      models: { ...first.models, [type]: { mode: "selected", values: [model] } },
      storedTargets: first.storedTargets.filter((row) => row.targetId !== "gpu-rtx"),
    };
    expect(formBudget(narrowed)).toBe(MAX_WATCH_TARGETS);
    expect(await put(bodyFromForm(narrowed))).toMatchObject({ ok: true });
    const afterFirst = await searches();
    expect(afterFirst).toContain(`${type}:${model}`);
    expect(afterFirst).toHaveLength(9);

    // THE RE-SEED: the narrowing must still be on screen, the broad query must be a VISIBLE kept
    // search, and the budget must equal what D1 holds. All three were wrong before the fix.
    const state = await get();
    const reseeded = formStateFrom(state);
    expect(reseeded.models[type as ComponentType]).toEqual({ mode: "selected", values: [model] });
    const keptIds = preservableTargets(
      reseeded.storedTargets,
      reseeded.components,
      reseeded.models,
      reseeded.queries,
    ).map((row) => row.targetId);
    expect(keptIds).toEqual(state.keptSearches.map((row) => row.targetId));
    expect(formBudget(reseeded)).toBe((await rows()).length);

    // SAVE 2, untouched.
    expect(await put(bodyFromForm(reseeded))).toMatchObject({ ok: true });
    expect(await searches()).toEqual(afterFirst);
  });

  /**
   * W-kept-agree: THE WIRE'S `keptSearches` AND THE BROWSER'S KEPT LIST ARE THE SAME SET FOR AN
   * UNTOUCHED LOAD, and that identity is what lets `scripts/e2e-local.sh` echo the wire's own field
   * instead of carrying a third copy of the preservation rule -- the copy that diverged, had no
   * "is this a catalog model of its type?" term, and so could not see W-twice's defect in principle.
   *
   * The fixture mixes every shape the inversion can meet: a narrowed type with a broad row beside
   * it, a type with two broad rows, a model-named row, and a `component_type` outside the catalog.
   */
  it("W-kept-agree: the residue is exactly the browser's kept list, and every residue row is a non-model", async () => {
    await truncateAll(database.db);
    await database.db.batch([
      insertMarket(),
      insertTarget("gpu-broad", "gpu", "graphics card"),
      insertTarget("gpu-zz-model", "gpu", componentById.gpu.models[0]),
      insertTarget("cpu-a", "cpu", "ryzen"),
      insertTarget("cpu-b", "cpu", "cpu"),
      insertTarget("legacy-ebay", "ebay", "gpu deals"),
      insertTarget("fan-broad", "case_fan", "quiet fans"),
    ]);

    const state = await get();
    const form = formStateFrom(state);
    const keptIds = preservableTargets(
      form.storedTargets,
      form.components,
      form.models,
      form.queries,
    ).map((row) => row.targetId);

    expect(keptIds).toEqual(state.keptSearches.map((row) => row.targetId));
    // Non-empty, so the equality is not satisfied by both sides losing.
    expect(keptIds).toEqual(["cpu-b", "gpu-broad", "legacy-ebay"]);
    // EVERY residue row is a non-model of its own type -- the property the agreement rests on.
    for (const row of state.keptSearches) {
      const type = row.componentType === "case_fan" ? "case_fans" : row.componentType;
      const known = Object.hasOwn(componentById, type)
        ? componentById[type as ComponentType].models
        : [];
      expect(known, `${row.targetId} must not be a model of ${type}`).not.toContain(row.query);
    }
    // ...and the narrowed type kept its model while its broad row became a kept search.
    expect(state.selection.models.gpu).toEqual({
      mode: "selected",
      values: [componentById.gpu.models[0]],
    });
  });

  /**
   * W-deselect: DESELECTING A COMPONENT DOES NOT FREE A BUDGET SLOT -- under the symmetric rule it
   * converts a derived slot into a kept one. The derived/kept SPLIT is what tells the UI to say
   * "remove a kept search"; pinning only the total would let the copy say "deselect a component",
   * which is measurably wrong advice.
   */
  it("W-deselect: deselecting two types and narrowing one is still over budget, 4 derived + 6 kept", async () => {
    await seedLive();
    const state = await get();
    const components = state.selection.components.filter(
      (component) => component !== "psu" && component !== "motherboard",
    );
    const models: Record<string, unknown> = {};
    for (const component of components) models[component] = state.selection.models[component];
    models.ram = { mode: "selected", values: [componentById.ram.models[0]] };

    const result = await put(saveBodyFrom(state, { components, models }));
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "WATCH_TARGETS_EXCEEDED",
      details: { targets: 10, maximum: 9, derived: 4, kept: 6 },
    });
    expect(await rows()).toHaveLength(9);
  });

  /** W-remove: omitting a kept id removes exactly that row. Without it a kept search is forever. */
  it("W-remove: omitting one kept id removes that row and nothing else", async () => {
    await seedLive();
    const state = await get();
    const body = saveBodyFrom(state);
    body.preservedTargetIds = body.preservedTargetIds.filter((id) => id !== "gpu-rtx");

    expect(await put(body)).toMatchObject({ ok: true });
    const after = await searches();
    expect(after).not.toContain("gpu:rtx");
    expect(after).toHaveLength(8);
  });

  /**
   * W-required: ABSENT IS A 400, NEVER `[]`. Defaulting it turns any save from a client that does
   * not know about the field into a silent delete of every kept search.
   */
  it("W-required: an absent preservedTargetIds is a 400 and the list is untouched", async () => {
    await seedLive();
    const state = await get();
    const body = saveBodyFrom(state) as Record<string, unknown>;
    delete body.preservedTargetIds;

    expect(await put(body)).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "preservedTargetIds", detail: "required" },
    });
    expect(await rows()).toHaveLength(9);
  });

  /** W-invented: trusting the client's list makes it a client-controlled delete. */
  it("W-invented: an id outside the server's own preservable set is refused BY NAME", async () => {
    await seedLive();
    const state = await get();
    const body = saveBodyFrom(state);
    body.preservedTargetIds = [...body.preservedTargetIds, "invented-id"];

    expect(await put(body)).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "preservedTargetIds", detail: "invented-id" },
    });
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-query-rules: the four shapes of a bad `models[t]`, and the last one is the one that matters
   * most -- an unknown key is REFUSED, not dropped. Dropped-not-refused makes the wire unable to
   * tell "the client echoed a query" from "the client sent nothing".
   */
  it("W-query-rules: query is required under all, forbidden under selected, never a model name, and an unknown key is refused", async () => {
    await seedLive();
    const base = {
      components: ["gpu"],
      location: TORONTO,
      radiusKm: 25,
      preservedTargetIds: [] as string[],
    };
    const cases: [string, unknown, Record<string, unknown>][] = [
      [
        "query missing under all",
        { gpu: { mode: "all", values: [] } },
        { code: "INVALID_WATCH", details: { field: "models.gpu.query", detail: "undefined" } },
      ],
      [
        "query present under selected",
        { gpu: { mode: "selected", values: ["GeForce RTX 5080"], query: "x" } },
        {
          code: "INVALID_WATCH",
          details: { field: "models.gpu.query", detail: "forbidden under mode:selected" },
        },
      ],
      [
        "a catalog model sent as a broad query",
        { gpu: { mode: "all", values: [], query: "GeForce RTX 5080" } },
        {
          code: "INVALID_WATCH",
          details: {
            field: "models.gpu.query",
            detail: "a catalog model name must be sent as mode:selected",
          },
        },
      ],
      [
        "an unknown key inside models[t]",
        { gpu: { mode: "all", values: [], query: "radeon", targetId: "x" } },
        { code: "WATCH_FIELD_UNSUPPORTED", details: { fields: ["models.gpu.targetId"] } },
      ],
      [
        "values non-empty under all",
        { gpu: { mode: "all", values: ["GeForce RTX 5080"], query: "radeon" } },
        { code: "INVALID_WATCH", details: { field: "models.gpu.values" } },
      ],
      [
        "a model that is not of THAT type",
        { gpu: { mode: "selected", values: ["Ryzen 9 9950X3D"] } },
        { code: "INVALID_WATCH", details: { field: "models.gpu.values" } },
      ],
    ];

    for (const [label, models, expected] of cases) {
      expect(await put({ ...base, models }), label).toMatchObject({
        ok: false,
        status: 400,
        ...expected,
      });
    }
    // An unknown key at the TOP level is refused the same way, with the list sorted.
    expect(
      await put({ ...base, models: { gpu: { mode: "all", values: [], query: "radeon" } }, zz: 1, aa: 2 }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "WATCH_FIELD_UNSUPPORTED",
      details: { fields: ["aa", "zz"] },
    });
    // Nothing above wrote: the valid form is what proves the fixture could have succeeded.
    expect(await rows()).toHaveLength(9);
    expect(
      await put({
        ...base,
        models: { gpu: { mode: "all", values: [], query: "radeon" } },
        preservedTargetIds: ["cpu-ryzen", "cpu-toronto", "gpu-rtx", "mobo-toronto", "psu-toronto", "ram-ddr4", "storage-ssd"],
      }),
    ).toMatchObject({ ok: true });
  });

  /**
   * W-collide: a derived id equal to a kept id is a NAMED 400 BEFORE the batch. Letting it reach
   * the batch makes a `UNIQUE constraint failed` surface as WATCH_STORAGE_FAILED -- "the write
   * failed" for a save that was simply impossible, with two different fixes behind one code.
   */
  it("W-collide: a derived target_id equal to a kept one is a 400 naming the collision", async () => {
    await truncateAll(database.db);
    await database.db.batch([
      insertMarket(),
      // `gpuu` is outside the catalog, so this row is preservable; its id is exactly what deriving
      // gpu with the query "radeon" produces.
      insertTarget("gpu-radeon", "gpuu", "radeon"),
    ]);

    const result = await put({
      components: ["gpu"],
      models: { gpu: { mode: "all", values: [], query: "radeon" } },
      location: TORONTO,
      radiusKm: 25,
      preservedTargetIds: ["gpu-radeon"],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "models.gpu.query", detail: "gpu-radeon collides with a kept search" },
    });
    // NOTHING WAS WRITTEN: the refusal is before the batch, so the prior row is byte-identical.
    expect(await rows()).toEqual([
      { target_id: "gpu-radeon", component_type: "gpuu", query: "radeon" },
    ]);
  });

  /**
   * W-dedupe: TWO SLOTS DOING THE IDENTICAL SEARCH COLLAPSE TO ONE, AND THE BUDGET COUNTS THE
   * COLLAPSED SET. The fixture is built so that dropping the dedupe does not merely leave an extra
   * row -- it makes the save FAIL at 10 of 9, while the thing the budget exists to prevent (two
   * slots issuing one request) is what the tenth slot was.
   *
   * The two duplicate rows are PRESERVED ones, which is the only way a duplicate can reach the
   * final set: `preservableIds` already excludes a stored row the derivation is rewriting.
   */
  it("W-dedupe: identical (component_type, query) rows collapse to one slot and one row", async () => {
    await truncateAll(database.db);
    await database.db.batch([
      insertMarket(),
      insertTarget("gpu-a", "gpu", "radeon"),
      insertTarget("gpu-b", "gpu", "radeon"),
      ...["c", "d", "e", "f", "g", "h", "i"].map((suffix, index) =>
        insertTarget(`pad-${suffix}`, "psu", `power supply ${index}`),
      ),
    ]);
    const stored = (await rows()).map((row) => row.target_id);
    expect(stored).toHaveLength(9);

    const result = await put({
      components: ["cpu"],
      models: { cpu: { mode: "all", values: [], query: "cpu" } },
      location: TORONTO,
      radiusKm: 25,
      preservedTargetIds: stored,
    });
    // 1 derived + 9 kept = 10 SLOTS, but two of the kept rows are the SAME SEARCH, so the deduped
    // total is 9 and the save is inside the budget. Drop the dedupe and this is a 400 at 10 of 9
    // -- a refusal whose tenth slot was a duplicate request -- and, past the budget, a ninth row
    // doing the eighth row's work while the budget reads "9 of 9".
    expect(result).toMatchObject({ ok: true });
    const after = await rows();
    expect(after.map((row) => row.target_id)).not.toContain("gpu-b");
    expect(after.filter((row) => row.query === "radeon")).toHaveLength(1);
    expect(after).toHaveLength(9);
  });

  /**
   * W-budget: the refusal counts DERIVED + KEPT. Counting only derived lets production save 6
   * derived rows beside 3 kept ones -- 12 rows at the worst -- and `MAX_TARGETS_PER_RUN` REFUSES
   * rather than truncating, so the collector then exits 2 and collects NOTHING on every run.
   */
  it("W-budget: over budget is WATCH_TARGETS_EXCEEDED with targets === derived + kept", async () => {
    await seedLive();
    const state = await get();
    const models: Record<string, unknown> = {};
    for (const component of state.selection.components) {
      models[component] = state.selection.models[component];
    }
    models.gpu = { mode: "selected", values: componentById.gpu.models.slice(0, 3) };

    const result = await put(saveBodyFrom(state, { models }));
    expect(result).toMatchObject({ ok: false, status: 400, code: "WATCH_TARGETS_EXCEEDED" });
    const details = (result as { details: Record<string, number> }).details;
    expect(details.maximum).toBe(MAX_WATCH_TARGETS);
    expect(details.targets).toBe(details.derived + details.kept);
    expect(details.targets).toBeGreaterThan(MAX_WATCH_TARGETS);
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-cap: ONE LITERAL FOR THE CAP, AND THE COLLECTOR'S IS THE AUTHORITY. The collector cannot
   * import this half (Node, `.ts`-extension imports, no DOM types), so its constant is a second
   * literal -- read here as TEXT rather than imported, because importing that module drags in the
   * collector's process-level wiring. A drift is silent in the worst way: the browser renders
   * "9 of 9 searches used" over a list the collector refuses to run at all.
   */
  it("W-cap: MAX_WATCH_TARGETS equals the collector's MAX_TARGETS_PER_RUN", () => {
    const source = readFileSync(new URL("../../collector/runTargets.ts", import.meta.url), "utf8");
    const match = /MAX_TARGETS_PER_RUN = (\d+)/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_WATCH_TARGETS);
  });

  /**
   * W-nine: ALL NINE CATALOG IDS validate, store the STORAGE spelling, read back the CATALOG
   * spelling, and the GET's own output re-PUTs at 200. Validating against `CATALOG_COMPONENT_ID`'s
   * KEYS -- they are storage ids -- makes `case_fans` a 400 and the `case_fan` spelling an
   * uncaught TypeError, i.e. a bare 500 with none of `securityHeaders`.
   */
  it("W-nine: every catalog id round-trips, and case_fans stores as case_fan", async () => {
    const storedSpellings: string[] = [];
    for (const component of componentCatalog) {
      await truncateAll(database.db);
      await insertMarket().run();
      const body = {
        components: [component.id],
        models: { [component.id]: { mode: "all", values: [], query: `${component.id} probe` } },
        location: TORONTO,
        radiusKm: 25,
        preservedTargetIds: [] as string[],
      };
      expect(await put(body), component.id).toMatchObject({ ok: true });

      const state = await get();
      expect(state.selection.components, component.id).toEqual([component.id]);
      storedSpellings.push((await rows())[0].component_type);
      // The GET's output, re-PUT: the read and the write agree on the same vocabulary.
      expect(await put(saveBodyFrom(state)), component.id).toMatchObject({ ok: true });
    }
    expect(storedSpellings).toContain("case_fan");
    expect(storedSpellings).not.toContain("case_fans");
    expect(storedSpellings).toHaveLength(9);
  });

  /** W-none: accepting `none` silently unticks the component on the next load. */
  it("W-none: mode 'none' is refused on the wire", async () => {
    await seedLive();
    expect(
      await put({
        components: ["gpu"],
        models: { gpu: { mode: "none", values: [] } },
        location: TORONTO,
        radiusKm: 25,
        preservedTargetIds: [],
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "models.gpu.mode", detail: "none" },
    });
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-rad0: AN ABSENT MARKET ROW READS AS `null`, NEVER `0`. Returning 0 loads the form already
   * invalid -- no layer accepts a radius of 0 -- with no user action to blame it on.
   */
  it("W-rad0: with no market row the GET answers location null and radiusKm null", async () => {
    await truncateAll(database.db);
    await insertTarget("gpu-toronto", "gpu", "graphics card").run();

    const state = await get();
    expect(state.selection.location).toBeNull();
    expect(state.selection.radiusKm).toBeNull();
    expect(state.selection.radiusKm).not.toBe(0);
  });

  /**
   * W-rollback: ONE BATCH, so a failing statement rolls the DELETE back and a half-written watch
   * list is unreachable. Splitting the write into two batches leaves the DELETE committed and the
   * operator's list gone.
   *
   * THE SEAM IS A POISONED BIND VALUE, NOT A REWRITTEN HANDLER. No body that passes validation can
   * violate a CHECK -- that is the point of the validator -- so the market upsert is given a
   * radius of 99 on its way to D1 while the handler's own statements and batching are untouched.
   */
  it("W-rollback: a failing statement in the batch leaves the prior list byte-identical", async () => {
    await seedLive();
    const before = await rows();

    const poisoned = {
      prepare: (sql: string) => {
        const statement = database.db.prepare(sql);
        if (!sql.includes("INSERT INTO watch_market")) return statement;
        return {
          bind: (...args: unknown[]) => statement.bind(args[0], args[1], args[2], 99),
        };
      },
      batch: (statements: unknown[]) =>
        (database.db as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(statements),
    } as unknown as D1Database;

    const state = await get();
    const result = await put(saveBodyFrom(state), poisoned);
    expect(result).toMatchObject({ ok: false, status: 503, code: "WATCH_STORAGE_FAILED" });
    expect(await rows()).toEqual(before);
  });

  /** W-one: a plain INSERT instead of the `id = 1` upsert would be a second market row. */
  it("W-one: two PUTs with different markets leave exactly one watch_market row", async () => {
    await truncateAll(database.db);
    const body = (location: typeof TORONTO, radiusKm: number) => ({
      components: ["gpu"],
      models: { gpu: { mode: "all", values: [], query: "graphics card" } },
      location,
      radiusKm,
      preservedTargetIds: [] as string[],
    });

    expect(await put(body(TORONTO, 25))).toMatchObject({ ok: true });
    expect(await put(body(WATERLOO, 10))).toMatchObject({ ok: true });

    const market = await database.db
      .prepare("SELECT COUNT(*) AS n, location, radius_km FROM watch_market")
      .all<{ n: number; location: string; radius_km: number }>();
    expect(market.results[0]).toEqual({ n: 1, location: "waterloo", radius_km: 10 });
  });

  /**
   * W-loc: THE 37 SLUGS ARE A CLOSED SET AND THE COORDINATES MUST AGREE WITH THE SLUG. Pattern-only
   * validation stores nonsense: MEASURED, slugifying the original 42 labels gave 42 strings that
   * ALL pass both `LOCATION_PATTERN` and the schema GLOB, `100-front-street-w-toronto-on-m5j-1e3`
   * included.
   */
  it("W-loc: an unknown slug is a 400, and coordinates that disagree with the slug are a 400", async () => {
    await seedLive();
    expect(LOCATION_SLUGS.size).toBe(37);
    const body = (location: Record<string, unknown>) => ({
      components: ["gpu"],
      models: { gpu: { mode: "all", values: [], query: "graphics card" } },
      location,
      radiusKm: 25,
      preservedTargetIds: [] as string[],
    });

    expect(await put(body({ ...TORONTO, slug: "100-front-street-w-toronto-on-m5j-1e3" }))).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "location.slug", detail: "100-front-street-w-toronto-on-m5j-1e3" },
    });
    // The operator's home coordinates under a public landmark's slug: refused.
    expect(await put(body({ slug: "toronto", latitude: 43.6459, longitude: -79.3816 }))).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "location", detail: "coordinates" },
    });
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-rad: `Number.isInteger` IS WHAT KEEPS 12.5 OFF THE CHECK. `typeof(radius_km) = 'integer'` in
   * migrations/0005 is load-bearing because SQLite INTEGER is affinity, so without the integer
   * rule here 12.5 reaches that CHECK and answers 503 -- telling the user the service is broken
   * when their input was merely unstorable.
   */
  it.each([
    ["a non-integer", 12.5],
    ["a numeric string", "25"],
    ["zero", 0],
    ["above the maximum", 26],
    ["null", null],
    ["NaN as a JSON null", Number.NaN],
  ])("W-rad: %s radius is a 400 naming radiusKm", async (_label, radiusKm) => {
    await seedLive();
    expect(
      await put({
        components: ["gpu"],
        models: { gpu: { mode: "all", values: [], query: "graphics card" } },
        location: TORONTO,
        radiusKm,
        preservedTargetIds: [],
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_WATCH",
      details: { field: "radiusKm" },
    });
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-503: THE READ CODE AND THE WRITE CODE ARE DISTINCT. Collapsing them sends an operator to the
   * read path for a failed write, and `worker/index.ts`'s own rule is that two fixes behind one
   * code sends them to the wrong one.
   */
  it("W-503: a throwing read is WATCH_TARGETS_STORAGE_FAILED and a throwing batch is WATCH_STORAGE_FAILED", async () => {
    await seedLive();
    const throwing = {
      prepare: () => {
        throw new Error("D1_ERROR: no such table");
      },
      batch: () => {
        throw new Error("D1_ERROR: no such table");
      },
    } as unknown as D1Database;

    await expect(handleGetWatch(throwing)).resolves.toEqual({
      ok: false,
      status: 503,
      code: "WATCH_TARGETS_STORAGE_FAILED",
    });

    const state = await get();
    const body = saveBodyFrom(state);
    expect(await put(body, throwing)).toMatchObject({
      ok: false,
      status: 503,
      code: "WATCH_TARGETS_STORAGE_FAILED",
    });

    const batchFails = {
      prepare: (sql: string) => database.db.prepare(sql),
      batch: () => {
        throw new Error("D1_ERROR: the batch failed");
      },
    } as unknown as D1Database;
    expect(await put(body, batchFails)).toMatchObject({
      ok: false,
      status: 503,
      code: "WATCH_STORAGE_FAILED",
    });
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-body: the declared-then-measured two-step, and the media-type gate. Deleting the media-type
   * check accepts a `text/plain` body from a form post; deleting either size check lets the parser
   * see an unbounded string.
   */
  it("W-body: a wrong media type is 415, an oversized body is 413, and malformed JSON is 400", async () => {
    await seedLive();
    const request = (init: RequestInit) =>
      handlePutWatch(new Request("https://worker.example.test/api/watch", { method: "PUT", ...init }), database.db);

    expect(await request({ headers: { "Content-Type": "text/plain" }, body: "{}" })).toMatchObject({
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    expect(
      await request({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ components: ["gpu"], pad: "x".repeat(MAX_WATCH_BODY_BYTES) }),
      }),
    ).toMatchObject({ ok: false, status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(await request({ headers: { "Content-Type": "application/json" }, body: "{" })).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_JSON",
    });
    expect(await request({ headers: { "Content-Type": "application/json" }, body: "[]" })).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_JSON",
    });
    expect(await rows()).toHaveLength(9);
  });

  /**
   * W-store: the exhaustiveness loop closes the gap `catalogIndex.ts` names in its own comment --
   * "THE REVERSE IS NOT CAUGHT". A new catalog id with no worker spelling would otherwise bind
   * `undefined` into the INSERT, store the literal string "undefined" as a `component_type`, and
   * make that target a 400 INVALID_LISTINGS at ingest on every run forever.
   */
  it("W-store: an unmapped catalog id throws rather than binding undefined", () => {
    expect(() => buildStorageComponentId(componentCatalog)).not.toThrow();
    expect(() =>
      buildStorageComponentId([
        ...componentCatalog,
        { id: "optical_drive" as never },
      ]),
    ).toThrow(/no worker component_type for catalog id "optical_drive"/);
  });

  /**
   * W-1w: EDITING THE WATCH LIST OR THE MARKET INVALIDATES NO VERDICT. `searchRevision` is
   * `evaluateBatch`'s staleness key and a bump re-opens EVERY task in the corpus -- 348 of them in
   * production. Three PUTs of three different kinds plus a GET, and the fingerprint of
   * `search_revisions`, `search_settings` and `evaluation_tasks` is byte-identical afterwards.
   *
   * The control is W-1c in `worker/api/watchTargets.test.ts`, which performs a REAL bump and
   * asserts the fingerprint moves and is non-empty -- without it, a gutted fingerprint satisfies
   * this test and that one at once.
   */
  it("W-1w: three PUTs and a GET re-open zero evaluation tasks", async () => {
    await seedLive();
    await seedEvaluationCorpus(database.db);
    expect(await claim(database.db)).toBe(0);

    const before = await fingerprint(database.db);
    expect(before.revisions.length).toBeGreaterThan(0);
    expect(before.settings.length).toBeGreaterThan(0);
    expect(before.tasks.length).toBeGreaterThan(0);

    // 1: add a type.
    const first = await get();
    const withCooler = saveBodyFrom(first, {
      components: [...first.selection.components, "cpu_cooler"],
      models: {
        ...Object.fromEntries(
          first.selection.components.map((c) => [c, first.selection.models[c]]),
        ),
        cpu_cooler: { mode: "all", values: [], query: "cpu cooler" },
      },
    });
    withCooler.preservedTargetIds = withCooler.preservedTargetIds.filter(
      (id) => id !== "gpu-rtx" && id !== "gpu-toronto",
    );
    expect(await put(withCooler)).toMatchObject({ ok: true });

    // 2: narrow a type to `selected`.
    const second = await get();
    const models: Record<string, unknown> = {};
    for (const component of second.selection.components) {
      models[component] = second.selection.models[component];
    }
    models.storage = { mode: "selected", values: [componentById.storage.models[0]] };
    expect(await put(saveBodyFrom(second, { models }))).toMatchObject({ ok: true });

    // 3: change the location AND the radius.
    const third = await get();
    expect(
      await put(saveBodyFrom(third, { location: WATERLOO, radiusKm: 10 })),
    ).toMatchObject({ ok: true });

    // ...and a read.
    await get();

    expect(await claim(database.db)).toBe(0);
    expect(await fingerprint(database.db)).toEqual(before);
  });
});
