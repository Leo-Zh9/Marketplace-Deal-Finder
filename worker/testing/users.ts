/**
 * Test helpers for the 0009 per-user state. `truncateAll` leaves user 1 claimed by TEST_OWNER_EMAIL,
 * Started, with no area and no rule; these set what a test needs.
 */

import { TEST_OWNER_EMAIL } from "./d1";
import type { DealMode } from "../evaluation/types";
import { loadUser, type User } from "../users/users";

/** An environment whose allowlist approves the owner and the two extra test users. */
export const TEST_ALLOWLIST = JSON.stringify([
  TEST_OWNER_EMAIL,
  "second@example.com",
  "third@example.com",
]);

export const setArea = async (
  db: D1Database,
  area: { location?: string; latitude: number; longitude: number; radiusKm: number } | null,
  userId = 1,
): Promise<void> => {
  await db
    .prepare(
      `UPDATE users SET location = ?1, latitude = ?2, longitude = ?3, radius_km = ?4
        WHERE user_id = ?5`,
    )
    .bind(
      area === null ? null : (area.location ?? "toronto"),
      area?.latitude ?? null,
      area?.longitude ?? null,
      area?.radiusKm ?? null,
      userId,
    )
    .run();
};

export const setRule = async (
  db: D1Database,
  rule: { mode: DealMode; bp?: number | null; max?: number | null } | null,
  userId = 1,
): Promise<void> => {
  await db
    .prepare(
      `UPDATE users SET mode = ?1, minimum_discount_bp = ?2, maximum_price_cents = ?3
        WHERE user_id = ?4`,
    )
    .bind(rule?.mode ?? null, rule?.bp ?? null, rule?.max ?? null, userId)
    .run();
};

export const setMonitoring = async (db: D1Database, enabled: boolean, userId = 1) => {
  await db
    .prepare(`UPDATE users SET monitoring_enabled = ?1 WHERE user_id = ?2`)
    .bind(enabled ? 1 : 0, userId)
    .run();
};

export const addUser = async (
  db: D1Database,
  userId: number,
  email: string,
  enabled = true,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO users (user_id, email, monitoring_enabled, monitoring_changed_at, created_at)
       VALUES (?1, ?2, ?3, 0, 0)`,
    )
    .bind(userId, email, enabled ? 1 : 0)
    .run();
};

export const addTarget = async (
  db: D1Database,
  targetId: string,
  componentType: string,
  query: string,
  userId = 1,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO user_watch_targets (user_id, target_id, component_type, query)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(userId, targetId, componentType, query)
    .run();
};

/** Mark a stored listing as seen in an area. */
export const addMember = async (
  db: D1Database,
  marketKey: string,
  listingId: string,
  source = "facebook-marketplace",
  lastSeenAt = 0,
): Promise<void> => {
  await db
    .prepare(
      `INSERT OR IGNORE INTO listing_markets (market_key, source, listing_id, last_seen_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(marketKey, source, listingId, lastSeenAt)
    .run();
};

export const owner = async (db: D1Database, userId = 1): Promise<User> => {
  const user = await loadUser(db, userId);
  if (user === null) throw new Error(`no user ${userId}`);
  return user;
};
