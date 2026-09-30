import { userPreferencesDb } from '@/modules/database/index.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * The one answer to "which tool policy applies to this user's turn".
 *
 * A tool policy is what the settings dialog stores per provider - allowed and
 * disallowed tools, whether permissions are skipped, whether one process is
 * kept for the whole conversation. Every device used to send its own copy
 * with each message, read from that page's in-memory mirror of the settings:
 * a tab opened before a switch was flipped kept sending the old value, and
 * two devices could run one conversation under two policies - one of them
 * starting a fresh process, and killing the other's background work, on
 * every message.
 *
 * The server's copy in `user_preferences` is what every device writes to and
 * reads from on load, so it is the truth here. What the client sent is used
 * only when the server has nothing for the user (never saved, or a caller
 * without a user), and then only as it came.
 */

/**
 * Preference key each provider keeps its policy under. Mirrors the client's
 * `PROVIDER_PERMISSION_PREFERENCE_KEYS`, which decides where the settings
 * dialog writes.
 */
const POLICY_PREFERENCE_KEYS: Record<string, string> = {
  claude: 'claudePermissions',
  cursor: 'cursorPermissions',
  codex: 'codexPermissions',
  opencode: 'opencodePermissions',
};

export type ToolPolicySource = 'server' | 'client';

export type ToolPolicyResolution = {
  /** The settings the runtime should run the turn under; undefined when nobody has any. */
  toolsSettings: AnyRecord | undefined;
  /** Where they came from, for the runtime's diagnostics. */
  source: ToolPolicySource;
};

type ToolPolicyDependencies = {
  readPreferences(userId: number): Record<string, unknown>;
};

const isRecord = (value: unknown): value is AnyRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Preferences are keyed by the numeric user id; anything else has no server copy. */
function toUserId(userId: string | number | null | undefined): number | null {
  const parsed = Number(userId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Creates the resolver with an explicit preferences reader, so tests need no database. */
export function createToolPolicyService(dependencies: ToolPolicyDependencies) {
  return {
    /**
     * The policy a turn runs under: the user's stored one for the provider,
     * else what the client sent.
     * @param input.provider - Provider the session belongs to
     * @param input.userId - The user behind the turn, as the auth layer reports it
     * @param input.clientToolsSettings - `options.toolsSettings` as the client sent them
     */
    resolve(input: {
      provider: string;
      userId: string | number | null | undefined;
      clientToolsSettings: unknown;
    }): ToolPolicyResolution {
      const fallback: ToolPolicyResolution = {
        toolsSettings: isRecord(input.clientToolsSettings) ? input.clientToolsSettings : undefined,
        source: 'client',
      };

      const userId = toUserId(input.userId);
      const key = POLICY_PREFERENCE_KEYS[input.provider];
      if (userId === null || !key) {
        return fallback;
      }

      let stored: unknown;
      try {
        stored = dependencies.readPreferences(userId)[key];
      } catch (error) {
        // A preferences read that fails must not fail the turn; the client's
        // copy is the best answer left.
        console.error(`[ToolPolicy] Could not read ${key} for user ${userId}:`, error instanceof Error ? error.message : error);
        return fallback;
      }

      return isRecord(stored) ? { toolsSettings: stored, source: 'server' } : fallback;
    },
  };
}

/** The resolver backed by `user_preferences`. */
export const toolPolicyService = createToolPolicyService({
  readPreferences: (userId) => userPreferencesDb.getPreferences(userId),
});
