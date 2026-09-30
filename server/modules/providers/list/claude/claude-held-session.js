/**
 * A Claude CLI process kept alive across the turns of one conversation.
 *
 * By default every turn starts its own `query()`: a fresh CLI process that
 * rebuilds the session from disk through `resume`. That is robust - each turn
 * begins in a clean process, and a server restart costs nothing because the
 * state lives in the session file - but it pays the startup and the rebuild
 * again for every message, and it kills whatever the previous process still
 * had running in the background (agents, monitors, scheduled wake-ups).
 *
 * With this, the process from the first turn stays and the next message is
 * pushed into the same stdin stream. The SDK supports it: `query()` takes an
 * async iterable as its prompt, and that iterable may keep yielding.
 *
 * Two things the process was built around change from turn to turn and are
 * owned here so that nothing else has to reach through a stale reference:
 *
 * - Who is listening. Every run comes with its own writer (the chat run
 *   registry creates one per `chat.send`, whichever socket it came from), but
 *   the options handed to `query()` - `canUseTool`, the hooks - were built once,
 *   for the first turn. They and everything the process emits go through
 *   `writer`, a relay that always points at the writer of the latest turn. A
 *   message from another tab or another device therefore lands on the same
 *   process; only what the process was told to listen to changes.
 *
 * - When to let the process go. One timer, armed whenever the process is not
 *   serving a turn and re-armed by every message it sends. How long it waits
 *   depends on what the latest turn reports: an idle conversation is released
 *   after `idleMs`; one whose background work is still outstanding gets the
 *   ceiling the one-shot hold in the runtime uses as its backstop.
 *
 * What cannot change is what the CLI fixed at startup: the working directory,
 * the MCP servers, the disallowed tools, the effort. A turn that needs
 * different ones gets a new process; `matches()` decides that. Model,
 * permission mode and the allowed-tool list do change live, through the SDK's
 * own `setModel` / `setPermissionMode` and the options `canUseTool` reads.
 *
 * Letting a process go is two steps, because ending its stdin is not enough:
 * the CLI keeps running after EOF for as long as it has background agents
 * (up to the ceiling it was started with) and then serves their follow-up
 * turns with no way to ask for permissions - a zombie that writes into the
 * transcript and fails every tool. So `close()` ends stdin and, when the
 * process has not exited on its own within a short grace, closes it through
 * the SDK, which terminates it.
 */

/**
 * JSON with object keys in a fixed order, so two equal configurations always
 * produce the same string - whatever order they were written in.
 */
export function stableJson(value) {
  return JSON.stringify(value, (_key, entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry
  ));
}

/**
 * Whether an SDK message is the `result` that ends the turn being served.
 *
 * The CLI emits a `result` for every prompt it settles, and not all of them
 * are the host's. On resume it first delivers what it owes from the previous
 * process: a background agent that never reported back ("didn't finish before
 * the previous session ended") becomes a task-notification prompt, settled
 * with a `result` of its own - no model call, `num_turns: 0` - before the
 * message the turn actually sent is even looked at. Later on, an agent
 * reporting in runs a follow-up turn whose `result` is stamped the same way.
 * Taking either for the end of the user's turn closes stdin under a turn that
 * is still running, and every permission request after that fails in the CLI
 * with "Stream closed".
 *
 * The CLI marks those results with `origin.kind === 'task-notification'`; the
 * result of a prompt the host sent carries no `origin` at all.
 *
 * @param {Object} message - Raw SDK message
 * @returns {boolean}
 */
export function endsTurn(message) {
  return message?.type === 'result' && message.origin?.kind !== 'task-notification';
}

/** Held sessions by session key. */
const heldSessions = new Map();

/** How long a session may sit idle, with nothing outstanding, before its process is let go. */
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/**
 * How long a process gets to exit on its own after its stdin was ended before
 * it is terminated. A CLI with nothing outstanding is gone well within this;
 * one that is waiting for background agents would otherwise stay for the
 * whole background-work ceiling.
 */
