/**
 * Bridge for update checking, using custom Rust commands for channel-aware
 * checks (stable vs dev prerelease) and the plugin's download+install flow.
 *
 * Browser-mode calls return null gracefully.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { error as logError, info as logInfo } from '@tauri-apps/plugin-log';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  body: string | undefined;
  date: string | undefined;
};

export type DownloadProgress = {
  contentLength: number;
  downloaded: number;
};

export type UpdateChannel = 'stable' | 'dev';

// ---------------------------------------------------------------------------
// Tauri availability check (gets rid of errors in pure frontend mode)
// ---------------------------------------------------------------------------

function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------------------------------------------------------------------------
// Channel preference (persisted in app data dir via Rust)
// ---------------------------------------------------------------------------

export async function getUpdateChannel(): Promise<UpdateChannel> {
  if (!isTauriAvailable()) {
    return 'stable';
  }
  try {
    const ch = await invoke<UpdateChannel>('get_saved_update_channel');
    console.log('[updater] saved channel:', ch);
    return ch;
  } catch (err) {
    console.warn('[updater] getUpdateChannel failed, defaulting to stable:', err);
    return 'stable';
  }
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  if (!isTauriAvailable()) {
    return;
  }
  try {
    await invoke('save_update_channel', { channel });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Check for updates (channel-aware, via Rust)
// ---------------------------------------------------------------------------

/**
 * Check for updates using the given release channel.
 * Returns null if no update is available or the check fails.
 *
 * Internally calls the Rust `check_updates` command which:
 *  1. Picks the right GitHub Releases endpoint based on channel
 *  2. Uses the plugin's `UpdaterExt` API for the check
 *  3. Caches the `Update` object for subsequent download+install
 */
export async function fetchUpdateInfo(
  channel?: UpdateChannel,
): Promise<UpdateInfo | null> {
  if (!isTauriAvailable()) {
    return null;
  }
  // Never report updates in a dev build. `next dev` runs the newest CODE but
  // keeps a stale version NUMBER (the release tag only stamps it in CI), so a
  // dev app would perpetually see the latest release as an update and offer to
  // replace itself with an installed build. This is the single choke point for
  // every update check (StartupUpdateChecker AND GlobalUpdateIndicator both call
  // it), so gating here covers all of them. Production installs still check.
  if (process.env.NODE_ENV !== 'production') {
    return null;
  }
  console.log('[updater] fetchUpdateInfo called, channel:', channel ?? 'null (Rust default)');
  try {
    const result = await invoke<{
      updateAvailable: boolean;
      version: string;
      currentVersion: string;
      body: string | null;
      date: string | null;
    } | null>('check_updates', { channel: channel ?? null });

    console.log('[updater] check_updates result:', result);

    if (!result?.updateAvailable) return null;

    return {
      version: result.version,
      currentVersion: result.currentVersion,
      body: result.body ?? undefined,
      date: result.date ?? undefined,
    };
  } catch (err) {
    console.error('[updater] check_updates invoke failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download + install (via Rust — uses cached Update)
// ---------------------------------------------------------------------------

/** Progress payload emitted by the Rust `perform_update` command. */
type PerformUpdateProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
  phase: string;
};

/**
 * Download and install the previously cached update.
 * The Rust side handles signature verification, installer launch, and exit.
 *
 * `perform_update` REQUIRES an `on_chunk` Channel argument. Invoking it without
 * one made Tauri fail to deserialize the command arguments BEFORE the command
 * body ran — so no Rust log line was ever written and the UI only showed a
 * generic "Download or install failed". This is why in-app auto-update never
 * worked on any version. We pass the Channel (which also drives the progress
 * bar, previously ignored) and log through the Tauri log plugin so the reason
 * reaches dragonfruit.log (plain console.* is NOT forwarded to the Rust log —
 * attachConsole only forwards Rust→webview, not the reverse).
 */
export async function downloadAndInstall(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  try {
    const onChunk = new Channel<PerformUpdateProgress>();
    onChunk.onmessage = (msg) => {
      onProgress?.({
        contentLength: msg.totalBytes ?? 0,
        downloaded: msg.downloadedBytes,
      });
    };
    void logInfo('[updater] perform_update: invoking (download + install)');
    const result = await invoke<string>('perform_update', { onChunk });
    void logInfo(`[updater] perform_update returned: ${result}`);
    await relaunch();
    return true;
  } catch (err) {
    // Surface the real reason (bad args / signature verify / download / NSIS
    // install). Use the log plugin — console.error does NOT reach the Rust log.
    const message = err instanceof Error ? err.message : String(err);
    void logError(`[updater] perform_update/relaunch failed: ${message}`);
    console.error('[updater] perform_update/relaunch failed:', err);
    return false;
  }
}
