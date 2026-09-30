import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { getHeldSession, releaseHeldSession } from '@/modules/providers/list/claude/claude-held-session.js';
import {
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  resolveToolApproval,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * With "keep session alive" on, one CLI process serves every turn of a
 * conversation. Each turn arrives with a writer of its own — the chat run
 * registry makes one per `chat.send`, from whichever tab or device sent it —
 * so the process must follow the writer, not be restarted for it, and the
 * background work one turn started must still be there for the next.
 */

const NATIVE_ID = 'native-held-session';

/** One scripted CLI process: what it was started with, what it emits, and how it was ended. */
type ScriptedProcess = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  /** Whether the host ended its stdin. */
  released: () => boolean;
  /** How many times the host asked the SDK to interrupt it. */
  interrupts: () => number;
  /** Whether the host closed (terminated) it through the SDK. */
  terminated: () => boolean;
  /** The options it was started with; its callbacks live here. */
  options: () => AnyRecord;
};

type Scripted = ScriptedProcess & {
  /** How many processes were started. */
  starts: () => number;
  /** The n-th process started (0-based); the bare accessors above address the latest. */
  process: (index: number) => ScriptedProcess;
};

type Writer = { send: (message: NormalizedMessage) => void; userId: null; received: NormalizedMessage[] };

function createWriter(): Writer {
  const received: NormalizedMessage[] = [];
  return { send: (message) => { received.push(message); }, userId: null, received };
}

/** A stand-in for the SDK query that keeps reading the prompt stream for as long as it is open. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const processes: ScriptedProcess[] = [];
  const latest = () => processes[processes.length - 1];

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    const queue: Array<Record<string, unknown> | null> = [];
    let wake: (() => void) | null = null;
    let released = false;
    let interrupts = 0;
    let terminated = false;

    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();

    const iterator = (async function* () {
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
    })();

    const process: ScriptedProcess = {
      emit: (message) => { queue.push(message); wake?.(); },
      end: () => { queue.push(null); wake?.(); },
      released: () => released,
      interrupts: () => interrupts,
      terminated: () => terminated,
      options: () => options,
    };
    processes.push(process);

    return Object.assign(iterator, {
      interrupt: async () => { interrupts += 1; },
      stopTask: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => { terminated = true; process.end(); },
    });
  };

  const script: Scripted = {
    emit: (message) => latest().emit(message),
    end: () => latest()?.end(),
    released: () => latest().released(),
    interrupts: () => latest().interrupts(),
    terminated: () => latest().terminated(),
    options: () => latest().options(),
    starts: () => processes.length,
    process: (index) => processes[index],
  };

  return { createQuery, script };
}

type Harness = {
  script: Scripted;
  /** Starts a turn on its own writer, as a fresh `chat.send` would; `overrides` change what the turn asks for. */
  turn: (writer: Writer, command?: string, overrides?: AnyRecord) => Promise<unknown>;
  sessionId: string;
  cwd: string;
};

async function withConversation(
  sessionId: string,
  runTest: (harness: Harness) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-'));
  const { createQuery, script } = createScriptedQuery();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const turn = (writer: Writer, command = 'hello', overrides: AnyRecord = {}) => queryClaudeSDK(
    command,
    { sessionId, cwd, ...overrides, toolsSettings: { keepSessionAlive: true, ...(overrides.toolsSettings ?? {}) } },
    writer as never,
    context,
  );

  try {
    await runTest({ script, turn, sessionId, cwd });
  } finally {
    releaseHeldSession(sessionId);
    for (let index = 0; index < script.starts(); index += 1) {
      script.process(index).end();
    }
    await settle();
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const say = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });

const texts = (writer: Writer) => writer.received
  .filter((message) => message.kind === 'text' && message.role === 'assistant')
  .map((message) => message.content);
const kinds = (writer: Writer) => writer.received.map((message) => message.kind);

