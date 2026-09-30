import { useCallback, useEffect, useRef, useState } from 'react';

import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { setNotificationSoundEnabled } from '@/shared/utils';
import {
  readCodeEditorSettings,
  writeCodeEditorSettings,
} from '@/shared/codeEditorSettings';
import {
  patchUserPreference,
  readUserPreference,
  refreshUserPreferences,
  writeUserPreferences,
} from '@/shared/userSettings';
import { useProviderAuthStatus } from '@/modules/provider-auth';
import type { AgentProvider, ClaudePermissionsState, CodeEditorSettingsState, CodexPermissionMode, CursorPermissionsState, NotificationPreferencesState, ProjectSortOrder, SettingsMainTab } from '@/shared/types';

const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type ClaudeSettingsStorage = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  keepSessionAlive?: boolean;
  projectSortOrder?: ProjectSortOrder;
};

type CursorSettingsStorage = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  skipPermissions?: boolean;
};

type CodexSettingsStorage = {
  permissionMode?: CodexPermissionMode;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['agents', 'appearance', 'git', 'api', 'tasks', 'browser', 'notifications', 'plugins', 'about'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const toCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
  keepSessionAlive: false,
});

const CLAUDE_PERMISSION_FIELDS = ['allowedTools', 'disallowedTools', 'skipPermissions', 'keepSessionAlive'] as const;

/**
 * The Claude permission fields the user changed in this dialog: what `edited`
 * says differently from `loaded`. Only these are written, so a dialog opened
 * on a page whose copy of the settings is behind (a switch flipped on
 * another device since the page loaded) cannot put its stale copy of the
 * other fields back on every device.
 */
const changedClaudePermissionFields = (
  loaded: ClaudePermissionsState,
  edited: ClaudePermissionsState,
): Partial<ClaudePermissionsState> => {
  const changed: Partial<ClaudePermissionsState> = {};
  for (const field of CLAUDE_PERMISSION_FIELDS) {
    if (JSON.stringify(loaded[field]) !== JSON.stringify(edited[field])) {
      (changed as Record<string, unknown>)[field] = edited[field];
    }
  }
  return changed;
};

