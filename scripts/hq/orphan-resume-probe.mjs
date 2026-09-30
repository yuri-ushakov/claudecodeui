// Проба: что CLI выдаёт при resume сессии, в которой предыдущий процесс оставил
// незавершённого фонового агента. Именно так в бою 30.09 закрывался stdin
// нового процесса: CLI ставит уведомление об осиротевшем агенте как отдельный
// prompt и завершает его собственным `result` (origin.kind = task-notification,
// num_turns 0) до того, как взглянет на сообщение хода; провайдер принимал
// этот result за конец хода и закрывал stdin (см. docs/hq-fork.md, правка 8).
//
// Ничего не стоит и не оставляет следов: изолированный CLAUDE_CONFIG_DIR,
// фиктивный ключ и ANTHROPIC_BASE_URL на мёртвый порт (модель не вызывается).
//
// Запуск из корня репо (SDK берётся из node_modules, CLI — тот же `claude`, что
// запускает форк: из PATH или `CLAUDE_CLI_PATH`; встроенный в SDK бинарь другой
// версии уведомление об осиротевшем агенте не выдаёт):
//   node scripts/hq/orphan-resume-probe.mjs silent   # stdin молчит 25 с
//   node scripts/hq/orphan-resume-probe.mjs prompt   # сообщение юзера сразу, как делает провайдер
// Ожидаемо в обоих режимах: system task_notification → system init →
// result{origin:{kind:'task-notification'},num_turns:0}; в режиме prompt затем
// второй init и попытки вызвать модель (ход юзера).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

const mode = process.argv[2] || 'silent';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-orphan-probe-'));
const cfg = path.join(root, 'cfg');
const cwd = path.join(root, 'ws');
fs.mkdirSync(cfg, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

// Транскрипт: ход, в котором был запущен фоновый агент, и ни одной записи о его
// завершении — ровно то, что находит CLI после гибели предыдущего процесса.
const projectKey = cwd.replace(/\//g, '-');
const projectDir = path.join(cfg, 'projects', projectKey);
fs.mkdirSync(projectDir, { recursive: true });
const sessionId = randomUUID();
const now = Date.now();
const at = (agoMs) => new Date(now - agoMs).toISOString();
const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd, sessionId, version: '2.1.284', gitBranch: '' };
const [u1, a1, u2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const promptId = randomUUID();
const agentId = 'a0000000000000001';
const rows = [
  { ...base, parentUuid: null, promptId, type: 'user', message: { role: 'user', content: 'запусти агента в фоне' }, uuid: u1, timestamp: at(90000), permissionMode: 'default', promptSource: 'sdk', turnOrigin: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 0 } },
  { ...base, parentUuid: u1, type: 'assistant', requestId: 'req_probe1', uuid: a1, timestamp: at(80000),
    message: { model: 'claude-fable-5-1', id: 'msg_probe1', type: 'message', role: 'assistant', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'toolu_probe1', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'orphan probe', run_in_background: true, prompt: 'подожди 10 минут и ответь' } }],
      usage: { input_tokens: 1, output_tokens: 1 } } },
  { ...base, parentUuid: a1, promptId, type: 'user', uuid: u2, timestamp: at(79000),
    message: { role: 'user', content: [{ tool_use_id: 'toolu_probe1', type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'orphan probe', prompt: 'подожди 10 минут и ответь' } },
  { ...base, parentUuid: u2, type: 'assistant', requestId: 'req_probe2', uuid: a2, timestamp: at(70000),
    message: { model: 'claude-fable-5-1', id: 'msg_probe2', type: 'message', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Агент запущен в фоне.' }], usage: { input_tokens: 1, output_tokens: 1 } } },
];
fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

const startedAt = Date.now();
const log = (...args) => console.log(`+${String(Date.now() - startedAt).padStart(5)}ms`, ...args);

let release;
const held = new Promise((resolve) => { release = resolve; });
async function* promptStream() {
  if (mode === 'prompt') {
    log('stdin <- user message');
    yield { type: 'user', message: { role: 'user', content: 'ping' }, parent_tool_use_id: null, session_id: sessionId };
  }
  await held;
}

const instance = query({
  prompt: promptStream(),
  options: {
    cwd,
    resume: sessionId,
    pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH || 'claude',
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: 'sk-ant-probe-no-such-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    allowedTools: [],
    disallowedTools: [],
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    canUseTool: async (name) => { log('canUseTool', name); return { behavior: 'allow' }; },
    stderr: (line) => log('stderr:', String(line).trim().slice(0, 200)),
  },
});

const timer = setTimeout(() => { log('timeout -> release + close'); release(); setTimeout(() => instance.close(), 500); }, 25000);
try {
  for await (const message of instance) {
    const brief = message.type === 'result'
      ? `result subtype=${message.subtype} num_turns=${message.num_turns} origin=${JSON.stringify(message.origin ?? null)}`
      : message.type === 'system' ? `system ${message.subtype}${message.status ? ` status=${message.status}` : ''}` : message.type;
    log('sdk ->', brief);
  }
  log('stream closed');
} catch (error) {
  log('error', error?.message);
} finally {
  clearTimeout(timer);
  fs.rmSync(root, { recursive: true, force: true });
}