test('a turn from another writer is served by the same process, and its events go to that writer', async () => {
  await withConversation('app-held-writers', async ({ script, turn, sessionId }) => {
    const station = createWriter();
    const first = turn(station);
    await settle();
    script.emit(init());
    script.emit(say('first answer'));
    script.emit(result());
    await first;

    assert.equal(script.starts(), 1);
    assert.equal(script.released(), false, 'the process stays for the conversation');
    assert.deepEqual(texts(station), ['first answer']);

    // The user picks the conversation up on another device: a new socket, a
    // new run, a new writer.
    const tablet = createWriter();
    const second = turn(tablet, 'and now?');
    await settle();
    script.emit(say('second answer'));
    script.emit(result());
    await second;

    assert.equal(script.starts(), 1, 'no second process for the second writer');
    assert.deepEqual(texts(tablet), ['second answer']);
    assert.deepEqual(texts(station), ['first answer'], 'the old writer is left alone');
    assert.ok(kinds(tablet).includes('complete'), 'the second turn completes on its own writer');
    assert.ok(getHeldSession(sessionId), 'the process is still held afterwards');
  });
});

test('a permission request raised in a later turn reaches that turn\'s writer', async () => {
  await withConversation('app-held-permissions', async ({ script, turn }) => {
    const station = createWriter();
    const first = turn(station);
    await settle();
    script.emit(init());
    script.emit(result());
    await first;

    // `canUseTool` was built for the first turn, around the first writer.
    const tablet = createWriter();
    const second = turn(tablet, 'run it');
    await settle();
    const canUseTool = script.options().canUseTool as (
      toolName: string, input: unknown, context: unknown,
    ) => Promise<{ behavior: string }>;
    const decision = canUseTool('Bash', { command: 'ls' }, {});
    await settle();

    const request = tablet.received.find((message) => message.kind === 'permission_request');
    assert.ok(request, 'the prompt lands on the writer of the turn being served');
    assert.equal(station.received.some((message) => message.kind === 'permission_request'), false);

    resolveToolApproval(request.requestId as string, { allow: true });
    assert.equal((await decision).behavior, 'allow');
    script.emit(result());
    await second;
  });
});

test('background work started in one turn outlives the next and reports through the latest writer', async () => {
  await withConversation('app-held-background', async ({ script, turn, sessionId }) => {
    const station = createWriter();
    const first = turn(station);
    await settle();
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'work for a while', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(ack('toolu_agent', 'Agent launched in background. Task ID: a1', { status: 'async_launched', taskId: 'a1' }));
    script.emit(result());
    await first;

    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[sessionId, ['a1']]]);
    assert.equal(script.released(), false);

    // The next message goes into the same process; the agent is untouched.
    const tablet = createWriter();
    const second = turn(tablet, 'how is it going?');
    await settle();
    script.emit(say('still running'));
    script.emit(result());
    await second;

    assert.equal(script.starts(), 1, 'the second turn did not start a process');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['a1']], 'the agent is still tracked');
    assert.equal(script.released(), false);

    // The agent finishes between turns: the CLI settles the task and pushes a
    // follow-up turn relaying its result. Nobody is "in a turn" now, so this
    // is exactly what a per-turn handler would drop.
    const completesBefore = kinds(tablet).filter((kind) => kind === 'complete').length;
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(say('the agent found the answer'));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), [], 'the task settled');
    assert.deepEqual(texts(tablet), ['still running', 'the agent found the answer'], 'the follow-up reaches the latest writer');
    assert.equal(texts(station).length, 0, 'and not the one that started the work');
    assert.equal(kinds(tablet).filter((kind) => kind === 'complete').length, completesBefore, 'a follow-up turn is not a second completion');
    assert.equal(script.released(), false, 'the process is kept for the conversation, not released with the work');
  });
});