const DEFAULT_EXIT_GRACE_MS = 5000;

/** The startup conditions `matches()` compares, in the order they are reported. */
const FIXED_AT_STARTUP = ['cwd', 'mcp', 'effort', 'disallowedTools'];

/**
 * The writer of whichever turn was served last.
 *
 * Exposes the surface the runtime relies on (`send`, `setSessionId`, `userId`,
 * `isWebSocketWriter`) and forwards each call to the current target. Built
 * once per held process; the target is switched every time a turn starts.
 */
export class LatestTurnWriter {
  /**
   * @param {Object|null} writer - Writer of the turn that starts the process
   */
  constructor(writer = null) {
    /** The writer of the turn being served, or of the last one served. */
    this.current = writer;
  }

  /**
   * Points the relay at a new turn's writer.
   * @param {Object|null} writer - Writer of the turn about to be served
   */
  switchTo(writer) {
    this.current = writer;
  }

  /**
   * Forwards one event to the current writer.
   * @param {unknown} data - Normalized message
   */
  send(data) {
    this.current?.send(data);
  }

  /**
   * Labels the current writer with the provider-native session id, when it can take one.
   * @param {string} sessionId - Provider-native session id
   */
  setSessionId(sessionId) {
    if (typeof this.current?.setSessionId === 'function') {
      this.current.setSessionId(sessionId);
    }
  }

  /**
   * Adds a socket to the current writer's audience, when it keeps one.
   * @param {Object} connection - Raw websocket connection
   */
  updateWebSocket(connection) {
    if (typeof this.current?.updateWebSocket === 'function') {
      this.current.updateWebSocket(connection);
    }
  }

  /** The user behind the current writer, for notifications. */
  get userId() {
    return this.current?.userId ?? null;
  }

  /** Mirrors the feature-detection flag of the current writer. */
  get isWebSocketWriter() {
    return Boolean(this.current?.isWebSocketWriter);
  }
}

export class HeldClaudeSession {
  /**
   * @param {Object} args
   * @param {string} args.sessionKey - Key this session is registered under
   * @param {Object} args.fingerprint - What the process was started with
   * @param {Object|null} [args.writer] - Writer of the turn that starts the process
   * @param {number} [args.idleMs] - Idle time, with nothing outstanding, before the process is released
   * @param {number} [args.backgroundWorkCeilingMs] - Idle time while background work is outstanding
   * @param {number} [args.exitGraceMs] - Time a closed process gets to exit by itself before it is terminated
   * @param {(session: HeldClaudeSession, error: Error|null) => void} [args.onEnd] - Called once the process has ended
   */
  constructor({
    sessionKey,
    fingerprint,
    writer = null,
    idleMs = DEFAULT_IDLE_MS,
    backgroundWorkCeilingMs = DEFAULT_IDLE_MS,
    exitGraceMs = DEFAULT_EXIT_GRACE_MS,
    onEnd = () => {},
  }) {
    this.sessionKey = sessionKey;
    this.fingerprint = fingerprint;
    this.idleMs = idleMs;
    this.backgroundWorkCeilingMs = backgroundWorkCeilingMs;
    this.exitGraceMs = exitGraceMs;
    this.onEnd = onEnd;
    /** When the process was attached, for the runtime's diagnostics. */
    this.startedAt = null;

    /** Where everything this process emits goes: the writer of the latest turn. */
    this.writer = new LatestTurnWriter(writer);
    /** The SDK query, once started. */
    this.instance = null;
    /** The options it was started with; its callbacks read from this. */
    this.sdkOptions = null;
    /** The tool list the last turn set, to tell it from what was remembered. */
    this.appliedAllowedTools = [];
    /** Closes stdin so the CLI can exit. */
    this.release = () => {};
    /**
     * The turn being served, or the last one served. It stays attached after
     * its `result` so that what the process pushes between turns - a
     * background agent reporting in - is handled and shown, exactly as it is
     * when a one-shot process is held open for that work.
     */
    this.turn = null;
    /** Messages waiting to go into stdin. */
    this.queue = [];
    /** Resolves the generator's pending `await` when something is queued. */
    this.wake = null;
    this.closed = false;
    this.idleTimer = null;
    /** Armed by `close()`: terminates the process if it has not exited by then. */
    this.exitTimer = null;
    /** Set while a turn is being served, so a second one cannot cut in. */
    this.busy = false;
  }

