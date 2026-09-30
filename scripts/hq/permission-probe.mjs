// Проба: доходит ли запрос разрешения на инструмент (`permission_request`) до
// websocket-клиента, и с каким sessionId/seq — без участия человека в браузере.
//
// Что делает: подписывает JWT для пользователя id=1 секретом из ~/.cloudcli/auth.db
// (БД только читается), создаёт НОВУЮ сессию в проекте из --project (по умолчанию
// ~/Projects/hq-permtest), подключает сокет A, шлёт chat.subscribe + chat.send с
// просьбой выполнить команду вне allowlist (permissionMode default), и печатает
// каждый входящий кадр с меткой времени. Через --second-after мс подключает
// сокет B (эмуляция планшета / второй вкладки: chat.subscribe после старта хода).
// На первый permission_request отвечает отказом с сокета B через --answer-delay мс
// (если B ещё не подключён — с A), чтобы ход закончился. В конце шлёт chat.abort,
// чтобы удерживаемый процесс не висел 10 минут.
//
// Запуск из корня репо:
//   node scripts/hq/permission-probe.mjs [--server http://127.0.0.1:3001]
//        [--project /home/yuri/Projects/hq-permtest] [--command whoami]
//        [--second-after 4000] [--answer-delay 3000] [--timeout 120000]
// Итог: таблица кадров и вывод «permission_request: сокет A через N мс, sessionId
// совпадает/не совпадает с id сессии, seq=…; сокет B: …».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const server = args.get('server') || 'http://127.0.0.1:3001';
const projectPath = args.get('project') || path.join(os.homedir(), 'Projects', 'hq-permtest');
const command = args.get('command') || 'whoami';
const secondAfterMs = Number(args.get('second-after') ?? 4000);
const answerDelayMs = Number(args.get('answer-delay') ?? 3000);
const timeoutMs = Number(args.get('timeout') ?? 120000);

if (!fs.existsSync(projectPath)) {
  console.error(`Каталог проекта не существует: ${projectPath}`);
  process.exit(2);
}

// --- JWT из секрета БД (только чтение) ---------------------------------------
const dbPath = path.join(os.homedir(), '.cloudcli', 'auth.db');
const db = new Database(dbPath, { readonly: true });
const secretRow = db.prepare("select value from app_config where key = 'jwt_secret'").get();
const userRow = db.prepare('select id, username from users where id = 1').get();
db.close();
if (!secretRow || !userRow) {
  console.error('Не нашёл jwt_secret или пользователя id=1 в БД');
  process.exit(2);
}
const token = jwt.sign({ userId: userRow.id, username: userRow.username }, secretRow.value, { expiresIn: '1h' });

// --- Сессия ------------------------------------------------------------------
const started = Date.now();
const ms = () => String(Date.now() - started).padStart(6, ' ');
const log = (who, text) => console.log(`${ms()} ms  ${who}  ${text}`);