test('with the option off, every turn is its own process as before', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-oneshot-'));
  const { createQuery, script } = createScriptedQuery();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    createQuery,
  };
  try {
    const first = queryClaudeSDK('hello', { sessionId: 'app-oneshot', cwd }, createWriter() as never, context);
    await settle();
    script.emit(init());
    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'nothing outstanding: stdin closes at the result');
    script.end();
    await first;
    assert.equal(getHeldSession('app-oneshot'), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn the held process cannot serve ends it for good and gets a working permission channel on the new one', async () => {
  await withConversation('app-held-replaced', async ({ script, turn, sessionId }) => {
    const station = createWriter();
    const first = turn(station);
    await settle();
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'work for a while', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(ack('toolu_agent', 'Agent launched in background. Task ID: a1', { status: 'async_launched', taskId: 'a1' }));
    script.emit(result());
    await first;
    const old = script.process(0);

    // The next message needs another working directory: the CLI fixed that
    // at startup, so this turn cannot go into the same process.
    const tablet = createWriter();
    const otherCwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-held-other-'));
    try {
      const second = turn(tablet, 'from elsewhere', { cwd: otherCwd });
      await settle();

      assert.equal(script.starts(), 2, 'a second process was started');
      assert.equal(old.released(), true, 'the old process had its stdin ended');
      assert.equal(old.interrupts(), 0, 'and was not sent an interrupt it could no longer answer');
      assert.equal(getHeldSession(sessionId)?.fingerprint.cwd, otherCwd, 'the new process is the one held now');
      assert.deepEqual(listClaudeSDKBackgroundWork(), [], 'the old process\'s work is no longer tracked: it died with it');

      const fresh = script.process(1);
      assert.equal(fresh.released(), false, 'the new process\'s stdin is open');

      // Its permission channel works: `canUseTool` reaches the writer of the
      // turn being served, and the answer goes back.
      const canUseTool = fresh.options().canUseTool as (
        toolName: string, input: unknown, context: unknown,
      ) => Promise<{ behavior: string }>;
      const decision = canUseTool('Bash', { command: 'uname' }, {});
      await settle();
      const request = tablet.received.find((message) => message.kind === 'permission_request');
      assert.ok(request, 'the prompt lands on the new turn\'s writer');
      resolveToolApproval(request.requestId as string, { allow: true });
      assert.equal((await decision).behavior, 'allow');
      assert.equal(fresh.released(), false, 'still open after the request');

      // Meanwhile the old process, which did not exit on its own, is ended
      // properly rather than left waiting on its agent with no stdin - and
      // that ending does not touch the new process.
      await new Promise((resolve) => { setTimeout(resolve, 5200); });
      assert.equal(old.terminated(), true, 'the old process was terminated after its grace');
      assert.equal(fresh.released(), false, 'the new process is untouched');
      assert.equal(getHeldSession(sessionId)?.fingerprint.cwd, otherCwd, 'and still registered');

      fresh.emit(result());
      await second;
    } finally {
      await rm(otherCwd, { recursive: true, force: true });
    }
  });
});

test('a changed allowed-tool list is applied to the held process instead of costing a new one', async () => {
  await withConversation('app-held-allowed', async ({ script, turn, sessionId }) => {
    const station = createWriter();
    const first = turn(station, 'hello', { toolsSettings: { allowedTools: ['Bash(git:*)'] } });
    await settle();
    script.emit(init());
    script.emit(result());
    await first;

    // The user remembered a rule (or another device already had it).
    const tablet = createWriter();
    const second = turn(tablet, 'again', { toolsSettings: { allowedTools: ['Bash(git:*)', 'Bash(ls:*)'] } });
    await settle();

    assert.equal(script.starts(), 1, 'same process');
    assert.deepEqual(script.options().allowedTools, ['Bash(git:*)', 'Bash(ls:*)'], 'the list the callback reads was updated');
    assert.ok(getHeldSession(sessionId), 'the process is still held');
    script.emit(result());
    await second;

    // A changed disallowed list is different: the CLI enforces it from
    // startup, so it does need a new process.
    const third = turn(tablet, 'once more', { toolsSettings: { disallowedTools: ['Write'] } });
    await settle();
    assert.equal(script.starts(), 2, 'a disallowed-tool change starts a new process');
    script.emit(result());
    await third;
  });
});