const createEmptyCursorPermissions = (): CursorPermissionsState => ({
  ...DEFAULT_CURSOR_PERMISSIONS,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const closeTimerRef = useRef<number | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissions] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  // What the dialog last read or wrote; a save sends only what differs from it.
  const savedClaudePermissionsRef = useRef<ClaudePermissionsState>(createEmptyClaudePermissions());
  const [cursorPermissions, setCursorPermissions] = useState<CursorPermissionsState>(() => (
    createEmptyCursorPermissions()
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));
  const [codexPermissionMode, setCodexPermissionMode] = useState<CodexPermissionMode>('default');

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const loadSettings = useCallback(async () => {
    try {
      // The dialog shows the server's copy, not what this page happened to
      // hold: a setting can have changed on another device since it loaded.
      await refreshUserPreferences();

      const savedClaudeSettings = readUserPreference<ClaudeSettingsStorage>('claudePermissions', {});
      const loadedClaudePermissions: ClaudePermissionsState = {
        allowedTools: savedClaudeSettings.allowedTools || [],
        disallowedTools: savedClaudeSettings.disallowedTools || [],
        skipPermissions: Boolean(savedClaudeSettings.skipPermissions),
        keepSessionAlive: Boolean(savedClaudeSettings.keepSessionAlive),
      };
      savedClaudePermissionsRef.current = loadedClaudePermissions;
      setClaudePermissions(loadedClaudePermissions);
      setProjectSortOrder(readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name');

      const savedCursorSettings = readUserPreference<CursorSettingsStorage>('cursorPermissions', {});
      setCursorPermissions({
        allowedCommands: savedCursorSettings.allowedCommands || [],
        disallowedCommands: savedCursorSettings.disallowedCommands || [],
        skipPermissions: Boolean(savedCursorSettings.skipPermissions),
      });

      const savedCodexSettings = readUserPreference<CodexSettingsStorage>('codexPermissions', {});
      setCodexPermissionMode(toCodexPermissionMode(savedCodexSettings.permissionMode));

      try {
        const notificationResponse = await api.settings.notificationPreferences();
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          if (notificationData.success && notificationData.preferences) {
            setNotificationPreferences(normalizeNotificationPreferences(notificationData.preferences));
          } else {
            setNotificationPreferences(createDefaultNotificationPreferences());
          }
        } else {
          setNotificationPreferences(createDefaultNotificationPreferences());
        }
      } catch {
        setNotificationPreferences(createDefaultNotificationPreferences());
      }

    } catch (error) {
      console.error('Error loading settings:', error);
      setClaudePermissions(createEmptyClaudePermissions());
      setCursorPermissions(createEmptyCursorPermissions());
      setNotificationPreferences(createDefaultNotificationPreferences());
      setCodexPermissionMode('default');
      setProjectSortOrder('name');
    }
  }, []);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      const authStatus = await checkProviderAuthStatus(loginProvider);

      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; refreshing auth status before setting save status.`);
      }

      setSaveStatus(authStatus.authenticated ? 'success' : 'error');
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  const saveSettings = useCallback(async () => {
    setSaveStatus(null);

    try {
      // Claude's permissions are shared with the chat ("remember this rule"),
      // so only the fields edited here are sent, over whatever is stored.
      const changedClaudePermissions = changedClaudePermissionFields(savedClaudePermissionsRef.current, claudePermissions);
      if (Object.keys(changedClaudePermissions).length > 0) {
        patchUserPreference('claudePermissions', changedClaudePermissions);
        savedClaudePermissionsRef.current = claudePermissions;
      }

      // One call so the rest of the dialog's state reaches the server as a
      // single merge-patch rather than three racing requests.
      writeUserPreferences({
        projectSortOrder,
        cursorPermissions: {
          allowedCommands: cursorPermissions.allowedCommands,
          disallowedCommands: cursorPermissions.disallowedCommands,
          skipPermissions: cursorPermissions.skipPermissions,
        },
        codexPermissions: {
          permissionMode: codexPermissionMode,
        },
      });

      const notificationResponse = await api.settings.saveNotificationPreferences(
        notificationPreferences,
      );
      if (!notificationResponse.ok) {
        throw new Error('Failed to save notification preferences');
      }

      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [
    claudePermissions,
    codexPermissionMode,
    cursorPermissions.allowedCommands,
    cursorPermissions.disallowedCommands,
    cursorPermissions.skipPermissions,
    notificationPreferences,
    projectSortOrder,
  ]);

  // Persist on the user's edit rather than in an effect keyed on the settings
  // object. The effect form also ran on mount, so merely opening this dialog
  // rewrote all four keys — which reset the editor's font size for anyone who
  // had never changed it.
  //
  // The other three keys are merged from storage rather than from the rendered
  // state, so two edits landing in one React batch cannot write the second one
  // on top of a pre-first-edit snapshot. Storage is the newest value because
  // this is the only writer that can be behind — the editor's own wordWrap
  // mirror in useCodeEditorSettings only ever writes back what it just read.
  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      const next = { ...readCodeEditorSettings(), [key]: value };
      setCodeEditorSettings(next);
      writeCodeEditorSettings(next);
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab(normalizeMainTab(initialTab));
    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  // Auto-save permissions and sort order with debounce
  const autoSaveTimerRef = useRef<number | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    // Skip auto-save on initial load (settings are being loaded from the store)
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [saveSettings]);

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  // Reset initial load flag when settings dialog opens
  useEffect(() => {
    if (isOpen) {
      isInitialLoadRef.current = true;
    }
  }, [isOpen]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    cursorPermissions,
    setCursorPermissions,
    notificationPreferences,
    setNotificationPreferences,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}
