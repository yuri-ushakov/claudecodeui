// Проба клиентского пути запроса разрешения: реальный браузер (Playwright,
// Chromium из ~/.cache/ms-playwright), вход по JWT в localStorage['auth-token'],
// открытая тестовая сессия, сообщение из композера, и рядом — вторая сессия того
// же проекта, запущенная через POST /api/agent (как кнопка доски/расписаний).
// Смотрим: пришёл ли кадр `permission_request` в сокет вкладки, появилась ли
// карточка «Permission required» в DOM, и меняется ли что-то после архивирования
// второй сессии (DELETE /api/providers/sessions/:id).
//
// Запуск из корня репо:
//   node scripts/hq/permission-ui-probe.mjs [--server http://127.0.0.1:3001]
//        [--project /home/yuri/Projects/hq-permtest] [--command 'node -e "console.log(1)"']
//        [--agent yes|no] [--agent-command 'sleep 75'] [--archive-after 30000]
//        [--headless yes|no] [--api-key <ключ /api/agent>]
//        [--send-via composer|socket]   socket = ход стартует с другого сокета (планшет/очередь)
// Ключ /api/agent: --api-key или переменная HQ_AGENT_API_KEY (без ключа — --agent no).
// Секреты в лог не пишутся. БД только читается (jwt_secret, users).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const server = args.get('server') || 'http://127.0.0.1:3001';
const projectPath = args.get('project') || path.join(os.homedir(), 'Projects', 'hq-permtest');
const command = args.get('command') || 'node -e "console.log(1)"';
const withAgent = (args.get('agent') || 'yes') !== 'no';
const agentCommand = args.get('agent-command') || 'sleep 75';
const archiveAfterMs = Number(args.get('archive-after') ?? 30000);
const headless = (args.get('headless') || 'yes') !== 'no';
const apiKey = args.get('api-key') || process.env.HQ_AGENT_API_KEY || '';
const sendVia = args.get('send-via') || 'composer'; // composer | socket

if (!fs.existsSync(projectPath)) {
  console.error(`Каталог проекта не существует: ${projectPath}`);
  process.exit(2);
}
if (withAgent && !apiKey) {
  console.error('Нужен ключ /api/agent (--api-key или HQ_AGENT_API_KEY), либо --agent no');
  process.exit(2);
}

const started = Date.now();
const ms = () => String(Date.now() - started).padStart(6, ' ');
const log = (who, text) => console.log(`${ms()} ms  ${who}  ${text}`);

// --- JWT -----------------------------------------------------------------------
const db = new Database(path.join(os.homedir(), '.cloudcli', 'auth.db'), { readonly: true });
const secret = db.prepare("select value from app_config where key = 'jwt_secret'").get()?.value;
const user = db.prepare('select id, username from users where id = 1').get();
db.close();
const token = jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '1h' });
const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

// --- Сессии --------------------------------------------------------------------
const createSession = async (initialMessage) => {
  const response = await fetch(`${server}/api/providers/sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ provider: 'claude', projectPath, initialMessage }),
  });
  const body = await response.json();
  return body?.data?.sessionId;
};
const archiveSession = async (sessionId) => {
  const response = await fetch(`${server}/api/providers/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders });
  return response.status;
};

const testSessionId = await createSession(`ui-probe: ${command}`);
log('--', `тестовая сессия (во вкладке): ${testSessionId}`);

// --- Браузер -------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'chromium', headless });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript((value) => {
  window.localStorage.setItem('auth-token', value);
}, token);
const page = await context.newPage();

const frames = [];
let requestId = null;
page.on('websocket', (socket) => {
  log('ws', `сокет вкладки открыт ${socket.url().replace(/token=[^&]+/, 'token=…')}`);
  socket.on('framereceived', ({ payload }) => {
    let frame;
    try { frame = JSON.parse(String(payload)); } catch { return; }
    if (frame.kind === 'stream_delta' || frame.kind === 'loading_progress') return;
    const sidLabel = frame.sessionId === testSessionId ? 'TEST' : frame.sessionId ? (frame.sessionId === agentSessionId ? 'AGENT' : frame.sessionId) : '-';
    const extra = [];
    if (frame.seq !== undefined) extra.push(`seq=${frame.seq}`);
    if (frame.requestId) extra.push(`requestId=${String(frame.requestId).slice(0, 8)}`);
    if (frame.kind === 'chat_subscribed') extra.push(`isProcessing=${frame.isProcessing} pending=${(frame.pendingPermissions || []).length}`);
    if (frame.kind === 'complete') extra.push(`success=${frame.success}`);
    if (frame.kind === 'protocol_error') extra.push(`${frame.code}`);
    frames.push({ at: Date.now() - started, kind: frame.kind, sessionId: frame.sessionId });
    log('ws', `← ${frame.kind} sid=${sidLabel} ${extra.join(' ')}`);
    if (frame.kind === 'permission_request' && frame.sessionId === testSessionId && !requestId) {
      requestId = frame.requestId;
    }
  });
  socket.on('framesent', ({ payload }) => {
    let frame;
    try { frame = JSON.parse(String(payload)); } catch { return; }
    const target = frame.sessionId || (frame.sessions || []).map((s) => (s.sessionId === testSessionId ? 'TEST' : s.sessionId)).join(',');
    log('ws', `→ ${frame.type} ${target === testSessionId ? 'TEST' : target}`);
  });
});
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) {
    log('console', `${message.type()} ${message.text().slice(0, 200)}`);
  }
});
page.on('pageerror', (error) => log('console', `pageerror ${error.message.slice(0, 200)}`));

