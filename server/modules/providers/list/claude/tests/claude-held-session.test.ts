import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HeldClaudeSession,
  getHeldSession,
  holdSession,
} from '@/modules/providers/list/claude/claude-held-session.js';

type Fingerprint = {
  cwd: string;
  mcp: string;
  disallowedTools: string;
  effort: string;
  model: string;
  permissionMode: string;
  writer: unknown;
};

const writer = { name: 'writer' };

const fingerprint = (overrides: Partial<Fingerprint> = {}): Fingerprint => ({
  cwd: '/workspace',
  mcp: '{"chrome-tabs":{"command":"claude"}}',
  disallowedTools: '[]',
  effort: 'high',
  model: 'opus',
  permissionMode: 'default',
  writer,
  ...overrides,
});

/**
 * Stands in for the SDK query: reads the prompt stream and answers every user
 * message with one assistant message and the `result` that ends the turn.
 */
function fakeQuery(session: HeldClaudeSession, seen: unknown[]) {
  const instance = (async function* () {
    for await (const message of session.promptStream()) {
      seen.push(message);
      yield { type: 'assistant', text: 'answer' };
      yield { type: 'result', subtype: 'success' };
    }
  })() as AsyncGenerator<unknown> & {
    setModel: (model?: string) => Promise<void>;
    setPermissionMode: (mode: string) => Promise<void>;
  };

  instance.setModel = async () => {};
  instance.setPermissionMode = async () => {};
  return instance;
}

test('a held session serves two turns on the same process', async () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-1', fingerprint: fingerprint() });
  const seen: unknown[] = [];
  session.start(fakeQuery(session, seen), () => {});

  const first: unknown[] = [];
  await session.runTurn({ promptMessages: [{ text: 'one' }], onMessage: (m) => first.push(m) });

  const second: unknown[] = [];
  await session.runTurn({ promptMessages: [{ text: 'two' }], onMessage: (m) => second.push(m) });

  // Both turns went into the one stream the process is reading.
  assert.deepEqual(seen, [{ text: 'one' }, { text: 'two' }]);
  // And each turn saw its own messages, ending at its own result.
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual(second[1], { type: 'result', subtype: 'success' });

  session.close();
});

test('a turn is only handed to a process started with what it needs', () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-2', fingerprint: fingerprint() });
  session.start(fakeQuery(session, []), () => {});

  assert.equal(session.matches(fingerprint()), true, 'same startup conditions');
  assert.equal(session.matches(fingerprint({ cwd: '/elsewhere' })), false, 'other project');
  assert.equal(session.matches(fingerprint({ mcp: '' })), false, 'other mcp servers');
  // The CLI refuses disallowed tools itself, from the list it was started
  // with, so a different list needs a different process. The allowed list is
  // not compared at all: `canUseTool` reads it live (see `applyAllowedTools`).
  assert.equal(session.matches(fingerprint({ disallowedTools: '["Write"]' })), false, 'other disallowed tools');
  assert.equal(session.matches(fingerprint({ effort: 'xhigh' })), false, 'other effort');
  // And it can say which of them differ, for the runtime's log line.
  assert.deepEqual(session.mismatches(fingerprint()), []);
  assert.deepEqual(
    session.mismatches(fingerprint({ cwd: '/elsewhere', effort: 'xhigh', model: 'sonnet' })),
    ['cwd', 'effort'],
    'only what is fixed at startup is reported',
  );
  // Every run brings a writer of its own (another tab, another device, or
  // just the next message); the session's relay follows it instead of the
  // process being started over.
  assert.equal(session.matches(fingerprint({ writer: { name: 'other' } })), true, 'other writer, same process');

  // Model and permission mode are set on the live process, so they do not
  // force a new one.
  assert.equal(session.matches(fingerprint({ model: 'sonnet' })), true, 'model changes live');
  assert.equal(session.matches(fingerprint({ permissionMode: 'plan' })), true, 'mode changes live');

  session.close();
});

