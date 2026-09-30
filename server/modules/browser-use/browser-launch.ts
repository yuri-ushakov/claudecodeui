import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Единственный владелец вопроса «какой браузер мы запускаем и с какими ключами».
 *
 * Обе ветки запуска (`chromium.launch` для временной сессии и
 * `chromium.launchPersistentContext` для профиля с куками) берут опции отсюда,
 * и проверка готовности рантайма смотрит на исполняемый файл того же канала,
 * который будет запущен.
 *
 * Почему не headless-shell: без канала Playwright в headless-режиме берёт
 * `chromium-headless-shell` — урезанную сборку, у которой `navigator.webdriver`
 * = true, нет `window.chrome` и плагинов, «HeadlessChrome» в Client Hints. Полный
 * Chromium (`channel: 'chromium'`) запускается с `--headless` в новом headless-режиме
 * и выглядит для сайтов как обычный браузер по этим признакам.
 */

export type BrowserLaunchConfig = {
  /** Канал Playwright: `chromium` (полный Chromium из кеша), `chrome`, `msedge` и т. д. */
  channel: string;
  /** Запускать без окна. */
  headless: boolean;
};

export type BrowserLaunchOptions = {
  channel: string;
  headless: boolean;
  args: string[];
  ignoreDefaultArgs: string[];
};

export const DEFAULT_BROWSER_CHANNEL = 'chromium';

const CHANNEL_ENV = 'CLOUDCLI_BROWSER_USE_CHANNEL';
const HEADLESS_ENV = 'CLOUDCLI_BROWSER_USE_HEADLESS';
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/** Ключи Chromium, которые скрывают признаки автоматизации и стабилизируют запуск в контейнере. */
const LAUNCH_ARGS = [
  // Без него Blink выставляет navigator.webdriver = true.
  '--disable-blink-features=AutomationControlled',
  // /dev/shm в контейнерах и юнитах бывает крошечным — рендерер падает на больших страницах.
  '--disable-dev-shm-usage',
];

/** Ключи Playwright по умолчанию, которые мы не передаём: `--enable-automation` включает инфобар и webdriver-флаги. */
const IGNORED_DEFAULT_ARGS = ['--enable-automation'];

/**
 * Читает настройки запуска из окружения.
 *
 * `CLOUDCLI_BROWSER_USE_CHANNEL` — канал (по умолчанию `chromium`); пустое значение
 * означает умолчание. `CLOUDCLI_BROWSER_USE_HEADLESS` — `false`/`0`/`no`/`off`
 * выключают headless (нужен дисплей), всё остальное — включён.
 */
export function readBrowserLaunchConfig(env: NodeJS.ProcessEnv = process.env): BrowserLaunchConfig {
  const channel = String(env[CHANNEL_ENV] || '').trim() || DEFAULT_BROWSER_CHANNEL;
  const headlessRaw = String(env[HEADLESS_ENV] ?? '').trim().toLowerCase();
  const headless = !FALSE_WORDS.has(headlessRaw);
  return { channel, headless };
}

/**
 * Строит опции для `chromium.launch` / `chromium.launchPersistentContext` из настроек.
 * Возвращает новый объект с копиями массивов — вызывающий может дополнять их, не трогая константы.
 */
export function buildBrowserLaunchOptions(config: BrowserLaunchConfig): BrowserLaunchOptions {
  return {
    channel: config.channel,
    headless: config.headless,
    args: [...LAUNCH_ARGS],
    ignoreDefaultArgs: [...IGNORED_DEFAULT_ARGS],
  };
}

/**
 * Путь к исполняемому файлу браузера того канала, который будет запущен, или null,
 * если Playwright такой канал не знает.
 *
 * Для `chromium` — публичный `playwright.chromium.executablePath()` (в Playwright ≥ 1.49
 * он указывает на полный Chromium, а не на headless-shell). Для фирменных каналов
 * (`chrome`, `msedge`, …) публичного API нет — путь берётся из реестра Playwright
 * (`playwright-core/lib/coreBundle`, экспорт объявлен в `exports` пакета, но это
 * внутренний модуль: при смене его формы возвращаем null, а не падаем).
 */
export function resolveBrowserExecutablePath(playwright: any, config: BrowserLaunchConfig): string | null {
  try {
    if (config.channel === DEFAULT_BROWSER_CHANNEL) {
      return playwright?.chromium?.executablePath?.() || null;
    }
    const registry = loadPlaywrightRegistry();
    const executable = registry?.findExecutable?.(config.channel);
    return executable?.executablePath?.() || null;
  } catch {
    return null;
  }
}

/**
 * Готов ли браузер выбранного канала: исполняемый файл известен и существует на диске.
 */
export function isBrowserExecutableInstalled(executablePath: string | null): boolean {
  return Boolean(executablePath && fs.existsSync(executablePath));
}

/**
 * Реестр исполняемых файлов Playwright — тот же, что использует `npx playwright install`.
 * Резолвится из каталога приложения, как и сам пакет `playwright` в сервисе, поэтому версии совпадают.
 */
function loadPlaywrightRegistry(): any | null {
  const coreBundle = require('playwright-core/lib/coreBundle');
  return coreBundle?.registry?.registry || null;
}
