/**
 * USERS (migrations/0009): who a request is, and who is ACTIVE.
 *
 * A user is an email on the APPROVED_EMAILS secret (or, under APP_ENV=local only, an address ending
 * in `@localhost`). The `users` row is created on that person's first authenticated request; there is
 * no admin UI. User 1 is the existing install, seeded by 0009 with NO email and claimed by the
 * operator after migrating -- until then provisioning answers 503 OWNER_UNCLAIMED, so the owner's own
 * first sign-in can never become an empty user 2 beside their real data.
 *
 * ACTIVE = in the allowlist AND monitoring_enabled. The collector's watch list, the monitoring run's
 * STOPPED decision and the notify step all use this one definition. AN ALLOWLIST PARSE FAILURE
 * THROWS: read as "zero users", it would silently stop every user's collection and alerts.
 */

import { parseApprovedEmails } from "../auth/verifyFirebaseToken";
import type { ValidatedSettings } from "../evaluation/dealRules";
import type { DealMode } from "../evaluation/types";
import { marketKey } from "../storage/marketKey";
import type { D1Usage } from "../storage/types";

/** The most `users` rows provisioning will create. The cap the shared search budget is sized for. */
export const MAX_USERS = 3;

/** The existing install. PR2 sends alerts for this user only. */
export const OWNER_USER_ID = 1;

