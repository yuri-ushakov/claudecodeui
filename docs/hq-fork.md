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
если сменились cwd, набор MCP-серверов, список запрещённых инструментов или effort; модель, режим
разрешений и список разрешённых инструментов переключаются на живом процессе
(`setModel`/`setPermissionMode`, `applyAllowedTools`). Бонус: ответ приходит быстрее — без
запуска CLI и без `resume`.

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

4. **Источник истины для политики инструментов — сервер** (по итогам боевого теста 30.09).
   Клиент слал `toolsSettings` (allowed/disallowed/skipPermissions/keepSessionAlive) из зеркала
   настроек в памяти страницы, которое читается с сервера только при входе. Планшет, открытый до
   включения тумблера, слал `keepSessionAlive=false` → сервер честно заводил новый процесс и
   закрывал удерживаемый вместе с агентом. Вдобавок «запомнить правило» на клиенте
   перезаписывало весь объект `claudePermissions` из устаревшей памяти — так из БД пропал сам
   `keepSessionAlive`. Теперь один владелец вопроса «под какой политикой идёт ход этого
   пользователя» — `server/modules/providers/services/tool-policy.service.ts`: шлюз чата
   (`dispatchRun` в `chat-websocket.service.ts`) берёт политику из `user_preferences`
   (`claudePermissions` и т. д. по провайдеру), а присланное клиентом — только если на сервере
   ничего нет. Служебные прогоны из `git`/`agent`-маршрутов (со своими `skipPermissions: true`)
   идут мимо шлюза и не затронуты. На клиенте: предпочтения перечитываются с сервера при
   переподключении websocket и при возврате вкладки (`refreshUserPreferences`), а «запомнить
   правило» пишет поверх сохранённого объекта, не теряя чужих ключей.
5. **Отпечаток процесса без списка разрешённых инструментов.** Он применяется к живому
   процессу (`applyAllowedTools` → `canUseTool` читает `sdkOptions.allowedTools`), так что
   запомненное правило или plan-режим больше не стоят процесса. В отпечатке остались только
   cwd, MCP, effort и **запрещённые** инструменты — их CLI получает при старте и отсекает сам,
   до обращения к хосту.
