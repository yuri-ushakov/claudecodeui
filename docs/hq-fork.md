# Форк CloudCLI для штаба hq

Ветка `hq` этого репозитория = `upstream/main` (siteboon/claudecodeui) + патч «один процесс
Claude на всю беседу» + наши правки поверх него. Из этой ветки собирается и запускается
`cloudcli.service` на станции вместо глобального npm-пакета.

## Зачем

В CloudCLI каждое сообщение в чат — отдельный процесс `claude`. После хода, который запустил
фоновую работу (`Agent` с `run_in_background`, `Monitor`, `ScheduleWakeup`, фоновый `Bash`),
процесс держится открытым до 30 минут тишины, но **следующее сообщение юзера в ту же сессию
запускает новый процесс и прерывает старый** (`addSession` → `interrupt()`), вместе со всеми его
фоновыми субагентами. Для штаба это значило: главная сессия не может отдать долгую задачу агенту
в фон и продолжать разговаривать — агент погибнет на первой же реплике (так 30.09 погиб агент
доски). Upstream-issue: siteboon/claudecodeui#1325.

## Что за патч

PR siteboon/claudecodeui#1233 (edgar965, «Optionally keep one Claude process for a whole
conversation»). Тумблер в настройках; при включённом тумблере первый ход беседы запускает
процесс с бесконечным prompt-stream (async-iterable, который не заканчивается), а каждый
следующий ход **пушит сообщение в тот же stdin** вместо нового `query()`. Новый процесс — только
если сменились cwd, набор MCP-серверов, политика инструментов или effort; модель и режим
разрешений переключаются на живом процессе (`setModel`/`setPermissionMode`). Бонус: ответ
приходит быстрее — без запуска CLI и без `resume`.

Модули: `server/modules/providers/list/claude/claude-held-session.js` (удерживаемый процесс:
`HeldClaudeSession`, реле writer `LatestTurnWriter`, реестр `heldSessions`),
`server/modules/providers/list/claude/claude-runtime.provider.js` (`queryClaudeSDK` — выбор
«переиспользовать / завести новый»), тумблер в `src/modules/settings/...` (`keepSessionAlive`,
i18n `permissions.keepSessionAlive`).

## Наши правки поверх PR (ветка `hq`, коммиты после merge `9132c86c`)

