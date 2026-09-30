import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CodeEditor } from '@/modules/code-editor';
import { parseViewedFile } from '@/modules/file-view/viewedFile';

/**
 * Rendered by App for `/view?path=<absolute path>`: the same editor the Files
 * tab opens, filling a browser tab of its own. Markdown starts rendered, the
 * file is read-only, and there is no project around it — the server decides
 * by its readable roots whether the path may be shown.
 */
export default function FileViewRoute() {
  const { t } = useTranslation('codeEditor');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedPath = searchParams.get('path');
  const file = useMemo(() => parseViewedFile(requestedPath), [requestedPath]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = file ? file.name : t('viewer.title', 'File viewer');
    return () => {
      document.title = previousTitle;
    };
  }, [file, t]);

  // A tab the chat opened closes itself; one typed in by hand cannot be closed
  // by script, so it goes to the workspace instead.
  const close = useCallback(() => {
    window.close();
    navigate('/');
  }, [navigate]);

  if (!file) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
        <p className="max-w-lg text-center text-sm text-muted-foreground">
          {t('viewer.invalidPath', 'This page shows one file by absolute path: /view?path=/full/path/to/file.md')}
        </p>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <CodeEditor file={file} onClose={close} isSidebar />
    </div>
  );
}