test('a second turn cannot touch a process that is already serving one', async () => {
  // The damage this prevents: `applyTurn` writes the model, the permission
  // mode and the tool list into what the running turn reads from. A turn that
  // did all that and only then found the session busy would leave its settings
  // behind - the first turn would finish under the second one's.
  const sdkOptions = { permissionMode: 'default', allowedTools: [] as string[] };
  const session = new HeldClaudeSession({ sessionKey: 'session-7', fingerprint: fingerprint() });

  // A query that answers nothing, so the first turn stays open. It yields
  // nothing on purpose - that is the whole fixture - so require-yield has to
  // step aside here rather than be satisfied with unreachable code.
  // eslint-disable-next-line require-yield
  const idle = (async function* () {
    for await (const _message of session.promptStream()) {
      // The turn never gets its `result`.
    }
  })() as AsyncGenerator<unknown> & {
    setModel: (model?: string) => Promise<void>;
    setPermissionMode: (mode: string) => Promise<void>;
  };
  idle.setModel = async () => {};
  idle.setPermissionMode = async () => {};
  session.start(idle, () => {}, sdkOptions);

  assert.equal(session.reserve(), true, 'the first turn claims it');
  const running = session.runTurn({
    promptMessages: [{ text: 'one' }],
    onMessage: () => {},
    reserved: true,
  });
  running.catch(() => {});

  assert.equal(session.reserve(), false, 'the second one is refused');
  await assert.rejects(
    () => session.runTurn({ promptMessages: [{ text: 'two' }], onMessage: () => {} }),
    /already serving a turn/,
  );
  assert.deepEqual(sdkOptions, { permissionMode: 'default', allowedTools: [] }, 'and changed nothing');

  session.close();
});

test('a claim that never becomes a turn is given back', () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-8', fingerprint: fingerprint() });
  session.start(fakeQuery(session, []), () => {});

  assert.equal(session.reserve(), true);
  assert.equal(session.reserve(), false);
  session.cancelReservation();
  assert.equal(session.reserve(), true, 'the process is free again, not blocked for good');

  session.close();
});

test('a closed session takes no further turns', async () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-3', fingerprint: fingerprint() });
  session.start(fakeQuery(session, []), () => {});
  session.close();

  assert.equal(session.matches(fingerprint()), false);
  await assert.rejects(
    () => session.runTurn({ promptMessages: [{ text: 'one' }], onMessage: () => {} }),
    /no longer held/,
  );
});

test('turning off "skip permissions" reaches the tool callback as well', async () => {
  // `canUseTool` reads the mode off the options object it was built with. If a
  // held process kept the first turn's object, switching the mode back would
  // leave that callback approving everything.
  const sdkOptions: { permissionMode: string } = { permissionMode: 'bypassPermissions' };
  const session = new HeldClaudeSession({
    sessionKey: 'session-5',
    fingerprint: fingerprint({ permissionMode: 'bypassPermissions' }),
  });
  session.start(fakeQuery(session, []), () => {}, sdkOptions);

  await session.applyTurn({ model: 'opus', permissionMode: 'default' });

  assert.equal(sdkOptions.permissionMode, 'default');
  session.close();
});

test('stepping into a plan and back keeps the process, its tools, and what was remembered', async () => {
  // Plan mode adds read-only tools of its own. They are deliberately not part
  // of the fingerprint - otherwise every step into a plan would cost a new
  // process - so they have to reach the options `canUseTool` reads, or it
  // would ask about every Read the plan makes.
  const sdkOptions: { permissionMode: string; allowedTools: string[] } = {
    permissionMode: 'default',
    allowedTools: ['Bash(git:*)'],
  };
  const session = new HeldClaudeSession({ sessionKey: 'session-6', fingerprint: fingerprint() });
  session.start(fakeQuery(session, []), () => {}, sdkOptions);

  // Mid-conversation the user allows one more tool and asks to remember it;
  // `canUseTool` writes it straight into the options.
  sdkOptions.allowedTools.push('Write');

  await session.applyTurn({
    model: 'opus',
    permissionMode: 'plan',
    allowedTools: ['Bash(git:*)', 'Read', 'exit_plan_mode'],
  });

  assert.equal(sdkOptions.permissionMode, 'plan');
  assert.deepEqual(
    sdkOptions.allowedTools,
    ['Bash(git:*)', 'Read', 'exit_plan_mode', 'Write'],
    'the plan tools arrive, the remembered one stays',
  );

  await session.applyTurn({
    model: 'opus',
    permissionMode: 'default',
    allowedTools: ['Bash(git:*)'],
  });

  assert.deepEqual(
    sdkOptions.allowedTools,
    ['Bash(git:*)', 'Write'],
    'leaving the plan takes its tools away again',
  );

  session.close();
});