const createResponse = await fetch(`${server}/api/providers/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ provider: 'claude', projectPath, initialMessage: `probe: ${command}` }),
});
if (!createResponse.ok) {
  console.error('Не удалось создать сессию', createResponse.status, await createResponse.text());
  process.exit(2);
}
const created = await createResponse.json();
const sessionId = created?.data?.sessionId;
log('--', `тестовая сессия: ${sessionId} (проект ${projectPath})`);

// --- Сокеты ------------------------------------------------------------------
const summary = { A: null, B: null, resolvedA: null, resolvedB: null, completeA: null, completeB: null };
let firstRequest = null;
let answered = false;
let socketB = null;
let finished = false;

const describe = (frame) => {
  const parts = [`kind=${frame.kind ?? frame.type ?? '?'}`];
  if (frame.sessionId !== undefined) {
    parts.push(`sessionId=${frame.sessionId === sessionId ? 'TEST' : frame.sessionId}`);
  }
  if (frame.seq !== undefined) parts.push(`seq=${frame.seq}`);
  if (frame.requestId) parts.push(`requestId=${String(frame.requestId).slice(0, 8)}`);
  if (frame.toolName) parts.push(`tool=${frame.toolName}`);
  if (frame.isProcessing !== undefined) parts.push(`isProcessing=${frame.isProcessing}`);
  if (Array.isArray(frame.pendingPermissions)) parts.push(`pending=${frame.pendingPermissions.length}`);
  if (frame.kind === 'protocol_error') parts.push(`code=${frame.code} ${frame.error}`);
  if (frame.kind === 'complete') parts.push(`success=${frame.success} aborted=${frame.aborted ?? false}`);
  if (frame.kind === 'status' && frame.text) parts.push(`text=${String(frame.text).slice(0, 40)}`);
  if (frame.kind === 'error') parts.push(`content=${String(frame.content).slice(0, 80)}`);
  if (frame.kind === 'tool_use') parts.push(`name=${frame.toolName ?? frame.name ?? ''} input=${JSON.stringify(frame.input ?? frame.toolInput ?? '').slice(0, 60)}`);
  if (frame.kind === 'tool_result') parts.push(`content=${JSON.stringify(frame.content ?? '').slice(0, 80)}`);
  return parts.join(' ');
};

const send = (socket, payload) => socket.send(JSON.stringify(payload));

const answerFrom = (who, socket) => {
  if (answered || !firstRequest) return;
  answered = true;
  log(who, `→ chat.permission-response deny requestId=${firstRequest.requestId.slice(0, 8)}`);
  send(socket, { type: 'chat.permission-response', requestId: firstRequest.requestId, allow: false, message: 'probe: deny' });
};

const connect = (who) => {
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  socket.on('open', () => {
    log(who, 'открыт');
    send(socket, { type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    log(who, '→ chat.subscribe');
  });
  socket.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { log(who, `не JSON: ${String(raw).slice(0, 80)}`); return; }
    if (frame.kind === 'stream_delta') return;
    log(who, describe(frame));
    if (frame.kind === 'permission_request' && frame.requestId) {
      if (!summary[who]) {
        summary[who] = { at: Date.now() - started, sessionId: frame.sessionId, seq: frame.seq, tool: frame.toolName };
      }
      if (!firstRequest) {
        firstRequest = { requestId: frame.requestId };
        setTimeout(() => answerFrom(socketB?.readyState === WebSocket.OPEN ? 'B' : 'A', socketB?.readyState === WebSocket.OPEN ? socketB : socket), answerDelayMs);
      }
    }
    if (frame.kind === 'permission_resolved') summary[`resolved${who}`] = Date.now() - started;
    if (frame.kind === 'complete' && frame.sessionId === sessionId) {
      summary[`complete${who}`] = Date.now() - started;
      if (who === 'A') setTimeout(finish, 1500);
    }
  });
  socket.on('close', (code) => log(who, `закрыт ${code}`));
  socket.on('error', (error) => log(who, `ошибка ${error.message}`));
  return socket;
};

const socketA = connect('A');
socketA.once('open', () => {
  setTimeout(() => {
    send(socketA, {
      type: 'chat.send',
      sessionId,
      content: `Выполни через Bash команду \`${command}\` и ничего больше. Без пояснений.`,
      options: { permissionMode: 'default', cwd: projectPath, projectPath },
    });
    log('A', `→ chat.send (${command}, permissionMode=default)`);
  }, 300);
});

setTimeout(() => {
  socketB = connect('B');
}, secondAfterMs);

function finish() {
  if (finished) return;
  finished = true;
  // Отпускаем удерживаемый процесс, чтобы не висел 10 минут.
  if (socketA.readyState === WebSocket.OPEN) {
    send(socketA, { type: 'chat.abort', sessionId });
  }
  setTimeout(() => {
    console.log('\n=== Итог ===');
    console.log(`сессия: ${sessionId}`);
    for (const who of ['A', 'B']) {
      const got = summary[who];
      if (got) {
        console.log(`сокет ${who}: permission_request через ${got.at} мс, tool=${got.tool}, seq=${got.seq}, sessionId ${got.sessionId === sessionId ? 'СОВПАДАЕТ' : `НЕ совпадает (${got.sessionId})`}`);
      } else {
        console.log(`сокет ${who}: permission_request НЕ пришёл`);
      }
      console.log(`  permission_resolved: ${summary[`resolved${who}`] ?? 'нет'} мс; complete: ${summary[`complete${who}`] ?? 'нет'} мс`);
    }
    process.exit(0);
  }, 1500);
}

setTimeout(() => {
  log('--', `таймаут ${timeoutMs} мс`);
  finish();
}, timeoutMs);
