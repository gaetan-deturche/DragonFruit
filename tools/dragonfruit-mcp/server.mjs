#!/usr/bin/env node
/**
 * DragonFruit MCP server.
 *
 * Bridges an MCP client (stdio — Claude Desktop, Claude Code…) to a running
 * DragonFruit app. DragonFruit's in-app automation bridge
 * (src/automation/useAutomationBridge.ts) connects OUT to the WebSocket server
 * we host here; MCP tool calls are relayed to it and the reply is returned.
 *
 * Why a WebSocket the app dials into (rather than us calling the app): the
 * scene logic lives in the webview's React state, so commands must execute
 * inside the app. The app is the WS client, we are the server.
 *
 * Security:
 * - Loopback only (127.0.0.1 / ::1 / localhost); anything else is refused.
 * - Browser Origins other than the app's own are rejected (a web page could
 *   otherwise open a socket to us).
 * - Mutual HMAC-SHA256 challenge/response with the per-launch token the app
 *   writes to <app data dir>/automation-token (see src-tauri/src/automation.rs).
 *   The token never crosses the socket; a peer that can't read the user's
 *   profile can neither command the app nor pose as it.
 *
 * Shipped inside the installer as dragonfruit-mcp.cjs (single-file bundle,
 * needs Node.js 18+). Settings > AI Assistant shows the client config.
 */
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_ID = 'org.openresinalliance.dragonfruit';
const WS_HOST = process.env.DF_MCP_WS_HOST || '127.0.0.1';
const WS_PORT = Number(process.env.DF_MCP_WS_PORT || 8791);
const CALL_TIMEOUT_MS = Number(process.env.DF_MCP_TIMEOUT_MS || 20000);
const AUTH_TIMEOUT_MS = 10000;

const log = (msg) => process.stderr.write(`[dragonfruit-mcp] ${msg}\n`);

if (!['127.0.0.1', '::1', 'localhost'].includes(WS_HOST)) {
    log(`refusing to listen on non-loopback host "${WS_HOST}"`);
    process.exit(1);
}

// Tauri's app_data_dir() for the app identifier, per platform.
function defaultTokenFile() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_ID, 'automation-token');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', APP_ID, 'automation-token');
    }
    return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_ID, 'automation-token');
}
const TOKEN_FILE = process.env.DF_MCP_TOKEN_FILE || defaultTokenFile();