1. **Совместимость с удержанием процесса ради фоновой работы (#1291, #1347).** PR старше этих
   изменений и слился без конфликтов, но противоречил им: между ходами `consume()` ронял все
   сообщения процесса (follow-up ход фонового агента не доходил ни до клиента, ни до трекера
   задач), после каждого хода провайдер удалял запись `activeSessions` и обнулял трекер при живом
   процессе, а закрывающая функция для abort перетиралась пустышкой. Теперь обработчик
   последнего хода остаётся подключённым до следующего хода (как цикл чтения в main), запись
   процесса живёт, пока жив процесс (`onEnd`), закрывает процесс одна функция `closeProcess`.
   Редактирование отправленного сообщения (`resumeAnchorId`/`resumeFromScratch`) всегда заводит
   новый процесс — перемотка беседы делается только опциями запуска.
2. **Снято сравнение по websocket-клиенту.** В PR writer входил в отпечаток процесса, и ход с
   «другого» writer заводил новый процесс, закрывая удерживаемый. Но writer у CloudCLI новый на
   каждый `chat.send` (реестр прогонов создаёт его на прогон), так что переиспользования не
   происходило вообще, а переход со станции на планшет убивал бы фоновых агентов. Теперь у
   удерживаемой сессии есть реле `LatestTurnWriter`: хуки и `canUseTool`, построенные при первом
   ходе, и все события процесса идут через него, а каждый ход переключает реле на свой writer.
   Ход с любого устройства попадает в тот же процесс.
3. **Один владелец решения «когда отпускать процесс».** В PR процесс отпускался через 10 минут
   тишины независимо от того, что в нём работает, а 30-минутный таймер провайдера в этом режиме
   ничего не закрывал. Теперь таймер один — у `HeldClaudeSession`: взводится, когда процесс не
   обслуживает ход, сбрасывается любым сообщением процесса (мера тишины); длительность
   спрашивает у последнего хода: 10 минут, если ничего не выполняется, 30 минут
   (`BG_WAIT_CEILING_MS`, тот же backstop, что у одноразового удержания), пока ход держит процесс
   ради незавершённой фоновой работы.

Выключенный тумблер = поведение main без изменений (тест «with the option off…»).

Тесты: `server/modules/providers/list/claude/tests/claude-held-session.test.ts` (сессия: ходы,
отпечаток, резервирование, таймер, реле) и `server/modules/providers/tests/claude-runtime-held.test.ts`
(провайдер: второй ход с другим writer на том же процессе, запрос разрешения во втором ходе,
фоновый агент переживает второй ход и отчитывается в новый writer, режим без тумблера).

## Известные ограничения

- Если follow-up ход фонового агента приходит в ту же секунду, что и новое сообщение юзера,
  `runTurn` может принять `result` агента за конец хода юзера (ход юзера тогда дойдёт до клиента
  через оставшийся обработчик, но кнопка «стоп» уже будет неактивна). Различить ходы по потоку
  SDK надёжно нельзя; upstream PR #1449 решает это по-своему.
- Перезапуск `cloudcli.service` убивает удерживаемые процессы вместе с фоновыми агентами —
  рестарт делать в согласованный момент, когда агентов нет.
- `npm run typecheck` в upstream/main `dc7cb6c6` падает на
  `src/modules/sidebar/tests/recentConversationTitleSync.test.ts` (тест не передаёт
  `backgroundSessionIds`) — это ошибка upstream, к патчу отношения не имеет.

## Как обновляться

```bash
cd ~/Projects/cloudcli
git fetch upstream
git checkout hq
git merge upstream/main        # конфликты — по смыслу патча (см. разделы выше), не ours/theirs
npm ci && npm run build
npm test                       # обязательны зелёные claude-held-session и claude-runtime-held
# рестарт — в согласованный момент, когда в штабе нет живых фоновых агентов:
systemctl --user restart cloudcli.service
git push origin hq
```

В upstream ничего не пушить, PR не открывать. Ветка `pr-1233` — голова исходного PR, для
сравнения при слияниях.

## Как включить тумблер

Settings → Agents → Claude → Permissions → «Держать процесс открытым всю беседу»
(`Keep the process alive for the whole conversation`). Настройка хранится в браузере
(`claudePermissions.keepSessionAlive`) и уходит на сервер с каждым `chat.send` в `toolsSettings`,
поэтому включать нужно на каждом устройстве, с которого пишем (станция, планшет). Действует со
следующего хода: первый ход после включения ещё заводит процесс как обычно, но уже удерживает его.

## Как проверить, что работает

1. Включить тумблер на станции и на планшете.
2. В главной сессии попросить запустить фонового агента минут на пять
   (`Agent` с `run_in_background: true`, например «посчитай строки во всех файлах памяти и подожди
   300 секунд перед ответом»).
3. Не дожидаясь, отправить в чат два обычных сообщения (второе — с планшета). Ответы должны
   приходить без задержки на запуск CLI; в списке процессов — один `claude` на эту сессию
   (`pgrep -af claude`), который не перезапускается.
4. Через пять минут в чат должен прийти итог агента (follow-up ход) — на то устройство, с
   которого было последнее сообщение; в панели уведомлений — «фоновая работа завершена».
5. Контроль: выключить тумблер и повторить — второе сообщение убьёт агента (поведение main).

Старый способ проверки того же кода без UI — тесты `claude-runtime-held.test.ts`.

## Юнит systemd (подготовлен, НЕ применён)

`server/index.ts` и `load-env.ts` находят корень приложения от каталога модуля
(`dist-server/server` → корень клона), поэтому `.env` и `dist/` фронта от `WorkingDirectory` не
зависят; `.env` в клоне нет и не нужен (у глобального пакета его тоже не было; JWT-секрет и
пользователь — в `~/.cloudcli/auth.db`, общей для обоих запусков). `WorkingDirectory` оставлен
как сейчас — `/home/yuri/Projects/hq`.

`~/.config/systemd/user/cloudcli.service`:

```ini
[Unit]
Description=CloudCLI — веб-интерфейс Claude Code (штаб hq), форк ~/Projects/cloudcli ветка hq
After=network-online.target

[Service]
Type=simple
Environment=HOST=0.0.0.0
Environment=SERVER_PORT=3001
Environment=PATH=/home/yuri/.nvm/versions/node/v24.12.0/bin:/home/yuri/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/yuri/Projects/hq
ExecStart=/home/yuri/.nvm/versions/node/v24.12.0/bin/node /home/yuri/Projects/cloudcli/dist-server/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Применение (в согласованный момент): записать юнит, `systemctl --user daemon-reload`,
`systemctl --user restart cloudcli.service`, проверить `curl -s 127.0.0.1:3001/api/auth/status`
и `systemctl --user status cloudcli.service` (в логе строка `Installed at: /home/yuri/Projects/cloudcli`).
Откат: вернуть `ExecStart=/home/yuri/.nvm/versions/node/v24.12.0/bin/cloudcli`.