6. **Старый удерживаемый процесс завершается по-настоящему, и строго по экземпляру.** Раньше
   при замене процесса (`holdSession`) старому только закрывали stdin; CLI после EOF живёт,
   пока живы его фоновые агенты (до 30 мин, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`), а
   `interrupt` от `addSession` в уже закрытый stdin не доходил. Когда агент завершался, старый
   процесс запускал follow-up ход с мёртвым каналом разрешений — каждый инструмент падал с
   «Tool permission request failed: AbortError: Stream closed», а его вывод шёл в общий
   транскрипт и клиенту через оставшийся обработчик. Это и есть подтверждённый источник
   ошибок «Stream closed» в бою (транскрипт: ход 07:55Z шёл в pid 5677 — процессе хода 10:50,
   закрытом в 10:51). Теперь `HeldClaudeSession.close()` = EOF + завершение через SDK
   (`instance.close()`), если процесс не вышел сам за 5 с; замена делается провайдером явно
   (`retireHeldProcess`): запись `activeSessions` и `heldSessions` снимается только если она
   указывает на этот же экземпляр, поэтому смерть старого процесса не трогает новый (раньше
   `consume()` безусловно удалял запись по ключу — и мог снять регистрацию нового).
7. **Диагностика в лог**: одна строка на ход, когда процесс уже известен:
   `[Claude SDK] held: session=<ключ> turn=chat|scheduled|queued|agent pid=<pid CLI> keepSessionAlive=<bool> policy=server|client previous=none|held(age=Ns) decision=reused|new|off[(rewind)]|busy mismatch=<cwd,mcp,effort,disallowedTools>`.
   `turn` — кто прислал ход (`chat` — сокет чата, `scheduled` — сообщение по таймеру,
   `queued` — черновик из очереди, который сервер отправил, когда сессия освободилась,
   `agent` — `POST /api/agent`, например кнопка доски); `pid` — процесс CLI из SDK
   (`?` у тестового двойника). Источник хода объявляет вызывающий (`turnSource` в
   опциях прогона: шлюз чата, `runDetachedChatTurn`, маршрут агента).
8. **`result`, который завершает ход, — только свой** (по итогам боя 30.09, третий инцидент
   «Stream closed»). Причина найдена и воспроизведена без токенов
   (`scripts/hq/orphan-resume-probe.mjs`): когда предыдущий процесс погиб с работающим
   фоновым агентом (тумблер выключили, ход заменил процесс), следующий процесс при
   `resume` первым делом ставит уведомление об осиротевшем агенте («didn't finish before the
   previous session ended») как **отдельный prompt** и завершает его **собственным
   `result`** — без обращения к модели, `num_turns: 0`,
   `origin: { kind: 'task-notification' }` — ещё до того, как взглянет на сообщение хода
   (в журнале это второй `system init` сразу после). Провайдер принимал этот `result` за
   конец хода юзера: слал клиенту `complete` и закрывал stdin (`releasePromptStream`), а
   настоящий ход шёл уже с закрытым каналом — каждый инструмент вне allowlist падал в CLI
   с «Tool permission request failed: AbortError: Stream closed» через 7–14 с после старта.
   Так было во всех трёх инцидентах (07:42, 07:51, 10:47 UTC; в транскрипте перед каждым —
   `queue-operation` с `<task-notification>` и `promptSource: 'system'`). Теперь один
   владелец вопроса «этот `result` завершает мой ход?» — `endsTurn(message)` в
   `claude-held-session.js`: `result` с `origin.kind === 'task-notification'` ходом не
   считается ни у держателя (`runTurn`), ни у провайдера (`handleTurnMessage`); до конца
   хода такой `result` игнорируется целиком, после — это фоновая работа, отчитавшаяся
   follow-up-ходом (как и раньше: уведомление, отпускание процесса). `result` хода,
   присланного хостом, поля `origin` не несёт (CLI 2.1.284).
9. **Настройки: каждый писатель шлёт только свои поля.** `claudePermissions` пишут двое —
   диалог настроек и «запомнить правило» в чате; диалог писал весь объект из состояния,
   прочитанного из копии страницы на момент открытия. На странице, не догнавшей тумблер,
   включённый с другого устройства (или до включения), любое сохранение диалога — даже с
   вкладки «API и токены» — возвращало `keepSessionAlive=false` всем устройствам (так тумблер
   слетал 30.09 в 13:17). Теперь: сервер (`userPreferencesDb.savePreferences`) сливает
   объектные значения **по полям** (отсутствующие поля не трогает; массивы и скаляры
   заменяются целиком); клиент — `patchUserPreference(key, fields)` в `userSettings.ts` —
   шлёт только названные поля и так же сливает их в зеркало страницы; диалог при
   сохранении отправляет разницу с тем, что прочитал при открытии
   (`changedClaudePermissionFields`), а при открытии перечитывает сервер
   (`refreshUserPreferences`); «запомнить правило» шлёт только allowed/disallowed/skip.

Выключенный тумблер = поведение main без изменений (тест «with the option off…»).

Тесты: `server/modules/providers/list/claude/tests/claude-held-session.test.ts` (сессия: ходы,
отпечаток и `mismatches`, резервирование, таймер, реле, реестр по экземпляру, добивание
процесса после grace), `server/modules/providers/tests/claude-runtime-held.test.ts` (провайдер:
второй ход с другим writer на том же процессе, запрос разрешения во втором ходе, фоновый
агент переживает второй ход, режим без тумблера, замена процесса при смене cwd — старый
закрыт без interrupt и завершён, у нового открыт stdin и работает `canUseTool`; смена
allowed-списка не стоит процесса, смена disallowed — стоит; `result` осиротевшего
уведомления при resume не завершает ход и не закрывает stdin — на one-shot и на
удерживаемом процессе; удерживаемый процесс отпущен выключенным тумблером → у следующего
one-shot хода stdin открыт и через 5+ с, `canUseTool` доходит до writer),
`server/modules/providers/tests/tool-policy.service.test.ts` и
`server/modules/websocket/tests/chat-tool-policy.test.ts` (сервер важнее клиента, запасной
вариант, `skipPermissions` следует за политикой). Настройки:
`server/modules/database/tests/user-preferences.db.integration.test.ts` (слияние по полям),
`src/shared/tests/userSettings.test.ts` (`patchUserPreference`: только названные поля, две
правки в одном окне, пустая правка ничего не шлёт),
`src/modules/settings/tests/settingsControllerClaudePermissions.test.ts` (сохранение диалога
со «старым» состоянием не трогает тумблер; переключение шлёт одно поле).

## Известные ограничения

- Follow-up ход фонового агента и ход юзера теперь различаются по `origin` результата
  (правка 8): `result` агента (`origin.kind = task-notification`) ход юзера не завершает.
  Проверено на осиротевшем уведомлении (проба без модели); что follow-up завершённого агента
  несёт тот же `origin`, следует из кода CLI (14 мест `kind:"task-notification"`), но в бою с
  живым агентом ещё не наблюдалось — если у такого follow-up `origin` окажется пустым, поведение
  вернётся к прежнему: его `result` сойдёт за конец хода юзера, пришедшего в ту же секунду
  (ход дойдёт до клиента, «стоп» будет неактивен). upstream PR #1449 решает это по-своему.
- Перезапуск `cloudcli.service` убивает удерживаемые процессы вместе с фоновыми агентами —
  рестарт делать в согласованный момент, когда агентов нет.
- Осиротевший агент после замены процесса действительно теряется (его транскрипт остаётся
  в `/tmp/claude-1000/<проект>/<сессия>/tasks/<id>.output`); новый процесс лишь сообщает об
  этом уведомлением. Это поведение CLI, не форка: замена процесса = потеря фоновой работы,
  о чём клиент и предупреждает перед отправкой.
- Если «Stream closed» повторится — смотреть строку `[Claude SDK] held: …` этого хода
  (`pid`, `turn`), `pgrep -af claude` и `queue-operation`-записи транскрипта перед
  сообщением; проба `scripts/hq/orphan-resume-probe.mjs` показывает поведение CLI при
  resume с осиротевшим агентом без затрат токенов.
- `npm run typecheck` в upstream/main `dc7cb6c6` падает на
  `src/modules/sidebar/tests/recentConversationTitleSync.test.ts` (тест не передаёт
  `backgroundSessionIds`) — это ошибка upstream, к патчу отношения не имеет. **Грабли:** скрипт
  = `tsc -p tsconfig.json && tsc -p server/tsconfig.json`, и из-за этой ошибки серверная
  проверка не запускается вовсе; серверные типы (включая тесты — они входят в сборку
  `build:server`) проверять отдельно: `npx tsc --noEmit -p server/tsconfig.json`. Иначе ошибка
  всплывёт только в `npm run build`, а тот в `dist-server` ничего не подменит (сборка идёт в
  `dist-server.next`) — старая сборка остаётся молча.

## Браузер для агентов (`server/modules/browser-use/`)

Встроенный браузерный модуль upstream (вкладка Browser, MCP `cloudcli-browser`) в форке
изменён в трёх местах — по итогам проверки 30.09 (карточка `hq/tasks/hq-browser-runtime.md`).

1. **Запуск полного Chromium вместо headless-shell.** Без канала Playwright в headless-режиме
   берёт `chromium-headless-shell`: `navigator.webdriver = true`, нет `window.chrome` и
   плагинов, «HeadlessChrome» в Client Hints — сайты видят автоматизацию. Теперь один
   владелец вопроса «какой браузер и с какими ключами» — `browser-launch.ts`
   (`readBrowserLaunchConfig` → `buildBrowserLaunchOptions`), обе ветки запуска
   (`launch` для временной сессии и `launchPersistentContext` для профиля) берут опции
   оттуда: `channel: 'chromium'` (полный `chromium-1243` из `~/.cache/ms-playwright`, в
   Playwright ≥ 1.49 с `--headless` это новый headless-режим), `headless: true`,
   `--disable-blink-features=AutomationControlled`, `--disable-dev-shm-usage`,
   `ignoreDefaultArgs: ['--enable-automation']`. Проверка готовности (`probeRuntime`) смотрит на
   исполняемый файл того же канала (`resolveBrowserExecutablePath`: для `chromium` — публичный
   `executablePath()`, для фирменных каналов — реестр Playwright из `playwright-core/lib/coreBundle`).
   Переменные окружения (юнит `cloudcli.service`, `Environment=`):
   - `CLOUDCLI_BROWSER_USE_CHANNEL` — `chromium` (умолчание) или `chrome`, `chrome-beta`,
     `msedge` и т. д., если фирменный браузер установлен в системе;
   - `CLOUDCLI_BROWSER_USE_HEADLESS` — `true` (умолчание); `false`/`0`/`no`/`off` — с окном
     (нужен дисплей: X/Wayland или Xvfb).
   Результат пробы (`scripts/hq/browser-launch-probe.mjs`, 30.09): `webdriver: false`,
   `window.chrome` есть, `plugins: 5`, `Sec-Ch-Ua: "Chromium";v="153"` (без HeadlessChrome);
   **в `User-Agent` «HeadlessChrome/153.0.0.0» остаётся** — это свойство самого Chromium в любом
   headless-режиме (и у Google Chrome тоже), а не выбранного бинаря. Убрать его можно только
   подменой UA (`--user-agent`/`userAgent` контекста) или запуском с окном — решение отдельное.
   Google Chrome при желании: `npx playwright install chrome` (deb, sudo) и
   `CLOUDCLI_BROWSER_USE_CHANNEL=chrome`; в headless он даёт тот же UA с «Headless».
2. **Скриншот только по запросу.** Каждый ответ MCP нёс `screenshotDataUrl` (JPEG base64,
   70–140 КБ) — `navigate`/`snapshot`/`close_session`/`list_sessions` у агентов вылетали за
   лимит вывода. Владелец вопроса «что из сессии видит потребитель» — `browser-session-views.ts`:
   `publicSessionView` (вкладка Browser, `/api/browser-use/sessions`, со скриншотом для превью),
   `agentSessionView` (ответы MCP: метаданные без скриншота), `agentScreenshotView`
   (`browser_take_screenshot` — свежий скриншот), `agentSnapshotView` (`browser_snapshot`:
   текст страницы; скриншот — по флагу `includeScreenshot`, по умолчанию false).
3. **Установка рантайма в каталог приложения.** `Install Runtime` делал `npm install --no-save
   playwright` в `process.cwd()` — у юнита это `WorkingDirectory=~/Projects/hq`, и пакет
   уезжал в `hq/node_modules`, а `require('playwright')` из каталога приложения его не видел.
   Теперь команды установки идут в `APP_ROOT` (`findApplicationRoot`, как в `server/index.ts`);
   `playwright` добавлен в `optionalDependencies` package.json (`^1.63.0`, lock обновлён), так что
   `npm ci` его ставит и не выбрасывает. Шаг `install-deps` (системные библиотеки Chromium)
   требует sudo, которого у сервиса нет: сообщение об ошибке содержит готовую команду с node из
   nvm и CLI Playwright из каталога приложения —
   `sudo /home/yuri/.nvm/versions/node/v24.12.0/bin/node /home/yuri/Projects/cloudcli/node_modules/playwright/cli.js install-deps chromium`.
   Браузер: `npx playwright install chromium` (из корня клона; кладёт в `~/.cache/ms-playwright`).

Тесты: `server/modules/browser-use/tests/browser-launch.test.ts` (конфиг из env, опции запуска,
путь исполняемого файла по каналу), `browser-session-views.test.ts` (форма ответов UI/агента,
скриншот только по запросу). Проба вживую без сервера: `node scripts/hq/browser-launch-probe.mjs`
(`--online` — плюс `https://httpbin.org/headers`, `--shell` — прежний headless-shell для сравнения;
нужен собранный `dist-server`).