export interface UserArea {
  location: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

/** The PROJECTION validateSettings applies: basis points, and NULL for the field the mode ignores. */
export interface UserRule {
  mode: DealMode;
  minimumDiscountBp: number | null;
  maximumPriceCents: number | null;
}

export interface User {
  userId: number;
  email: string | null;
  area: UserArea | null;
  rule: UserRule | null;
  monitoringEnabled: boolean;
  monitoringChangedAt: number;
  alertsReopenedAt: number | null;
}

const COLUMNS = [
  "user_id",
  "email",
  "location",
  "latitude",
  "longitude",
  "radius_km",
  "mode",
  "minimum_discount_bp",
  "maximum_price_cents",
  "monitoring_enabled",
  "monitoring_changed_at",
  "alerts_reopened_at",
] as const;

/** The columns `userFromRow` reads, optionally qualified by a table alias. */
export const userColumns = (alias?: string): string =>
  COLUMNS.map((column) => (alias === undefined ? column : `${alias}.${column}`)).join(", ");

export const USER_COLUMNS = userColumns();

export interface UserRow {
  user_id: number;
  email: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_km: number | null;
  mode: string | null;
  minimum_discount_bp: number | null;
  maximum_price_cents: number | null;
  monitoring_enabled: number;
  monitoring_changed_at: number;
  alerts_reopened_at: number | null;
}

export const userFromRow = (row: UserRow): User => ({
  userId: row.user_id,
  email: row.email,
  // The 0009 CHECK makes the four area columns NULL together, so testing one is testing all.
  area:
    row.location === null
      ? null
      : {
          location: row.location,
          latitude: row.latitude!,
          longitude: row.longitude!,
          radiusKm: row.radius_km!,
        },
  // TEXT narrowed on the way out; the column's CHECK refuses any other value at write time.
  rule:
    row.mode === null
      ? null
      : {
          mode: row.mode as DealMode,
          minimumDiscountBp: row.minimum_discount_bp,
          maximumPriceCents: row.maximum_price_cents,
        },
  monitoringEnabled: row.monitoring_enabled === 1,
  monitoringChangedAt: row.monitoring_changed_at,
  alertsReopenedAt: row.alerts_reopened_at,
});

const SELECT_BY_ID = `SELECT ${USER_COLUMNS} FROM users WHERE user_id = ?1`;
const SELECT_BY_EMAIL = `SELECT ${USER_COLUMNS} FROM users WHERE email = ?1`;

/**
 * ONE STATEMENT DECIDES BOTH REFUSALS, so a concurrent first sign-in cannot slip past either: the
 * owner must be claimed, and the table must hold fewer than MAX_USERS rows. ON CONFLICT(email) DO
 * NOTHING makes a racing duplicate a no-op rather than a 503; the caller re-reads by email.
 *
 * A NEW USER STARTS STOPPED, with no area and no rule: they Start after saving, as the dashboard's
 * MONITORING_NOT_READY already requires.
 */
const PROVISION = `INSERT INTO users (email, monitoring_enabled, monitoring_changed_at, created_at)
SELECT ?1, 0, ?2, ?2
 WHERE EXISTS (SELECT 1 FROM users WHERE user_id = ${OWNER_USER_ID} AND email IS NOT NULL)
   AND (SELECT COUNT(*) FROM users) < ?3
ON CONFLICT (email) DO NOTHING
RETURNING ${USER_COLUMNS}`;

const OWNER_CLAIMED = `SELECT email IS NOT NULL AS claimed FROM users WHERE user_id = ${OWNER_USER_ID}`;

export const loadUser = async (
  db: D1Database,
  userId: number,
  usage?: D1Usage,
): Promise<User | null> => {
  const read = await db.prepare(SELECT_BY_ID).bind(userId).all<UserRow>();
  if (usage !== undefined) {
    usage.rowsRead += read.meta.rows_read;
    usage.rowsWritten += read.meta.rows_written;
  }
  const row = read.results[0];
  return row === undefined ? null : userFromRow(row);
};

export type ResolveResult =
  | { ok: true; user: User }
  | { ok: false; status: 403 | 503; code: "OWNER_UNCLAIMED" | "USER_LIMIT_REACHED" };

/**
 * The `users` row for an authenticated email, created on first sight. Throws on a storage failure;
 * the caller maps that to its own 503.
 */
export const resolveUser = async (
  db: D1Database,
  email: string,
  now: number,
): Promise<ResolveResult> => {
  const existing = await db.prepare(SELECT_BY_EMAIL).bind(email).all<UserRow>();
  if (existing.results[0] !== undefined) return { ok: true, user: userFromRow(existing.results[0]) };

  const created = await db.prepare(PROVISION).bind(email, now, MAX_USERS).all<UserRow>();
  if (created.results[0] !== undefined) return { ok: true, user: userFromRow(created.results[0]) };

  // Nothing inserted: a racing first request won (re-read), the owner is unclaimed, or it is full.
  const raced = await db.prepare(SELECT_BY_EMAIL).bind(email).all<UserRow>();
  if (raced.results[0] !== undefined) return { ok: true, user: userFromRow(raced.results[0]) };

  const owner = await db.prepare(OWNER_CLAIMED).all<{ claimed: number }>();
  if (owner.results[0]?.claimed !== 1) {
    return { ok: false, status: 503, code: "OWNER_UNCLAIMED" };
  }
  return { ok: false, status: 403, code: "USER_LIMIT_REACHED" };
};

export interface AllowlistEnvironment {
  APP_ENV?: string;
  APPROVED_EMAILS?: string;
}

export interface Allowlist {
  emails: ReadonlySet<string>;
  /** APP_ENV=local: every `@localhost` address counts as approved. */
  localUsers: boolean;
}

/**
 * THROWS ON A PARSE FAILURE, never answers an empty set. Under APP_ENV=local an UNSET secret is the
 * documented local setup (.dev.vars.example) and reads as no emails; a SET but unparseable one still
 * throws there too.
 */
export const readAllowlist = (environment: AllowlistEnvironment): Allowlist => {
  const local = environment.APP_ENV === "local";
  const parsed = parseApprovedEmails(environment.APPROVED_EMAILS);
  if (parsed.ok) return { emails: parsed.emails, localUsers: local };
  if (local && parsed.code === "AUTH_CONFIG_MISSING") return { emails: new Set(), localUsers: true };
  throw new AllowlistError(parsed.code);
};

export class AllowlistError extends Error {
  readonly code: "AUTH_CONFIG_MISSING" | "AUTH_CONFIG_INVALID";
  constructor(code: "AUTH_CONFIG_MISSING" | "AUTH_CONFIG_INVALID") {
    super(`the APPROVED_EMAILS allowlist is unusable: ${code}`);
    this.name = "AllowlistError";
    this.code = code;
  }
}

export const isApproved = (email: string | null, allowlist: Allowlist): boolean =>
  email !== null &&
  (allowlist.emails.has(email) || (allowlist.localUsers && email.endsWith("@localhost")));

export const isActive = (user: User, allowlist: Allowlist): boolean =>
  user.monitoringEnabled && isApproved(user.email, allowlist);

const SELECT_ENABLED = `SELECT ${USER_COLUMNS} FROM users WHERE monitoring_enabled = 1 ORDER BY user_id`;

/** Every ACTIVE user, ordered by user_id, with the read's cost. */
export const loadActiveUsers = async (
  db: D1Database,
  allowlist: Allowlist,
): Promise<{ users: User[]; usage: D1Usage }> => {
  const read = await db.prepare(SELECT_ENABLED).all<UserRow>();
  return {
    users: read.results.map(userFromRow).filter((user) => isActive(user, allowlist)),
    usage: { rowsRead: read.meta.rows_read, rowsWritten: read.meta.rows_written },
  };
};

/** The market key of a user's area -- the key their sightings carry in `listing_markets`. */
export const areaMarketKey = (area: UserArea | null): string | null =>
  area === null
    ? null
    : marketKey({ latitude: area.latitude, longitude: area.longitude, radiusKm: area.radiusKm });

/**
 * The user's rule as `decide` takes it. It is ALREADY the projection (the 0009 CHECKs mirror
 * validateSettings), so nothing is re-derived. searchRevision is a placeholder: `decide` never reads
 * it, and the user's rule has no revision -- the revision belongs to the frozen evidence rule.
 */
export const ruleSettings = (rule: UserRule): ValidatedSettings => ({
  mode: rule.mode,
  basisPoints: rule.mode === "MAXIMUM_PRICE" ? null : rule.minimumDiscountBp,
  maximumPriceCents: rule.mode === "DISCOUNT" ? null : rule.maximumPriceCents,
  searchRevision: 0,
});