const hmac = (key, message) => crypto.createHmac('sha256', key).update(message).digest('hex');
function safeEqualHex(a, b) {
    const ab = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// The app's own webview origins (prod: tauri.localhost / tauri://localhost;
// dev: http://localhost:3006). Non-browser clients send no Origin.
function isAllowedOrigin(origin) {
    if (!origin) return true;
    return /^(https?:\/\/(tauri\.)?localhost(:\d+)?|tauri:\/\/localhost|https?:\/\/127\.0\.0\.1(:\d+)?)$/i.test(origin);
}

// ── WebSocket side: DragonFruit connects to us ──────────────────────────────
let bridge = null;
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({
    host: WS_HOST,
    port: WS_PORT,
    verifyClient: ({ origin }) => isAllowedOrigin(origin),
});

wss.on('connection', (sock) => {
    let token;
    try {
        token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch {
        log(`token file not found (${TOKEN_FILE}) — is DragonFruit running?`);
        sock.close(4002, 'token unavailable');
        return;
    }

    let authed = false;
    const serverNonce = crypto.randomBytes(32).toString('hex');
    const authTimer = setTimeout(() => {
        if (!authed) sock.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    sock.send(JSON.stringify({ type: 'auth-challenge', nonce: serverNonce, protocol: 1 }));

    sock.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (!authed) {
            const valid = msg
                && msg.type === 'auth-response'
                && typeof msg.nonce === 'string' && msg.nonce.length >= 32
                && safeEqualHex(msg.proof, hmac(token, `app:${serverNonce}`));
            if (!valid) {
                log('rejected a connection that failed authentication');
                sock.close(4001, 'auth failed');
                return;
            }
            authed = true;
            clearTimeout(authTimer);
            sock.send(JSON.stringify({ type: 'auth-ok', proof: hmac(token, `server:${msg.nonce}`) }));
            if (bridge && bridge !== sock) {
                try { bridge.close(4000, 'replaced'); } catch { /* ignore */ }
            }
            bridge = sock;
            log('app connected (authenticated)');
            return;
        }

        if (typeof msg.id === 'number' && pending.has(msg.id)) {
            const { settle } = pending.get(msg.id);
            pending.delete(msg.id);
            settle(msg);
        }
    });
    sock.on('close', () => {
        clearTimeout(authTimer);
        if (bridge === sock) {
            bridge = null;
            log('app disconnected');
        }
    });
    sock.on('error', () => {});
});
wss.on('error', (e) => log(`ws error: ${e.message}`));

/** Commands that legitimately run for minutes on big plates (support generation, slicing). */
const LONG_CALL_TIMEOUT_MS = Number(process.env.DF_MCP_LONG_TIMEOUT_MS || 15 * 60 * 1000);

function call(cmd, args, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        if (!bridge || bridge.readyState !== bridge.OPEN) {
            return reject(new Error('DragonFruit is not connected. Open DragonFruit and check that Settings > AI Assistant is ON; the app reconnects automatically.'));
        }
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timed out waiting for DragonFruit (${cmd}, ${Math.round(timeoutMs / 1000)}s). It may still be running — check df_get_state.`));
        }, timeoutMs);
        pending.set(id, {
            settle: (m) => {
                clearTimeout(timer);
                if (m.ok) resolve(m.result);
                else reject(new Error(m.error || 'command failed'));
            },
        });
        bridge.send(JSON.stringify({ id, cmd, args }));
    });
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

// ── MCP side ────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'dragonfruit', version: '0.2.0' });

server.tool('df_get_state', 'Get DragonFruit state: active model id, island count, support count.',
    {}, async () => ok(await call('getState')));

server.tool('df_ping', 'Check the DragonFruit automation bridge is connected.',
    {}, async () => ok(await call('ping')));

server.tool('df_scan_islands', 'Run a fresh island scan on the active model. Returns the new island count.',
    {}, async () => ok(await call('scanIslands', undefined, LONG_CALL_TIMEOUT_MS)));

server.tool('df_clear_supports',
    'Remove the supports of the active model only (other models keep theirs). Pass scope "all" to clear the whole plate. Returns the plate-wide support count left.',
    { scope: z.enum(['active', 'all']).optional().describe('"active" (default) = active model only; "all" = every model on the plate.') },
    async ({ scope }) => ok(await call('clearSupports', { scope })));

server.tool('df_generate_supports',
    'Run auto-support on the active model and return placement analytics (trunks, coverage, rejections). Optionally override auto-support settings for this run.',
    {
        settings: z.record(z.any()).optional()
            .describe('Partial AutoSupportSettings overrides, e.g. { overhangSpacingMm: 3, overhangAngleThresholdDeg: 50 }'),
        verbose: z.boolean().optional().describe('Return the full per-candidate debug lists (can exceed 100k chars on big models).'),
    },
    async ({ settings, verbose }) => ok(summarizeGenerate(await call('generateSupports', { settings }, LONG_CALL_TIMEOUT_MS), verbose)));

/** Keep the analytics readable: full debug lists only on request. */
function summarizeGenerate(res, verbose) {
    if (verbose || !res?.analytics?.debug) return res;
    const { rejects = [], uncovered = [] } = res.analytics.debug;
    const errCounts = {};
    for (const r of rejects) errCounts[r.err] = (errCounts[r.err] ?? 0) + 1;
    const bigUncovered = [...uncovered].filter((u) => u.area >= 0.5).sort((a, b) => b.area - a.area);
    return {
        ...res,
        analytics: {
            ...res.analytics,
            debug: {
                rejectErrors: errCounts,
                uncoveredCount: uncovered.length,
                uncoveredZeroArea: uncovered.filter((u) => !u.area).length,
                uncoveredTotalAreaMm2: Math.round(uncovered.reduce((s, u) => s + (u.area ?? 0), 0) * 10) / 10,
                largestUncovered: bigUncovered.slice(0, 15),
            },
        },
    };
}

server.tool('df_load_model',
    'Load a mesh (STL/OBJ/3MF) from an absolute file path onto the plate. Must be in Prepare mode.',
    { path: z.string().describe('Absolute path to the mesh file.') },
    async ({ path: p }) => ok(await call('loadModel', { path: p }, LONG_CALL_TIMEOUT_MS)));

server.tool('df_export',
    'Slice the visible models with the current Export-tab printer + material profile and write the sliced file (e.g. .pmx2) to an absolute path, without any dialog. Resolves once the file is written (can take minutes).',
    { path: z.string().optional().describe('Absolute output file path.') },
    async ({ path: p }) => ok(await call('export', { path: p }, LONG_CALL_TIMEOUT_MS)));

// ── Model placement ─────────────────────────────────────────────────────────
server.tool('df_get_transform', 'Get the active model transform: position (mm), rotation (degrees), scale.',
    {}, async () => ok(await call('getTransform')));

server.tool('df_set_rotation',
    'Set the active model rotation in DEGREES (each axis optional; omitted axes keep their current value).',
    {
        xDeg: z.number().optional(),
        yDeg: z.number().optional(),
        zDeg: z.number().optional(),
    },
    async (args) => ok(await call('setRotation', args)));

server.tool('df_set_position',
    'Set the active model position in mm (each axis optional; omitted axes keep their current value).',
    { x: z.number().optional(), y: z.number().optional(), z: z.number().optional() },
    async (args) => ok(await call('setPosition', args)));

server.tool('df_set_scale',
    'Set the active model scale. Pass `scale` for uniform scaling, or x/y/z individually.',
    { scale: z.number().optional(), x: z.number().optional(), y: z.number().optional(), z: z.number().optional() },
    async (args) => ok(await call('setScale', args)));

server.tool('df_center_xy', 'Centre the active model on the plate in XY.',
    {}, async () => ok(await call('centerXY')));

server.tool('df_elevate',
    'Lift the active model so its lowest point sits `mm` above the plate (for support clearance).',
    { mm: z.number().describe('Height of the lowest point above the plate, in mm.') },
    async ({ mm }) => ok(await call('elevate', { mm })));

server.tool('df_reset_transform', 'Reset the active model position and rotation to defaults.',
    {}, async () => ok(await call('resetTransform')));

server.tool('df_clear_models', 'Remove ALL models from the plate (fresh scene).',
    {}, async () => ok(await call('clearModels')));

server.tool('df_preview_update_dialog',
    'Show the in-app update dialog for a FAKE update (v9.9.9) to check its UI — nothing is downloaded or installed. Without pct: the "update available" dialog (its Download button then simulates a slow ~15 s download). With pct: the downloading state frozen at that percentage.',
    { pct: z.number().min(0).max(100).optional() },
    async ({ pct }) => ok(await call('previewUpdate', { pct })));

server.tool('df_select_model',
    'Make a model (by id from df_list_models) the active/selected one, so transform, elevate and support tools target it.',
    { modelId: z.string() },
    async ({ modelId }) => ok(await call('selectModel', { modelId })));

server.tool('df_set_mode',
    'Switch the app tab/mode directly (bypasses UI gating): prepare | support | export | printing.',
    { mode: z.enum(['prepare', 'support', 'export', 'printing']) },
    async ({ mode }) => ok(await call('setMode', { mode })));

server.tool('df_auto_orient',
    'Auto-orient EACH visible model independently to its optimal build orientation (minimizes supports / build height / cupping). Keeps XY placement; only nudges models apart if they overlap. Returns the per-model orientation results.',
    {
        overhangAngleDeg: z.number().optional().describe('Down-faces steeper than this (deg from horizontal) need support.'),
        heightWeight: z.number().optional().describe('Weight of build height vs supported area in the cost.'),
        candidateCount: z.number().optional().describe('Number of Fibonacci-sphere candidate orientations.'),
    },
    async (args) => ok(await call('autoOrient', args)));

server.tool('df_arrange',
    'Run the auto-arrange packer on ALL visible models (the "Arrange All" button). mode: standard (default) or high_precision.',
    { mode: z.enum(['standard', 'high_precision']).optional() },
    async (args) => ok(await call('arrange', args)));

server.tool('df_list_models',
    'List every visible model: id, name, position (mm), rotation (deg), and XY footprint (w/d + origin→footprint offset).',
    {}, async () => ok(await call('listModels')));

// ── Visual inspection ───────────────────────────────────────────────────────
server.tool('df_screenshot', 'Capture the current 3D viewport (model + supports on the plate) and return it as an image.',
    {}, async () => {
        const r = await call('screenshot');
        return { content: [{ type: 'image', data: r.pngBase64, mimeType: 'image/png' }] };
    });

const focusSchema = {
    modelId: z.string().optional().describe('Frame only this model (id from df_list_models) instead of the whole plate.'),
    center: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
        .describe('Frame a point in plate coordinates (mm), e.g. an island or support tip, for close inspection.'),
    radiusMm: z.number().optional().describe('Half-size of the framed region in mm (with center, default 5; with modelId, overrides the model size).'),
};

server.tool('df_camera_view',
    'Point the camera at a preset view and frame the whole plate — or, with modelId / center+radiusMm, zoom on one model or region. Use before df_screenshot.',
    { preset: z.enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso']).describe('Camera view preset.'), ...focusSchema },
    async (args) => ok(await call('setView', args)));

server.tool('df_fit_view', 'Reframe the camera (keeps the current angle) on the whole plate, or on one model / region with modelId or center+radiusMm.',
    focusSchema, async (args) => ok(await call('fitView', args)));

// ── Print profile (what df_export slices with) ──────────────────────────────
server.tool('df_get_profiles',
    'List printer and material profiles and show the active material in full: generic fields (exposure, layer height, lift…), anti-aliasing, and the output-format settings that actually reach the sliced file (e.g. Anycubic .pmx2: normalExposureSec, waitTimeBeforeCureSec, bottomExposureSec, transitionLayerCount…), each with its schema (min/max) and whether it is still at its default.',
    {}, async () => ok(await call('getProfiles')));

server.tool('df_select_printer_profile', 'Make a printer profile (id from df_get_profiles) the active one.',
    { id: z.string() }, async ({ id }) => ok(await call('selectPrinterProfile', { id })));

server.tool('df_select_material_profile', 'Make a material profile (id from df_get_profiles) the active one for slicing.',
    { id: z.string() }, async ({ id }) => ok(await call('selectMaterialProfile', { id })));

server.tool('df_duplicate_material',
    'Copy a material profile (default: the active one) into an editable custom profile and make it active. Official profiles are read-only, so duplicate before editing.',
    { id: z.string().optional(), name: z.string().optional().describe('Name of the copy.') },
    async ({ id, name }) => ok(await call('duplicateMaterialProfile', { id, name })));

server.tool('df_update_material',
    'Edit a custom material profile (default: the active one). base = generic fields {name, layerHeightMm, normalExposureSec, bottomExposureSec, bottomLayerCount, liftDistanceMm, liftSpeedMmMin, retractSpeedMmMin, minimumAaAlphaPercent}; output = output-format settings by key as listed by df_get_profiles (these override base for formats like .pmx2); antiAliasing = {mode: "Off"|"Blur"|"3DAA", level: "4x", blurBrushRadiusPx, ...}. Returns the updated profile.',
    {
        id: z.string().optional(),
        base: z.record(z.any()).optional(),
        output: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
        antiAliasing: z.record(z.any()).optional(),
    },
    async (args) => ok(await call('updateMaterialProfile', args)));

server.tool('df_audit_supports',
    'Audit every support on the plate: counts per model of supports running through their own model, through ANOTHER model, touching an up-facing (top/detail) surface, or hanging off the trunk of another model. Returns totals, perModel and a list of offenders (with tip positions to frame with df_camera_view center).',
    { maxOffenders: z.number().optional().describe('Max offenders listed (default 200).') },
    async ({ maxOffenders }) => ok(await call('auditSupports', { maxOffenders }, LONG_CALL_TIMEOUT_MS)));

// No top-level await: this file is bundled to CommonJS for the installer.
server.connect(new StdioServerTransport()).then(
    () => log(`MCP ready; WS listening on ws://${WS_HOST}:${WS_PORT} (token: ${TOKEN_FILE})`),
    (e) => { log(`MCP transport failed: ${e?.message ?? e}`); process.exit(1); },
);