## Просмотр файлов по ссылке (`/view`, `CLOUDCLI_VIEW_ROOTS`)

Главная сессия штаба пишет в чат путь к отчёту агента — файл `.md` в `hq/reports/` или в
репозитории другого проекта. Нужно, чтобы он открывался по клику, в том числе с планшета, и не
только внутри текущего проекта. Два способа открыть, один владелец рендера — `CodeEditor`
(тот же компонент, что открывает файлы вкладка «Файлы»):

- **(а) внутри приложения** — клик по ссылке `[имя](/abs/path.md)`, по голому абсолютному пути
  `/home/yuri/…/report.md` в тексте ответа или по такому же пути в обратных кавычках открывает
  файл в боковой панели редактора, как раньше открывались ссылки на файлы проекта. Новое:
  голые абсолютные пути на `.md`/`.markdown` (с необязательным `:строка`) становятся ссылками
  (remark-плагин `remarkAbsoluteMarkdownPaths` в `src/modules/chat/utils/markdownFilePaths.ts`;
  пути на другие расширения не трогаются — как в upstream, кликабельны только ссылки `[]()`), и
  **markdown открывается сразу отрендеренным** — кнопка в шапке переключает на исходник (это
  касается и открытия из «Файлов»: раньше `.md` открывался в CodeMirror, а превью включалось
  кнопкой; выбор переключателя помнится для открытого файла, следующий файл начинает со своего
  умолчания).