  // ---------------------------------------------------------------- turns

  /**
   * Claims the process for one turn, or refuses because it is taken.
   *
   * This has to happen before `applyTurn`, which is why it is separate from
   * `runTurn`: `applyTurn` sets the model and the permission mode on the live
   * process and writes the tool list into the options the running turn's
   * callbacks read. A second turn that changed all that and only then found
   * the session busy would leave its settings behind on someone else's turn -
   * the first one would finish under the second one's model and permissions.
   *
   * @returns {boolean} Whether the caller may now run a turn
   */
  reserve() {
    if (this.busy || this.closed || !this.instance) {
      return false;
    }

    this.busy = true;
    this.clearIdle();
    return true;
  }

  /** Gives a claim back when the turn it was for never started. */
  cancelReservation() {
    if (!this.busy) {
      return;
    }

    this.busy = false;
    this.scheduleIdle();
  }

  /**
   * Brings the live process in line with what this turn asks for.
   *
   * Only what the SDK can change mid-session: the model, the permission mode,
   * and the tool list the mode implies. Effort has no live setter, so a change
   * there is caught by `matches()` and starts a new process instead.
   *
   * @param {Object} turn
   * @param {string} [turn.model] - The model this turn asks for
   * @param {string} [turn.permissionMode] - The permission mode it asks for
   * @param {string[]} [turn.allowedTools] - Its tool list, mode entries included
   */
  async applyTurn({ model, permissionMode, allowedTools }) {
    if (model && model !== this.fingerprint.model) {
      await this.instance.setModel(model);
      this.fingerprint.model = model;
    }

    const mode = permissionMode || 'default';
    if (mode !== this.fingerprint.permissionMode) {
      await this.instance.setPermissionMode(mode);
      this.fingerprint.permissionMode = mode;
      // `canUseTool` reads the mode off the options object it was built with,
      // so the new mode has to land there too - otherwise turning off
      // "skip permissions" would leave the callback approving everything.
      if (this.sdkOptions) {
        this.sdkOptions.permissionMode = mode;
      }
    }

    this.applyAllowedTools(allowedTools);
  }

  /**
   * Puts this turn's tool list into the options the callback reads.
   *
   * The allowed list is applied here rather than compared by `matches()`: it
   * is consulted by `canUseTool` at call time, so a changed one takes effect
   * on the live process at no cost, whereas a process per change would end
   * the conversation's background work every time a rule is remembered or
   * plan mode adds its read-only set.
   *
   * Entries the callback remembered mid-conversation are in neither list, so
   * they are carried over rather than dropped.
   *
   * @param {string[]} [allowedTools] - This turn's list; anything else is ignored
   */
  applyAllowedTools(allowedTools) {
    if (!this.sdkOptions || !Array.isArray(allowedTools)) {
      return;
    }

    const remembered = (this.sdkOptions.allowedTools || [])
      .filter((tool) => !this.appliedAllowedTools.includes(tool) && !allowedTools.includes(tool));

    this.sdkOptions.allowedTools = [...allowedTools, ...remembered];
    this.appliedAllowedTools = [...allowedTools];
  }

