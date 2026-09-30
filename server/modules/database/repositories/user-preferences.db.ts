import { getConnection } from '@/modules/database/connection.js';

type PreferenceRow = {
  preference_key: string;
  preference_value: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * Decodes one stored preference, dropping any row whose JSON no longer parses
 * rather than failing the whole read. A single corrupted value must not cost
 * the user every other setting they have.
 */
function decodePreference(row: PreferenceRow): [string, unknown] | null {
  try {
    return [row.preference_key, JSON.parse(row.preference_value) as unknown];
  } catch {
    console.warn(`[UserPreferences] Dropping unreadable value for "${row.preference_key}"`);
    return null;
  }
}

/**
 * What a key holds after an update. An object-valued preference is merged
 * field by field, so a writer that owns some of its fields sends only those
 * and never erases the others' (the chat's remembered rules and the settings
 * dialog's switches share `claudePermissions`). Arrays and scalars are
 * replaced whole.
 */
function mergePreferenceValue(stored: unknown, incoming: unknown): unknown {
  return isRecord(stored) && isRecord(incoming) ? { ...stored, ...incoming } : incoming;
}

/** Every preference of one user, decoded, on the given connection. */
function readPreferences(db: ReturnType<typeof getConnection>, userId: number): Record<string, unknown> {
  const rows = db
    .prepare(
      `SELECT preference_key, preference_value
       FROM user_preferences
       WHERE user_id = ?`
    )
    .all(userId) as PreferenceRow[];

  const preferences: Record<string, unknown> = {};
  for (const row of rows) {
    const decoded = decodePreference(row);
    if (decoded) {
      preferences[decoded[0]] = decoded[1];
    }
  }

  return preferences;
}

export const userPreferencesDb = {
  /**
   * Returns every preference the user has ever set, as one object.
   *
   * The client fetches this once on start-up, so absent keys simply mean "the
   * user never changed this" and the client applies its own default.
   */
  getPreferences(userId: number): Record<string, unknown> {
    return readPreferences(getConnection(), userId);
  },

  /**
   * Merge-patches preferences at both levels: keys present in `updates` are
   * written, keys absent are left alone, a key given as `undefined` is
   * deleted - and within a key, an object value is merged field by field
   * (`mergePreferenceValue`), so a page whose copy of a setting is behind
   * cannot put its stale copy of the other fields back.
   *
   * Runs in one transaction so a multi-key save from the settings dialog can
   * never be observed half-applied.
   */
  savePreferences(userId: number, updates: Record<string, unknown>): void {
    const db = getConnection();
    const upsert = db.prepare(
      `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, preference_key) DO UPDATE SET
         preference_value = excluded.preference_value,
         updated_at = CURRENT_TIMESTAMP`
    );
    const remove = db.prepare(
      'DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?'
    );

    db.transaction(() => {
      const stored = readPreferences(db, userId);
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
          remove.run(userId, key);
          continue;
        }
        upsert.run(userId, key, JSON.stringify(mergePreferenceValue(stored[key], value)));
      }
    })();
  },
};