- **(б) отдельной вкладкой браузера** — ссылка `[имя](/view?path=/abs/path.md)` рендерится
  обычной ссылкой с `target=_blank rel=noopener`; страница `/view` (маршрут в `App.tsx`,
  `src/modules/file-view/FileViewRoute.tsx`) показывает тот же `CodeEditor` на весь экран,
  без проекта: файл читается через `GET /api/files/view?path=…`, только чтение (кнопки
  «Сохранить» нет, CodeMirror `readOnly`), markdown — отрендеренный, остальное — исходник
  моноширинным. Логин — тот же `ProtectedRoute`, что у всего приложения: без токена в
  `localStorage` показывается форма входа, после входа открывается файл. Относительный href
  → тот же origin, поэтому ссылка работает и через tail-адрес с планшета. Крестик закрывает
  вкладку (если её открыл скрипт), иначе ведёт в рабочее пространство.

**Какие пути можно читать — один владелец на сервере:** `server/modules/file-view/`
(`fileViewPolicy`, `file-view-policy.ts`). Путь разрешён, если после разрешения симлинков
(`realpath`, как в `resolvePathUnderRoots`) он лежит под одним из корней:

1. встроенные read-only корни upstream (`/tmp`, `os.tmpdir()`, `~/.claude/projects` —
   `resolveReadOnlyRootPath` в `server/shared/utils.ts`);
