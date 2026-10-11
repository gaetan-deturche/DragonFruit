import { useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { getSettings } from '@/supports/Settings/state';
import { getSnapshot } from '@/supports/state';
import type { AutoSupportSettings } from '@/supports/autoSupport/settings';
import {
    getSavedAssistantSettings,
    setAssistantBridgeStatus,
    subscribeToAssistantSettings,
} from '@/automation/assistantSettings';

/**
 * Automation bridge — lets an AI assistant (through the bundled DragonFruit MCP
 * server, tools/dragonfruit-mcp) drive the app: load/orient/arrange models,
 * generate supports, inspect the viewport, export.
 *
 * It runs INSIDE the webview (as a hook mounted near the scene root) so it can
 * touch live React scene state — the model id, the scanned islands — that a
 * headless process cannot reach. It opens a WebSocket to the MCP server and
 * answers JSON commands.
 *
 * Gating: compiled in when NEXT_PUBLIC_DF_AUTOMATION=1 (set by the release CI)
 * or in dev; at runtime it follows Settings > AI Assistant (ON by default).
 *
 * Security: loopback URL only, and no command is accepted before a mutual
 * HMAC handshake keyed by the per-launch token Rust writes for the server
 * (src-tauri/src/automation.rs). The token never enters JS — we ask Rust to
 * sign the challenges:
 *   server → { type:'auth-challenge', nonce:S }
 *   app    → { type:'auth-response', proof:HMAC('app:'+S), nonce:C }
 *   server → { type:'auth-ok', proof:HMAC('server:'+C) }   (verified here)
 *
 * Protocol afterwards: the server sends `{ id, cmd, args? }`; the bridge replies
 * `{ id, ok, result? , error? }`.
 */

export interface ModelTransformOps {
    /** Read the current transform (rotation in radians), or null if no model. */
    get: () => { position: { x: number; y: number; z: number }; rotationRad: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } } | null;
    setPosition: (x: number, y: number, z: number) => void;
    /** Set rotation in RADIANS. */
    setRotationRad: (x: number, y: number, z: number) => void;
    setScale: (x: number, y: number, z: number) => void;
    /** Centre the model on the plate in XY. */
    centerXY: () => void;
    /** Lift the model so its lowest point sits `mm` above the plate. */
    elevate: (mm: number) => void;
    /** Reset position + rotation (drops back to default). */
    reset: () => void;
}

