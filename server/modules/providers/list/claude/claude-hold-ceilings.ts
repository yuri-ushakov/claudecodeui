/**
 * hq fork: how long a held Claude process may stay silent before it is let go.
 *
 * Both values can be overridden from the service environment. A bad value must
 * never shorten the hold: a typo such as `12h` read by a bare parseInt would
 * become 12 ms and kill every background wait right after its turn. So only a
 * plain integer number of milliseconds within Node's timer range is accepted;
 * anything else falls back to the default and says so in the log.
 */

/** Largest delay setTimeout honours; larger values fire after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;
/** Shortest override accepted: below this a hold is effectively off. */
export const MIN_HOLD_MS = 60_000;

export const DEFAULT_BG_WAIT_CEILING_MS = 30 * 60 * 1000;
export const DEFAULT_HELD_IDLE_MS = 10 * 60 * 1000;

export function readHoldMs(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = console.warn,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < MIN_HOLD_MS || value > MAX_TIMER_MS) {
    log(`[Claude SDK] ${name}=${JSON.stringify(raw)} ignored: expected integer milliseconds in [${MIN_HOLD_MS}, ${MAX_TIMER_MS}]; using ${fallback}`);
    return fallback;
  }
  return value;
}

export const BG_WAIT_CEILING_MS = readHoldMs('CLOUDCLI_BG_WAIT_CEILING_MS', DEFAULT_BG_WAIT_CEILING_MS);
export const HELD_IDLE_MS = readHoldMs('CLOUDCLI_HELD_IDLE_MS', DEFAULT_HELD_IDLE_MS);

console.log(`[Claude SDK] hold ceilings: backgroundWorkMs=${BG_WAIT_CEILING_MS} idleMs=${HELD_IDLE_MS}`);