await page.goto(`${server}/session/${testSessionId}`, { waitUntil: 'domcontentloaded' });
const textarea = page.locator('textarea[data-slot="prompt-input-textarea"]');
await textarea.waitFor({ timeout: 30000 });
log('ui', 'композер открыт');
await page.waitForTimeout(2500);

// --- Вторая сессия того же проекта через /api/agent -------------------------------
let agentSessionId = null;
let agentDone = null;
if (withAgent) {
  agentDone = fetch(`${server}/api/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      projectPath,
      provider: 'claude',
      stream: true,
      cleanup: false,
      message: `Выполни через Bash команду \`${agentCommand}\` и потом напиши «готово». Ничего больше.`,
    }),
  }).then(async (response) => {
    // SSE: первое событие route — session-id.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        if (!chunk.startsWith('data:')) continue;
        try {
          const event = JSON.parse(chunk.slice(5).trim());
          if (event.type === 'session-id' && !agentSessionId) {
            agentSessionId = event.sessionId;
            log('agent', `агентская сессия: ${agentSessionId}`);
          }
          if (event.kind === 'complete') log('agent', 'ход агента завершён');
        } catch { /* не JSON */ }
      }
    }
    log('agent', 'SSE закрыт');
  }).catch((error) => log('agent', `ошибка ${error.message}`));
  // Дать агентской сессии появиться в сайдбаре и начать выполняться.
  await page.waitForTimeout(8000);
}

// --- Сообщение из композера ----------------------------------------------------------
const content = `Выполни через Bash команду \`${command}\` и ничего больше. Без пояснений.`;
let sentAt;
if (sendVia === 'socket') {
  // Ход стартует с другого сокета (планшет, черновик из очереди): вкладка
  // подписалась на сессию, пока та простаивала.
  const sender = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve) => sender.once('open', resolve));
  sender.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (['permission_request', 'complete', 'protocol_error', 'tool_use'].includes(frame.kind)) {
      log('sock', `← ${frame.kind} seq=${frame.seq ?? '-'}`);
    }
  });
  sender.send(JSON.stringify({ type: 'chat.send', sessionId: testSessionId, content, options: { permissionMode: 'default', cwd: projectPath, projectPath } }));
  sentAt = Date.now() - started;
  log('sock', `→ chat.send с отдельного сокета (${command})`);
} else {
  await textarea.click();
  await textarea.fill(content);
  await page.keyboard.press('Enter');
  sentAt = Date.now() - started;
  log('ui', `→ отправлено из композера (${command})`);
}

const card = page.locator('text=Permission required');
const summary = { frameAt: null, cardAt: null, cardAfterArchiveAt: null, archivedAt: null };
const deadline = Date.now() + 90000;
let archived = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(500);
  if (summary.frameAt === null) {
    const frame = frames.find((entry) => entry.kind === 'permission_request' && entry.sessionId === testSessionId);
    if (frame) {
      summary.frameAt = frame.at;
      log('--', `кадр permission_request получен вкладкой через ${frame.at - sentAt} мс после отправки`);
    }
  }
  const visible = await card.first().isVisible().catch(() => false);
  if (visible && summary.cardAt === null) {
    summary.cardAt = Date.now() - started;
    log('ui', `карточка «Permission required» ВИДНА (через ${summary.cardAt - sentAt} мс после отправки)`);
    await page.screenshot({ path: '/tmp/hq-permission-ui-probe-card.png' });
    break;
  }
  if (!archived && withAgent && agentSessionId && summary.frameAt !== null && Date.now() - started - summary.frameAt > archiveAfterMs) {
    archived = true;
    await page.screenshot({ path: '/tmp/hq-permission-ui-probe-before-archive.png' });
    const status = await archiveSession(agentSessionId);
    summary.archivedAt = Date.now() - started;
    log('--', `агентская сессия заархивирована (HTTP ${status}); карточки не было ${archiveAfterMs} мс после кадра`);
  }
  if (archived && summary.cardAfterArchiveAt === null && visible) {
    summary.cardAfterArchiveAt = Date.now() - started;
  }
}
if (summary.cardAt === null) {
  await page.screenshot({ path: '/tmp/hq-permission-ui-probe-nocard.png' });
  log('ui', 'карточка так и НЕ появилась');
}

// Снимок состояния композера: что вообще рендерится над полем ввода.
const composerText = await page.locator('.chat-composer-shell').innerText().catch(() => '(нет .chat-composer-shell)');
log('ui', `текст композера: ${composerText.replace(/\s+/g, ' ').slice(0, 300)}`);

// --- Закрыть запрос, чтобы ход завершился -------------------------------------------
if (requestId) {
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ type: 'chat.permission-response', requestId, allow: false, message: 'probe: deny' }));
  log('--', '→ отказ отправлен отдельным сокетом');
  await page.waitForTimeout(4000);
  socket.send(JSON.stringify({ type: 'chat.abort', sessionId: testSessionId }));
  await page.waitForTimeout(500);
  socket.close();
}

console.log('\n=== Итог ===');
console.log(`тестовая сессия: ${testSessionId}; агентская: ${agentSessionId ?? 'нет'}`);
console.log(`кадр permission_request во вкладке: ${summary.frameAt === null ? 'НЕ пришёл' : `${summary.frameAt - sentAt} мс после отправки`}`);
console.log(`карточка в DOM: ${summary.cardAt === null ? 'НЕ появилась' : `${summary.cardAt - sentAt} мс после отправки`}${summary.archivedAt !== null ? ` (архив второй сессии в ${summary.archivedAt} мс)` : ''}`);
await browser.close();
if (agentDone) {
  // Агентский ход добьётся сам (sleep), но ждать его не обязательно.
}
process.exit(0);
