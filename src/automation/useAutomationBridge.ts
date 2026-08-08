import { useEffect, useRef } from 'react';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { getSettings } from '@/supports/Settings/state';
import { getSnapshot } from '@/supports/state';
import { runAutoPlace } from '@/supports/autoSupport';
import type { AutoSupportSettings } from '@/supports/autoSupport/settings';

/**
 * Automation bridge — lets an external MCP server drive DragonFruit for
 * scripted testing (mainly: iterate on auto-support and read back analytics
 * without a human clicking "Generate").
 *
 * It runs INSIDE the webview (as a hook mounted near the scene root) so it can
 * touch live React scene state — the model id, the scanned islands — that a
 * headless process cannot reach. It opens a WebSocket to the MCP server and
 * answers JSON commands.
 *
 * Protocol: the server sends `{ id, cmd, args? }`; the bridge replies
 * `{ id, ok, result? , error? }`. Only enabled when NEXT_PUBLIC_DF_AUTOMATION
 * is set (or always in dev), so production builds don't open a socket.
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
    /** Trigger a fresh island scan; resolves when done. */
    scanIslands?: () => Promise<void>;
    /** Remove all existing supports (reset). */
    clearSupports?: () => void;
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
    | { id: number; cmd: 'scanIslands' }
    | { id: number; cmd: 'clearSupports' }
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
    | { id: number; cmd: 'setView'; args: { preset: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso' } }
    | { id: number; cmd: 'fitView' };

const DEFAULT_URL = 'ws://127.0.0.1:8791';
const RECONNECT_MS = 2000;

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
    const ref = useRef(handlers);
    ref.current = handlers;

    useEffect(() => {
        const enabled =
            process.env.NEXT_PUBLIC_DF_AUTOMATION === '1' ||
            process.env.NODE_ENV !== 'production';
        if (!enabled || typeof window === 'undefined') return;

        const url = process.env.NEXT_PUBLIC_DF_AUTOMATION_URL || DEFAULT_URL;
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
                    };
                }

                case 'scanIslands': {
                    if (!h.scanIslands) throw new Error('scanIslands not wired');
                    await h.scanIslands();
                    return { islandCount: h.getIslands().length };
                }

                case 'clearSupports': {
                    if (!h.clearSupports) throw new Error('clearSupports not wired');
                    h.clearSupports();
                    return { supportCount: countSupports() };
                }

                case 'generateSupports': {
                    const modelId = h.getActiveModelId();
                    if (!modelId) throw new Error('no active model');
                    const islands = h.getIslands();
                    const base = getSettings().autoSupport;
                    const settings: AutoSupportSettings = { ...base, ...(cmd.args?.settings ?? {}) };
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
                    window.__dfAutomation.setView(cmd.args.preset);
                    return { view: cmd.args.preset };
                }

                case 'fitView': {
                    if (!window.__dfAutomation) throw new Error('scene camera not ready');
                    window.__dfAutomation.fit();
                    return { ok: true };
                }

                default:
                    throw new Error(`unknown cmd: ${(cmd as { cmd: string }).cmd}`);
            }
        };

        const connect = () => {
            if (closed) return;
            try {
                ws = new WebSocket(url);
            } catch {
                reconnectTimer = setTimeout(connect, RECONNECT_MS);
                return;
            }
            ws.onopen = () => {
                send({ event: 'hello', app: 'dragonfruit', ts: Date.now() });
            };
            ws.onmessage = async (ev) => {
                let cmd: Command;
                try {
                    cmd = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
                } catch {
                    return;
                }
                if (typeof cmd?.id !== 'number' || typeof cmd?.cmd !== 'string') return;
                try {
                    const result = await handle(cmd);
                    send({ id: cmd.id, ok: true, result });
                } catch (e) {
                    send({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) });
                }
            };
            ws.onclose = () => {
                if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
            };
            ws.onerror = () => {
                try { ws?.close(); } catch { /* ignore */ }
            };
        };

        connect();

        return () => {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            try { ws?.close(); } catch { /* ignore */ }
        };
    }, []);
}
