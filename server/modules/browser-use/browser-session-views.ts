/**
 * Единственный владелец вопроса «что из состояния сессии видит потребитель».
 *
 * Два потребителя с разными нуждами:
 * - вкладка Browser в UI показывает превью страницы — ей нужен `screenshotDataUrl`
 *   (JPEG в base64, 70–140 КБ), который сервис обновляет после каждого действия;
 * - агент через MCP получает ответ в текстовый контекст модели — скриншот там
 *   раздувает каждый ответ до лимита вывода, поэтому он отдаётся только по запросу
 *   (`browser_take_screenshot`, `browser_snapshot` с `includeScreenshot`).
 *
 * Функции чистые: ни браузера, ни БД — проверяются юнит-тестами без окружения.
 */

export type BrowserSessionCursor = {
  x: number;
  y: number;
  actor: 'agent';
};

export type BrowserSessionViewport = {
  width: number;
  height: number;
};

/** Полное состояние сессии, как его держит сервис. */
export type BrowserSessionState = {
  id: string;
  ownerId: string;
  createdBy: 'agent';
  runtime: 'cloud' | 'local';
  status: 'ready' | 'stopped' | 'unavailable';
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  profileName: string | null;
  viewport: BrowserSessionViewport | null;
  cursor: BrowserSessionCursor | null;
};

/** Сессия для UI: всё, кроме владельца. */
export type PublicBrowserSessionView = Omit<BrowserSessionState, 'ownerId'>;

/** Сессия для агента: то же без скриншота. */
export type AgentBrowserSessionView = Omit<PublicBrowserSessionView, 'screenshotDataUrl'>;

/**
 * Представление для вкладки Browser (`/api/browser-use/sessions`): скрывает только
 * `ownerId`, скриншот остаётся — панель рисует его как превью страницы.
 */
export function publicSessionView(session: BrowserSessionState): PublicBrowserSessionView {
  const { ownerId: _ownerId, ...publicFields } = session;
  return publicFields;
}

/**
 * Представление для ответов MCP: метаданные без скриншота.
 * Скриншот отдаёт `agentScreenshotView`, когда агент его явно попросил.
 */
export function agentSessionView(session: BrowserSessionState): AgentBrowserSessionView {
  const { screenshotDataUrl: _screenshot, ...fields } = publicSessionView(session);
  return fields;
}

/**
 * Ответ на явный запрос скриншота: метаданные сессии плюс текущий `screenshotDataUrl`.
 */
export function agentScreenshotView(session: BrowserSessionState): AgentBrowserSessionView & { screenshotDataUrl: string | null } {
  return {
    ...agentSessionView(session),
    screenshotDataUrl: session.screenshotDataUrl,
  };
}

/**
 * Ответ `browser_snapshot`: метаданные и видимый текст страницы; скриншот — только по флагу.
 */
export function agentSnapshotView(
  session: BrowserSessionState,
  text: string,
  includeScreenshot: boolean,
): { session: AgentBrowserSessionView; text: string; screenshotDataUrl?: string | null } {
  const view = { session: agentSessionView(session), text };
  return includeScreenshot ? { ...view, screenshotDataUrl: session.screenshotDataUrl } : view;
}
