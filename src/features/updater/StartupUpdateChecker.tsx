'use client';

import { useUpdateChecker } from '@/features/updater/useUpdateChecker';

/**
 * Runs the update check at app startup (not only when the Settings → Updates
 * tab is open) and surfaces a small banner when a new version is available.
 *
 * The daily throttle + the actual check live in `useUpdateChecker`; mounting
 * this component at the app root is what makes that auto-check fire on launch.
 * It renders nothing unless there is something to show.
 */
export function StartupUpdateChecker(): React.ReactElement | null {
    const { state, downloadAndInstall, dismiss } = useUpdateChecker();

    const isBusy = state.status === 'downloading' || state.status === 'installing';
    if (state.status !== 'available' && !isBusy && state.status !== 'installed') {
        return null;
    }

    const pct = state.status === 'downloading' && state.progress.contentLength > 0
        ? Math.round((state.progress.downloaded / state.progress.contentLength) * 100)
        : null;

    return (
        <div
            role="status"
            className="fixed bottom-4 right-4 z-[9999] max-w-xs rounded-lg border p-3 shadow-xl"
            style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
                background: 'var(--surface-1)',
                color: 'var(--text-strong)',
            }}
        >
            {state.status === 'available' && (
                <>
                    <div className="text-sm font-semibold">Mise à jour disponible</div>
                    <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                        DragonFruit {state.info.version} est prête
                        {state.info.currentVersion ? ` (actuelle ${state.info.currentVersion})` : ''}.
                    </div>
                    <div className="mt-2 flex gap-2">
                        <button
                            onClick={() => { void downloadAndInstall(); }}
                            className="ui-button !h-7 px-2 text-[11px] font-semibold"
                            style={{
                                borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 70%)',
                                color: 'var(--accent-contrast)',
                            }}
                        >
                            Installer
                        </button>
                        <button
                            onClick={() => dismiss()}
                            className="ui-button ui-button-secondary !h-7 px-2 text-[11px]"
                        >
                            Plus tard
                        </button>
                    </div>
                </>
            )}

            {state.status === 'downloading' && (
                <>
                    <div className="text-sm font-semibold">Téléchargement de la mise à jour…</div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded" style={{ background: 'var(--surface-0)' }}>
                        <div
                            className="h-full rounded transition-[width]"
                            style={{ width: `${pct ?? 0}%`, background: 'var(--accent)' }}
                        />
                    </div>
                    {pct != null && <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{pct}%</div>}
                </>
            )}

            {state.status === 'installing' && (
                <div className="text-sm font-semibold">Installation… l&apos;app va redémarrer.</div>
            )}

            {state.status === 'installed' && (
                <div className="text-sm font-semibold">Mise à jour installée — redémarrage…</div>
            )}
        </div>
    );
}