export interface AutomationBridgeHandlers {
    /** Current active model id, or null. */
    getActiveModelId: () => string | null;
    /** Current scanned + filtered islands for the active model. */
    getIslands: () => DetectedIsland[];
    /** Current app tab/mode (e.g. 'prepare' | 'support' | 'analysis'). */
    getMode?: () => string;
    /** Switch app tab/mode — 'support' triggers the reactive island scan. */
    setMode?: (mode: string) => void;
    /** Whether an island scan is currently running. */
    isScanning?: () => boolean;
    /** Count of islands the UI considers unsupported (strict on-island check). */
    getUnsupportedIslandCount?: () => number;
    /** Compute + apply an optimized build orientation; returns the chosen result. */
    autoOrient?: (opts?: { overhangAngleDeg?: number; heightWeight?: number; candidateCount?: number }) => unknown;
    /** Run the auto-arrange packer on all visible models (debug/testing). */
    arrange?: (opts?: { mode?: 'standard' | 'high_precision' }) => Promise<unknown> | unknown;
    /** List every model's id/name/position(mm)/rotation(deg)/footprint (debug/testing). */
    listModels?: () => unknown;
    /** Remove all models from the scene (for scripted multi-model testing). */
    clearModels?: () => Promise<void>;
    /** Make a model the single selected + active one (so transform/support commands target it). */
    selectModel?: (modelId: string) => boolean;
    /** Trigger a fresh island scan; resolves when done. */
    scanIslands?: () => Promise<void>;
    /** Remove all existing supports (reset). */
    /** Remove supports from the active model, or from every model with scope 'all'. */
    clearSupports?: (opts?: { scope?: 'active' | 'all' }) => void;
    /** Export the current plate to a file path; resolves with the written path. */
    exportFile?: (path?: string) => Promise<string>;
    /** Load a mesh (STL/OBJ/3MF) from an absolute file path. */
    loadModel?: (path: string) => Promise<void>;
    /** Model placement controls. */
    transform?: ModelTransformOps;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

type Command =
    | { id: number; cmd: 'ping' }
    | { id: number; cmd: 'getState' }
    | { id: number; cmd: 'getMode' }
    | { id: number; cmd: 'setMode'; args: { mode: string } }
    | { id: number; cmd: 'autoOrient'; args?: { overhangAngleDeg?: number; heightWeight?: number; candidateCount?: number } }
    | { id: number; cmd: 'arrange'; args?: { mode?: 'standard' | 'high_precision' } }
    | { id: number; cmd: 'clearModels' }
    | { id: number; cmd: 'selectModel'; args: { modelId: string } }
    | { id: number; cmd: 'scanIslands' }
    | { id: number; cmd: 'clearSupports'; args?: { scope?: 'active' | 'all' } }
    | { id: number; cmd: 'generateSupports'; args?: { settings?: Partial<AutoSupportSettings> } }
    | { id: number; cmd: 'loadModel'; args: { path: string } }
    | { id: number; cmd: 'export'; args?: { path?: string } }
    | { id: number; cmd: 'getTransform' }
    | { id: number; cmd: 'setRotation'; args: { xDeg?: number; yDeg?: number; zDeg?: number } }
    | { id: number; cmd: 'setPosition'; args: { x?: number; y?: number; z?: number } }
    | { id: number; cmd: 'setScale'; args: { scale?: number; x?: number; y?: number; z?: number } }
    | { id: number; cmd: 'centerXY' }
    | { id: number; cmd: 'elevate'; args: { mm: number } }
    | { id: number; cmd: 'resetTransform' }
    | { id: number; cmd: 'screenshot' }
    | { id: number; cmd: 'setView'; args: { preset: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso' } & ViewFocus }
    | { id: number; cmd: 'fitView'; args?: ViewFocus }
    | { id: number; cmd: 'auditSupports'; args?: { maxOffenders?: number } }
    | { id: number; cmd: 'getProfiles' }
    | { id: number; cmd: 'selectPrinterProfile'; args: { id: string } }
    | { id: number; cmd: 'selectMaterialProfile'; args: { id: string } }
    | { id: number; cmd: 'duplicateMaterialProfile'; args?: { id?: string; name?: string } }
    | { id: number; cmd: 'updateMaterialProfile'; args: { id?: string; base?: Record<string, unknown>; output?: Record<string, string | number | boolean>; antiAliasing?: Record<string, unknown> } }
    | { id: number; cmd: 'listModels' }
    | { id: number; cmd: 'getControlsState' };

/** Optional camera focus: frame one model, or a point with a radius (mm), instead of the whole plate. */
type ViewFocus = { modelId?: string; center?: { x: number; y: number; z: number }; radiusMm?: number };

const DEFAULT_URL = 'ws://127.0.0.1:8791';
const RECONNECT_MS = 2000;

/** Only ever dial a loopback MCP server (an override pointing elsewhere is ignored). */
function resolveBridgeUrl(): string {
    const override = process.env.NEXT_PUBLIC_DF_AUTOMATION_URL;
    if (!override) return DEFAULT_URL;
    try {
        const u = new URL(override);
        const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
        return (u.protocol === 'ws:' || u.protocol === 'wss:') && loopback ? override : DEFAULT_URL;
    } catch {
        return DEFAULT_URL;
    }
}

function randomHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

const signWithLaunchToken = (message: string) => invoke<string>('automation_sign', { message });

function countSupports(): number {
    const s = getSnapshot();
    return (
        Object.keys(s.trunks).length +
        Object.keys(s.branches).length +
        Object.keys(s.leaves).length +
        Object.keys(s.anchors).length +
        Object.keys(s.sticks ?? {}).length
    );
}

export function useAutomationBridge(handlers: AutomationBridgeHandlers): void {
    // Keep the latest handlers without re-opening the socket every render.
    // Updated in an effect (not during render, which react-hooks/refs forbids);
    // WS messages are async so the ref is always current by the time one lands.
    const ref = useRef(handlers);
    useEffect(() => {
        ref.current = handlers;
    });

    const assistantEnabled = useSyncExternalStore(
        subscribeToAssistantSettings,
        () => getSavedAssistantSettings().enabled,
        () => false,
    );

    useEffect(() => {
        const compiledIn =
            process.env.NEXT_PUBLIC_DF_AUTOMATION === '1' ||
            process.env.NODE_ENV !== 'production';
        // The handshake needs Rust to sign with the launch token, so the bridge
        // only runs inside the Tauri app (not a plain browser tab).
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        if (!compiledIn || !assistantEnabled || !inTauri) {
            setAssistantBridgeStatus('disabled');
            return;
        }
        setAssistantBridgeStatus('waiting');

        const url = resolveBridgeUrl();
        let ws: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let closed = false;

        const send = (msg: unknown) => {
            try {
                ws?.send(JSON.stringify(msg));
            } catch {
                /* socket not ready */
            }
        };

        const handle = async (cmd: Command): Promise<unknown> => {
            const h = ref.current;
            switch (cmd.cmd) {
                case 'ping':
                    return { pong: true, ts: Date.now() };

                case 'getState': {
                    const islands = h.getIslands();
                    return {
                        activeModelId: h.getActiveModelId(),
                        islandCount: islands.length,
                        supportCount: countSupports(),
                        mode: h.getMode?.() ?? null,
                        scanning: h.isScanning?.() ?? false,
                        unsupportedIslands: h.getUnsupportedIslandCount?.() ?? null,
                    };
                }

                case 'getMode':
                    return { mode: h.getMode?.() ?? null, scanning: h.isScanning?.() ?? false, islandCount: h.getIslands().length };

                case 'setMode': {
                    if (!h.setMode) throw new Error('setMode not wired');
                    h.setMode(cmd.args.mode);
                    return { mode: cmd.args.mode };
                }

                case 'autoOrient': {
                    if (!h.autoOrient) throw new Error('autoOrient not wired');
                    return h.autoOrient(cmd.args);
                }

                case 'arrange': {
                    if (!h.arrange) throw new Error('arrange not wired');
                    return await h.arrange(cmd.args);
                }

                case 'listModels': {
                    if (!h.listModels) throw new Error('listModels not wired');
                    return h.listModels();
                }

                case 'clearModels': {
                    if (!h.clearModels) throw new Error('clearModels not wired');
                    await h.clearModels();
                    return { cleared: true };
                }

                case 'selectModel': {
                    if (!h.selectModel) throw new Error('selectModel not wired');
                    if (!h.selectModel(cmd.args.modelId)) throw new Error(`no model with id ${cmd.args.modelId}`);
                    return { selected: cmd.args.modelId };
                }

                case 'scanIslands': {
                    if (!h.scanIslands) throw new Error('scanIslands not wired');
                    await h.scanIslands();
                    return { islandCount: h.getIslands().length };
                }

                case 'clearSupports': {
                    if (!h.clearSupports) throw new Error('clearSupports not wired');
                    h.clearSupports({ scope: cmd.args?.scope });
                    return { supportCount: countSupports() };
                }

                case 'generateSupports': {
                    // Generation is validated in the Support tab; make sure we are
                    // there (and give React a beat to settle) before placing.
                    if (h.getMode?.() !== 'support' && h.setMode) {
                        h.setMode('support');
                        await new Promise((r) => setTimeout(r, 400));
                    }
                    const modelId = h.getActiveModelId();
                    if (!modelId) throw new Error('no active model');
                    const islands = h.getIslands();
                    const base = getSettings().autoSupport;
                    const settings: AutoSupportSettings = { ...base, ...(cmd.args?.settings ?? {}) };
                    // Dynamic import on every call: this socket effect is mounted once, so
                    // a static import would pin the module version from app start and
                    // hot-reloaded edits to the auto-support logic would never run.
                    const { runAutoPlace } = await import('@/supports/autoSupport');
                    const result = runAutoPlace(islands, modelId, settings);
                    return {
                        placedTrunks: result.placedTrunks,
                        placedBranches: result.placedBranches,
                        placedLeaves: result.placedLeaves,
                        placedAnchors: result.placedAnchors,
                        placedSticks: result.placedSticks,
                        rejected: result.rejectedCandidates,
                        message: result.message,
                        analytics: result.analytics,
                        supportCount: countSupports(),
                    };
                }

                case 'loadModel': {
                    if (!h.loadModel) throw new Error('loadModel not wired');
                    await h.loadModel(cmd.args.path);
                    return { loaded: cmd.args.path, activeModelId: h.getActiveModelId() };
                }

                case 'export': {
                    if (!h.exportFile) throw new Error('exportFile not wired');
                    const path = await h.exportFile(cmd.args?.path);
                    return { path };
                }

                case 'getTransform': {
                    if (!h.transform) throw new Error('transform not wired');
                    const t = h.transform.get();
                    if (!t) return null;
                    return {
                        position: t.position,
                        rotationDeg: { x: t.rotationRad.x * RAD2DEG, y: t.rotationRad.y * RAD2DEG, z: t.rotationRad.z * RAD2DEG },
                        scale: t.scale,
                    };
                }

                case 'setRotation': {
                    if (!h.transform) throw new Error('transform not wired');
                    const cur = h.transform.get();
                    const rx = cmd.args.xDeg !== undefined ? cmd.args.xDeg * DEG2RAD : cur?.rotationRad.x ?? 0;
                    const ry = cmd.args.yDeg !== undefined ? cmd.args.yDeg * DEG2RAD : cur?.rotationRad.y ?? 0;
                    const rz = cmd.args.zDeg !== undefined ? cmd.args.zDeg * DEG2RAD : cur?.rotationRad.z ?? 0;
                    h.transform.setRotationRad(rx, ry, rz);
                    return { rotationDeg: { x: rx * RAD2DEG, y: ry * RAD2DEG, z: rz * RAD2DEG } };
                }

                case 'setPosition': {
                    if (!h.transform) throw new Error('transform not wired');
                    const cur = h.transform.get();
                    const x = cmd.args.x ?? cur?.position.x ?? 0;
                    const y = cmd.args.y ?? cur?.position.y ?? 0;
                    const z = cmd.args.z ?? cur?.position.z ?? 0;
                    h.transform.setPosition(x, y, z);
                    return { position: { x, y, z } };
                }

                case 'setScale': {
                    if (!h.transform) throw new Error('transform not wired');
                    const s = cmd.args.scale;
                    const cur = h.transform.get();
                    const x = s ?? cmd.args.x ?? cur?.scale.x ?? 1;
                    const y = s ?? cmd.args.y ?? cur?.scale.y ?? 1;
                    const z = s ?? cmd.args.z ?? cur?.scale.z ?? 1;
                    h.transform.setScale(x, y, z);
                    return { scale: { x, y, z } };
                }

                case 'centerXY': {
                    if (!h.transform) throw new Error('transform not wired');
                    h.transform.centerXY();
                    return { ok: true };
                }

                case 'elevate': {
                    if (!h.transform) throw new Error('transform not wired');
                    h.transform.elevate(cmd.args.mm);
                    return { elevatedToMm: cmd.args.mm };
                }

                case 'resetTransform': {
                    if (!h.transform) throw new Error('transform not wired');
                    h.transform.reset();
                    return { ok: true };
                }

                case 'screenshot': {
                    const dataUrl = window.__dfAutomation?.captureViewport();
                    if (!dataUrl) throw new Error('viewport capture unavailable (scene not ready?)');
                    return { pngBase64: dataUrl.replace(/^data:image\/png;base64,/, '') };
                }

                case 'setView': {
                    if (!window.__dfAutomation) throw new Error('scene camera not ready');
                    const { preset, ...focus } = cmd.args;
                    window.__dfAutomation.setView(preset, focus);
                    return { view: preset, ...focus };
                }

                case 'fitView': {
                    if (!window.__dfAutomation) throw new Error('scene camera not ready');
                    window.__dfAutomation.fit(cmd.args);
                    return { ok: true };
                }

                case 'getProfiles':
                    return (await import('@/automation/profileControl')).describeProfiles();

                case 'selectPrinterProfile':
                    return (await import('@/automation/profileControl')).selectPrinterProfile(cmd.args.id);

                case 'selectMaterialProfile':
                    return (await import('@/automation/profileControl')).selectMaterialProfile(cmd.args.id);

                case 'duplicateMaterialProfile':
                    return (await import('@/automation/profileControl')).duplicateMaterialProfile(cmd.args?.id, cmd.args?.name);

                case 'updateMaterialProfile': {
                    const { updateMaterialProfileSettings } = await import('@/automation/profileControl');
                    const { id, ...patch } = cmd.args;
                    return updateMaterialProfileSettings(id, patch as Parameters<typeof updateMaterialProfileSettings>[1]);
                }

                case 'auditSupports': {
                    const { auditSupports } = await import('@/supports/autoSupport/supportGeometry');
                    return auditSupports(cmd.args?.maxOffenders ?? 200);
                }

                case 'getControlsState': {
                    if (!window.__dfAutomation?.getControlsState) throw new Error('scene camera not ready');
                    return window.__dfAutomation.getControlsState();
                }

                default:
                    throw new Error(`unknown cmd: ${(cmd as { cmd: string }).cmd}`);
            }
        };

        const connect = () => {
            if (closed) return;
            let sock: WebSocket;
            try {
                sock = new WebSocket(url);
            } catch {
                reconnectTimer = setTimeout(connect, RECONNECT_MS);
                return;
            }
            ws = sock;
            // Per-connection handshake state: nothing is executed until the
            // server has proven it holds this launch's token.
            let authed = false;
            let authFailed = false;
            let clientNonce = '';
            const rejectPeer = () => {
                authFailed = true;
                setAssistantBridgeStatus('auth-failed');
                try { sock.close(); } catch { /* ignore */ }
            };

            sock.onmessage = async (ev) => {
                let msg: Record<string, unknown> | null;
                try {
                    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
                } catch {
                    return;
                }
                if (!msg || typeof msg !== 'object') return;

                if (!authed) {
                    try {
                        if (msg.type === 'auth-challenge' && typeof msg.nonce === 'string' && !clientNonce) {
                            clientNonce = randomHex(32);
                            const proof = await signWithLaunchToken(`app:${msg.nonce}`);
                            sock.send(JSON.stringify({ type: 'auth-response', proof, nonce: clientNonce }));
                            return;
                        }
                        if (msg.type === 'auth-ok' && clientNonce && typeof msg.proof === 'string') {
                            const expected = await signWithLaunchToken(`server:${clientNonce}`);
                            if (msg.proof === expected) {
                                authed = true;
                                setAssistantBridgeStatus('connected');
                                return;
                            }
                        }
                    } catch {
                        // signing unavailable — treat as a failed handshake
                    }
                    // Anything else before a verified handshake (including a
                    // command) means an unauthenticated peer: drop it.
                    rejectPeer();
                    return;
                }

                const cmd = msg as unknown as Command;
                if (typeof cmd?.id !== 'number' || typeof cmd?.cmd !== 'string') return;
                try {
                    const result = await handle(cmd);
                    send({ id: cmd.id, ok: true, result });
                } catch (e) {
                    send({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            };
            sock.onclose = () => {
                if (ws === sock) ws = null;
                if (!authFailed) setAssistantBridgeStatus('waiting');
                if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
            };
            sock.onerror = () => {
                try { sock.close(); } catch { /* ignore */ }
            };
        };

        connect();

        return () => {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            try { ws?.close(); } catch { /* ignore */ }
            setAssistantBridgeStatus('disabled');
        };
    }, [assistantEnabled]);
}