test('the model is only pushed to the process when it actually changed', async () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-4', fingerprint: fingerprint() });
  const instance = fakeQuery(session, []);
  const models: (string | undefined)[] = [];
  instance.setModel = async (model) => { models.push(model); };
  session.start(instance, () => {});

  await session.applyTurn({ model: 'opus', permissionMode: 'default' });
  assert.deepEqual(models, [], 'unchanged model stays unsent');

  await session.applyTurn({ model: 'sonnet', permissionMode: 'default' });
  assert.deepEqual(models, ['sonnet']);

  session.close();
});

/**
 * A query whose output the test drives directly, independent of what goes into
 * the prompt stream — the shape of a process pushing follow-up turns on its own.
 */
function drivenQuery(session: HeldClaudeSession) {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  void (async () => {
    for await (const _message of session.promptStream()) { /* the CLI reads its stdin */ }
  })();
  const instance = (async function* () {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
        continue;
      }
      const next = queue.shift();
      if (next === null || next === undefined) {
        return;
      }
      yield next;
    }
  })() as AsyncGenerator<unknown> & {
    setModel: (model?: string) => Promise<void>;
    setPermissionMode: (mode: string) => Promise<void>;
  };
  instance.setModel = async () => {};
  instance.setPermissionMode = async () => {};
  return {
    instance,
    emit: (message: Record<string, unknown>) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
  };
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a process holding for background work is kept up to the ceiling, an idle one only for the idle allowance', async () => {
  const session = new HeldClaudeSession({
    sessionKey: 'session-9',
    fingerprint: fingerprint(),
    idleMs: 40,
    backgroundWorkCeilingMs: 400,
  });
  const driven = drivenQuery(session);
  session.start(driven.instance, () => {});

  // The turn reports that it started background work which has not settled.
  let holding = true;
  const running = session.runTurn({
    promptMessages: [{ text: 'start an agent' }],
    onMessage: () => {},
    isHoldingForBackgroundWork: () => holding,
  });
  driven.emit({ type: 'result', subtype: 'success' });
  await running;

  await sleep(120);
  assert.equal(session.closed, false, 'well past the idle allowance, the process is still up for the work');

  // The work reports in: the process pushes a follow-up turn. The handler of
  // the last turn sees it and stops holding; the timer switches to idle.
  holding = false;
  driven.emit({ type: 'assistant', text: 'agent finished' });
  driven.emit({ type: 'result', subtype: 'success' });
  await sleep(100);
  assert.equal(session.closed, true, 'nothing outstanding any more, so the idle allowance applies');
  driven.end();
});

test('messages from the process push the idle countdown back out', async () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-10', fingerprint: fingerprint(), idleMs: 60 });
  const driven = drivenQuery(session);
  session.start(driven.instance, () => {});

  const running = session.runTurn({ promptMessages: [{ text: 'one' }], onMessage: () => {} });
  driven.emit({ type: 'result', subtype: 'success' });
  await running;

  // Silence is measured from the last message, not from the end of the turn.
  for (let i = 0; i < 4; i += 1) {
    await sleep(30);
    driven.emit({ type: 'system', subtype: 'task_progress' });
  }
  assert.equal(session.closed, false, 'a process that keeps talking is not idle');

  await sleep(120);
  assert.equal(session.closed, true, 'and once it goes quiet, it is let go');
  driven.end();
});

