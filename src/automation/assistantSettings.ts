/**
 * Settings > AI Assistant: whether the automation (MCP) bridge may connect,
 * plus a tiny live status store the settings tab displays.
 */

export type AssistantSettings = {
  /** Let an AI assistant drive DragonFruit through the bundled MCP server. */
  enabled: boolean;
};

export const ASSISTANT_SETTINGS_STORAGE_KEY = 'app-assistant-settings';
const ASSISTANT_SETTINGS_EVENT = 'app-assistant-settings-changed';

// ON by default (product decision): the bridge only accepts an authenticated,
// loopback-only peer, so enabling it doesn't expose the app.
export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = { enabled: true };

let cachedRaw: string | null | undefined;
let cachedSnapshot: AssistantSettings = DEFAULT_ASSISTANT_SETTINGS;

export function getSavedAssistantSettings(): AssistantSettings {
  if (typeof window === 'undefined') return DEFAULT_ASSISTANT_SETTINGS;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ASSISTANT_SETTINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_ASSISTANT_SETTINGS;
  }
  if (cachedRaw === raw) return cachedSnapshot;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<AssistantSettings>) : null;
    cachedSnapshot = { enabled: parsed?.enabled !== false };
  } catch {
    cachedSnapshot = DEFAULT_ASSISTANT_SETTINGS;
  }
  return cachedSnapshot;
}

export function saveAssistantSettings(settings: AssistantSettings): void {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify({ enabled: settings.enabled });
  try {
    window.localStorage.setItem(ASSISTANT_SETTINGS_STORAGE_KEY, serialized);
  } catch {
    // ignore storage failures
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_SETTINGS_EVENT));
}

export function subscribeToAssistantSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== ASSISTANT_SETTINGS_STORAGE_KEY) return;
    listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(ASSISTANT_SETTINGS_EVENT, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(ASSISTANT_SETTINGS_EVENT, listener);
  };
}

// ── Live bridge status ──────────────────────────────────────────────────────

export type AssistantBridgeStatus =
  /** Turned off in settings, or not compiled into this build. */
  | 'disabled'
  /** Waiting for the MCP server (it isn't running, or is starting). */
  | 'waiting'
  /** Authenticated and ready for commands. */
  | 'connected'
  /** A peer answered but failed the token handshake (stale/foreign server). */
  | 'auth-failed';

let bridgeStatus: AssistantBridgeStatus = 'disabled';
const statusListeners = new Set<() => void>();

export function getAssistantBridgeStatus(): AssistantBridgeStatus {
  return bridgeStatus;
}

export function setAssistantBridgeStatus(next: AssistantBridgeStatus): void {
  if (next === bridgeStatus) return;
  bridgeStatus = next;
  statusListeners.forEach((l) => l());
}

export function subscribeToAssistantBridgeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}