  /**
   * Runs one turn on this process.
   *
   * Resolves when the turn's own `result` arrives (`endsTurn`); the process
   * stays, and so does the turn's handler, which keeps receiving whatever the
   * process pushes until the next turn takes over.
   *
   * @param {Object} args
   * @param {Array<Object>} args.promptMessages - What the user sent
   * @param {(message: Object) => void} args.onMessage - Receives every SDK message
   * @param {Object|null} [args.writer] - Writer of this turn; the relay switches to it
   * @param {() => boolean} [args.isHoldingForBackgroundWork] - Whether, as far as
   *   this turn knows, work is still running that the process must stay up for
   * @param {boolean} [args.reserved] - Whether the caller already claimed it
   * @returns {Promise<void>}
   */
  runTurn({ promptMessages, onMessage, writer = null, isHoldingForBackgroundWork = () => false, reserved = false }) {
    if (this.closed || !this.instance) {
      if (reserved) {
        this.busy = false;
      }
      return Promise.reject(new Error('This session is no longer held.'));
    }
    // A caller that reserved the session already holds the claim; anyone else
    // takes it here, or is turned away because a turn is running.
    if (!reserved && !this.reserve()) {
      return Promise.reject(new Error('This session is already serving a turn.'));
    }

    if (writer) {
      this.writer.switchTo(writer);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.busy = false;
        this.scheduleIdle();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.turn = {
        onMessage: (message) => {
          onMessage(message);
          if (endsTurn(message)) {
            finish(null);
          }
        },
        onError: finish,
        isHoldingForBackgroundWork,
      };

      this.push(promptMessages);
    });
  }

  /**
   * Whether this process was started with what the next turn needs.
   *
   * Only what the CLI fixes at startup is compared - see `mismatches`. Model
   * and permission mode are deliberately absent: they are set live by
   * `applyTurn`. The allowed-tool list is absent too: `applyAllowedTools`
   * puts it where `canUseTool` reads it. So is the writer: every run brings
   * its own, and the relay follows it.
   *
   * @param {Object} fingerprint - What the next turn would start a process with
   * @returns {boolean}
   */
  matches(fingerprint) {
    return !this.closed
      && this.instance !== null
      && this.mismatches(fingerprint).length === 0;
  }

  /**
   * The startup conditions on which this process and the next turn disagree.
   *
   * - `cwd` and `mcp`: the CLI resolves both when it starts.
   * - `effort`: the SDK has no live setter for it.
   * - `disallowedTools`: handed to the CLI at startup, and the CLI refuses
   *   those tools itself, before ever asking `canUseTool` - so a process
   *   started with one list cannot be made to honour another.
   *
   * Reported by name so the runtime can say why a process was not reused.
   *
   * @param {Object} fingerprint - What the next turn would start a process with
   * @returns {string[]} Names of the differing conditions; empty when it fits
   */
  mismatches(fingerprint) {
    return FIXED_AT_STARTUP.filter((field) => this.fingerprint[field] !== fingerprint[field]);
  }

  // ------------------------------------------------------ process lifetime

  /**
   * The prompt stream handed to `query()`.
   *
   * It never ends on its own: when the queue runs dry it waits, which keeps
   * stdin open and the process alive until `close()`.
   */
  async* promptStream() {
    while (!this.closed) {
      while (this.queue.length > 0) {
        yield this.queue.shift();
      }

      if (this.closed) {
        return;
      }

      await new Promise((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  /**
   * Queues messages for the CLI and wakes the stream if it is waiting.
   * @param {Array<Object>} messages - SDKUserMessage records
   */
  push(messages) {
    for (const message of messages) {
      this.queue.push(message);
    }
    this.wake?.();
  }

  /**
   * Attaches the started query and begins consuming it.
   *
   * The options object comes along because the callbacks built into it read
   * from it at call time; keeping the reference is what lets a later turn
   * correct what they see.
   *
   * @param {Object} instance - The started SDK query
   * @param {() => void} release - Closes stdin so the CLI can exit
   * @param {Record<string, unknown>|null} [sdkOptions] - The options it was started with
   */
  start(instance, release, sdkOptions = null) {
    this.instance = instance;
    this.release = release;
    this.sdkOptions = sdkOptions;
    this.startedAt = Date.now();
    /** What the last turn put there; anything beyond it was remembered live. */
    this.appliedAllowedTools = [...(sdkOptions?.allowedTools || [])];
    this.consume();
  }

  /** Seconds since the process was attached, for diagnostics; null before `start`. */
  get ageSeconds() {
    return this.startedAt === null ? null : Math.round((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Reads the query for as long as it lives, handing every message to the
   * latest turn.
   *
   * The loop outlives the individual turn - that is the whole point - and so
   * does the turn's handler: a message arriving between turns (background work
   * reporting in, a task notification) reaches the handler of the turn served
   * last, which shows it and keeps the background-work bookkeeping current.
   * Every message also counts as activity for the idle timer.
   */
  async consume() {
    let failure = null;
    try {
      for await (const message of this.instance) {
        this.turn?.onMessage(message);
        if (!this.busy) {
          this.scheduleIdle();
        }
      }
    } catch (error) {
      failure = error;
      this.turn?.onError(error);
    } finally {
      this.closed = true;
      this.clearIdle();
      this.clearExit();
      this.unregister();
      this.turn?.onError(new Error('The held Claude process ended.'));
      this.turn = null;
      this.onEnd(this, failure);
    }
  }

  /**
   * Takes this session out of the registry - only if the registry still
   * points at it. A replaced process ends after its replacement was
   * registered under the same key, and must not take that entry with it.
   */
  unregister() {
    if (heldSessions.get(this.sessionKey) === this) {
      heldSessions.delete(this.sessionKey);
    }
  }

  /** Cancels the pending release, if any. */
  clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Arms (or re-arms) the countdown that lets the process go.
   *
   * The delay is the idle allowance when nothing is outstanding, and the
   * background-work ceiling when the latest turn reports that it is still
   * holding the process for work that has not reported back. Either way the
   * countdown measures silence: any message from the process resets it.
   */
  scheduleIdle() {
    this.clearIdle();
    if (this.closed) {
      return;
    }
    const delay = this.turn?.isHoldingForBackgroundWork?.() ? this.backgroundWorkCeilingMs : this.idleMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.close();
    }, delay);
    // A held process must never be the reason the server cannot exit.
    this.idleTimer.unref?.();
  }

  /**
   * Lets the process go: ends the prompt stream, which closes stdin, and
   * terminates the process if it is still there once the grace has passed.
   *
   * The grace lets a CLI with nothing outstanding wind down on its own; the
   * termination is for one that would otherwise sit on its background agents
   * with no stdin to ask permissions through, then serve their follow-up
   * turns as failures straight into the transcript.
   */
  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearIdle();
    this.unregister();
    // Wakes the prompt stream so it can end, which closes stdin.
    this.wake?.();
    this.release();
    this.scheduleExit();
  }

  /** Arms the termination that `close()` falls back to. */
  scheduleExit() {
    if (typeof this.instance?.close !== 'function') {
      return;
    }
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      try {
        this.instance.close();
      } catch (error) {
        console.error(`[Claude SDK] Could not terminate the held process for session ${this.sessionKey}:`, error?.message || error);
      }
    }, this.exitGraceMs);
    this.exitTimer.unref?.();
  }

  /** Cancels the pending termination: the process ended by itself. */
  clearExit() {
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
  }
}

/** The session held for this key, if there is one. */
export function getHeldSession(sessionKey) {
  return sessionKey ? heldSessions.get(sessionKey) || null : null;
}

/** Registers a session under its key, replacing whatever was there. */
export function holdSession(session) {
  const previous = heldSessions.get(session.sessionKey);
  if (previous && previous !== session) {
    previous.close();
  }
  heldSessions.set(session.sessionKey, session);
}

/** Ends the held session for this key, if any. */
export function releaseHeldSession(sessionKey) {
  const session = getHeldSession(sessionKey);
  session?.close();
}

/** Ends every held session - used when the server winds down. */
export function releaseAllHeldSessions() {
  for (const session of Array.from(heldSessions.values())) {
    session.close();
  }
}