test('what the process pushes between turns reaches the handler of the last turn', async () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-11', fingerprint: fingerprint() });
  const driven = drivenQuery(session);
  session.start(driven.instance, () => {});

  const seen: unknown[] = [];
  const running = session.runTurn({ promptMessages: [{ text: 'one' }], onMessage: (m) => seen.push(m) });
  driven.emit({ type: 'result', subtype: 'success' });
  await running;

  driven.emit({ type: 'assistant', text: 'background agent reporting' });
  await sleep(5);
  assert.deepEqual(seen, [
    { type: 'result', subtype: 'success' },
    { type: 'assistant', text: 'background agent reporting' },
  ]);

  session.close();
  driven.end();
});

test('the writer relay follows each turn', async () => {
  const first = { sent: [] as unknown[], send(m: unknown) { this.sent.push(m); }, userId: 'u1' };
  const second = { sent: [] as unknown[], send(m: unknown) { this.sent.push(m); }, userId: 'u2' };
  const session = new HeldClaudeSession({ sessionKey: 'session-12', fingerprint: fingerprint(), writer: first });
  const seen: unknown[] = [];
  session.start(fakeQuery(session, seen), () => {});

  session.writer.send('to the first');
  assert.equal(session.writer.userId, 'u1');

  await session.runTurn({ promptMessages: [{ text: 'two' }], onMessage: () => {}, writer: second });
  session.writer.send('to the second');

  assert.deepEqual(first.sent, ['to the first']);
  assert.deepEqual(second.sent, ['to the second']);
  assert.equal(session.writer.userId, 'u2');

  session.close();
});

test('a replaced process that ends later does not unregister its replacement', async () => {
  // The old process is closed when the new one is registered under the same
  // key, but it only ends once its CLI has actually exited - after the new
  // one is in the registry. Its end must clean up itself, not the key.
  const first = new HeldClaudeSession({ sessionKey: 'session-13', fingerprint: fingerprint() });
  const firstDriven = drivenQuery(first);
  first.start(firstDriven.instance, () => {});
  holdSession(first);

  const second = new HeldClaudeSession({ sessionKey: 'session-13', fingerprint: fingerprint({ cwd: '/elsewhere' }) });
  const secondDriven = drivenQuery(second);
  second.start(secondDriven.instance, () => {});
  holdSession(second);
  assert.equal(first.closed, true, 'registering the replacement closes the old one');
  assert.equal(getHeldSession('session-13'), second);

  // Now the old CLI exits.
  firstDriven.end();
  await sleep(5);
  assert.equal(getHeldSession('session-13'), second, 'the replacement is still registered');
  assert.equal(second.closed, false);

  // And closing a stale handle to the old one is equally harmless.
  first.close();
  assert.equal(getHeldSession('session-13'), second);

  second.close();
  secondDriven.end();
});

/** A driven query that also records whether the SDK was asked to close (terminate) the process. */
function terminableQuery(session: HeldClaudeSession) {
  const driven = drivenQuery(session);
  let terminated = 0;
  const instance = Object.assign(driven.instance, {
    close: () => {
      terminated += 1;
      driven.end();
    },
  });
  return { ...driven, instance, terminated: () => terminated };
}

test('a closed process that does not exit by itself is terminated after the grace', async () => {
  // Ending stdin is not enough: a CLI holding background agents waits for
  // them (up to its ceiling) with no way left to ask for permissions, then
  // fails their follow-up turns straight into the transcript.
  const session = new HeldClaudeSession({ sessionKey: 'session-14', fingerprint: fingerprint(), exitGraceMs: 30 });
  const query = terminableQuery(session);
  session.start(query.instance, () => {});

  session.close();
  assert.equal(query.terminated(), 0, 'first the process gets its chance to exit');
  await sleep(60);
  assert.equal(query.terminated(), 1, 'then it is terminated');
});

test('a closed process that exits on its own is left alone', async () => {
  const session = new HeldClaudeSession({ sessionKey: 'session-15', fingerprint: fingerprint(), exitGraceMs: 30 });
  const query = terminableQuery(session);
  session.start(query.instance, () => {});

  session.close();
  query.end();
  await sleep(60);
  assert.equal(query.terminated(), 0, 'nothing to terminate: it exited within the grace');
});