2. каталоги из переменной окружения **`CLOUDCLI_VIEW_ROOTS`** — абсолютные пути через `:`
   (у нас `/home/yuri/Projects:/data`; относительные и пустые записи отбрасываются;
   `file-view-roots.ts`), читается при старте процесса;
3. каталоги всех зарегистрированных проектов (таблица `projects`, включая архивные), список
   берётся на каждый запрос.

Симлинк из-под корня наружу не проходит (сравнивается реальный путь). `GET /api/files/view`
(`authenticateToken`) отдаёт `{ path, name, size, content }` только для обычных файлов
≤ 5 МБ; ошибки: 400 (не абсолютный путь, не файл, нет `path`), 403 (вне корней), 413 (велик).
Та же политика подключена к file-tree как `resolveReadOnlyRootPath` в
`file-tree.module.ts`, поэтому путь (а) — `GET /api/file-tree/projects/:id/file?filePath=`
— читает файлы из `CLOUDCLI_VIEW_ROOTS` и из каталогов других проектов, какой бы проект ни
был выбран; записи это не касается (write-пути file-tree сверяют только корень своего
проекта). Побочное следствие: диалог «обзор файловой системы» тоже может заглядывать в эти
корни (только чтение).

В юнит `cloudcli.service` добавить строку (и перезапустить в спокойный момент):

```ini
Environment=CLOUDCLI_VIEW_ROOTS=/home/yuri/Projects:/data
```

Без неё работают только каталоги проектов и встроенные корни.

