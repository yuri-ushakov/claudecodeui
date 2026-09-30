// Проба: как выглядит браузер, которым сервис browser-use запускает сессии агентов,
// с точки зрения сайта. Запускает Chromium теми же опциями, что и сервер
// (`buildBrowserLaunchOptions(readBrowserLaunchConfig())` из собранного модуля),
// без сервера и без рестарта юнита, и печатает признаки автоматизации.
//
// Запуск из корня репо после `npm run build:server` (модуль берётся из dist-server):
//   node scripts/hq/browser-launch-probe.mjs                 # about:blank, без сети
//   node scripts/hq/browser-launch-probe.mjs --online        # плюс https://httpbin.org/headers
//   CLOUDCLI_BROWSER_USE_CHANNEL=chrome node scripts/hq/browser-launch-probe.mjs
//   node scripts/hq/browser-launch-probe.mjs --shell         # для сравнения: headless-shell, как было до правки
//
// Ожидаемо для полного Chromium: webdriver false, window.chrome есть, plugins > 0.
// UA в любом headless-режиме Chromium содержит «HeadlessChrome» — это свойство
// самого Chromium, не выбранного бинаря; проба печатает его как есть.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const launchModulePath = path.join(root, 'dist-server', 'server', 'modules', 'browser-use', 'browser-launch.js');

const online = process.argv.includes('--online');
const compareShell = process.argv.includes('--shell');

const { chromium } = require(path.join(root, 'node_modules', 'playwright'));
const { buildBrowserLaunchOptions, readBrowserLaunchConfig, resolveBrowserExecutablePath } = await import(launchModulePath);

const config = readBrowserLaunchConfig();
const launchOptions = compareShell
  ? { headless: true, args: ['--disable-dev-shm-usage'] }
  : buildBrowserLaunchOptions(config);

console.log('config      :', JSON.stringify(config));
console.log('executable  :', resolveBrowserExecutablePath(require(path.join(root, 'node_modules', 'playwright')), config));
console.log('launch opts :', JSON.stringify(launchOptions));

const browser = await chromium.launch(launchOptions);
try {
  console.log('version     :', browser.version());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto('about:blank');
  const signals = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const debugInfo = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      windowChrome: typeof window.chrome,
      pluginsLength: navigator.plugins.length,
      uaBrands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => `${b.brand} ${b.version}`) : null,
      languages: navigator.languages,
      webglRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
    };
  });
  console.log('signals     :', JSON.stringify(signals, null, 2));
  console.log('verdict     :', [
    /Headless/i.test(signals.userAgent) ? 'UA: «Headless» ЕСТЬ' : 'UA: без «Headless»',
    signals.webdriver ? 'webdriver: true (плохо)' : `webdriver: ${signals.webdriver}`,
    signals.windowChrome === 'object' ? 'window.chrome: есть' : 'window.chrome: НЕТ',
    signals.pluginsLength > 0 ? `plugins: ${signals.pluginsLength}` : 'plugins: 0 (плохо)',
  ].join('; '));

  if (online) {
    await page.goto('https://httpbin.org/headers', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const body = await page.locator('body').innerText();
    console.log('httpbin     :', body.trim());
  }
} finally {
  await browser.close();
}