Формат ссылки для главной сессии: `[отчёт](/view?path=/home/yuri/Projects/hq/reports/<файл>.md)`
— новая вкладка; `/home/yuri/Projects/hq/reports/<файл>.md` голым текстом или в кавычках —
панель редактора в этой же вкладке. Пробелы в пути в `/view?path=` кодировать (`%20`).

Тесты: `server/modules/file-view/tests/` (разбор env, политика на реальных каталогах —
внутри/снаружи/симлинк/`..`/каталог проекта, сервис — лимит, не файл, 403, маршрут — разбор
`path` из query, коды ошибок), `src/modules/chat/tests/markdownFilePaths.test.ts` и
`fileReferenceLinks.test.tsx` (ссылка `/view?…` — новая вкладка, голый путь и путь в кавычках —
редактор, не-markdown путь остаётся текстом), `src/modules/file-view/tests/viewedFile.test.ts`,
`src/modules/code-editor/tests/viewerDocumentSource.test.tsx` (без проекта — viewer-эндпоинт,
read-only, без «Сохранить»; markdown открыт отрендеренным, переключатель показывает исходник).

## Место вкладки плагина: `tabOrder`

В upstream вкладки плагинов всегда идут в хвост после встроенных, за разделителем. Форк
читает из манифеста плагина поле `tabOrder` (целое ≥ 0; `validateManifest` и `scanPlugins` в
`server/modules/plugins/plugin-registry.service.ts`, тип `Plugin.tabOrder: number | null` в
`src/shared/types.ts`): это число встроенных вкладок, после которых ставится плагин — `0` перед
«Чатом», `1` сразу после него, число больше длины полосы — после последней встроенной. Список
строит чистая функция `orderTabs(builtIn, plugins)`
(`src/modules/project-workspace/utils/workspaceTabOrder.ts`): позиционированные плагины
встраиваются в ряд встроенных (равные слоты — в порядке сканирования), остальные — в хвост, и
разделитель рисуется только перед хвостом (`WorkspaceTabs.tsx`). У доски штаба `"tabOrder": 1`.
Тесты: `workspaceTabOrder.test.ts`, `server/modules/plugins/tests/plugin-registry.test.ts`.

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
(`Keep the process alive for the whole conversation`). Настройка хранится на сервере
(`user_preferences.claudePermissions.keepSessionAlive` в `~/.cloudcli/auth.db`) и **общая для
всех устройств**: включить один раз с любого, сервер применяет её к каждому ходу сам, что бы ни
прислала страница. Действует со следующего хода: первый ход после включения ещё заводит процесс
как обычно, но уже удерживает его. Проверить, что включено:
`sqlite3 ~/.cloudcli/auth.db "select preference_value from user_preferences where preference_key='claudePermissions'"`
— в JSON должен быть `"keepSessionAlive":true`. (30.09 ключ дважды слетал: сначала его
стёрла запись «запомнить правило», потом сохранение диалога настроек с устаревшей страницы;
оба писателя теперь шлют только свои поля — правка 9.)

## Как проверить, что работает

1. Включить тумблер (один раз, с любого устройства) и убедиться по БД, что он записан.
2. В главной сессии попросить запустить фонового агента минут на пять
   (`Agent` с `run_in_background: true`, например «посчитай строки во всех файлах памяти и подожди
   300 секунд перед ответом»).
3. Не дожидаясь, отправить в чат два обычных сообщения (второе — с планшета). Ответы должны
   приходить без задержки на запуск CLI; в списке процессов — один `claude` на эту сессию
   (`pgrep -af claude`), который не перезапускается.
4. Через пять минут в чат должен прийти итог агента (follow-up ход) — на то устройство, с
   которого было последнее сообщение; в панели уведомлений — «фоновая работа завершена».
5. В журнале (`journalctl --user -u cloudcli.service`) на каждый ход — строка
   `[Claude SDK] held: … turn=chat pid=<N> … policy=server … decision=reused` с одним и тем
   же `pid`; `decision=new` с `mismatch=…` объясняет, почему процесс сменился.
6. Контроль: выключить тумблер и повторить — второе сообщение убьёт агента (поведение main).

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
Environment=CLOUDCLI_VIEW_ROOTS=/home/yuri/Projects:/data
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
