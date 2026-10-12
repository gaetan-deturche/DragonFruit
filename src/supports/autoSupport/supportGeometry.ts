import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SmartPlacementV2';
import { getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import { getKickstandSnapshot } from '../SupportTypes/Kickstand/kickstandStore';
import type * as THREE from 'three';
import type { Vec3 } from '../types';
import { seatingRing, SEAT_MIN_HITS } from './contactSeating';
import { clampConeAxis } from './attachmentLimits';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { getSnapshot } from '../state';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { getAllModelIds, getModelMesh } from './meshStore';

/**
 * Support geometry as capsules (segment + radius) for collision testing.
 *
 * The placement pipeline only ever collision-tests a support against the model
 * it belongs to, so on a crowded plate supports happily run through NEIGHBOURING
 * models. These helpers flatten any support entity into capsules so a candidate
 * can be tested against every other model before it is committed, and so the
 * whole plate can be audited after generation.
 *
 * `part` distinguishes the shaft body (must never touch ANY model, own included)
 * from the contact cone (must touch its own model at the tip — so for the own
 * model only the part short of the tip is tested).
 */
export interface SupportCapsule {
    a: Vec3;
    b: Vec3;
    r: number;
    part: 'shaft' | 'cone';
}

/** Cone length kept clear of the own model, measured back from the contact tip. */
const OWN_CONE_TIP_ALLOWANCE_MM = 1.2;
/** Shrinks shaft radii slightly so grazing contacts are not flagged as hits. */
const RADIUS_TOLERANCE = 0.85;

function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function len(v: Vec3): number { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Socket end of a contact cone (the end away from the model). Despite the type's
 * comment, `cone.normal` is the cone AXIS from the tip toward the socket — i.e.
 * pointing OUT of the model (trunkBuilder: axis = socket − coneStart).
 */
export function coneSocket(cone: ContactCone): Vec3 {
    const n = cone.normal;
    const l = cone.profile?.lengthMm ?? 3;
    return { x: cone.pos.x + n.x * l, y: cone.pos.y + n.y * l, z: cone.pos.z + n.z * l };
}

function coneCapsule(cone: ContactCone, from?: Vec3): SupportCapsule {
    const r = ((cone.profile?.contactDiameterMm ?? 0.4) / 2) * RADIUS_TOLERANCE;
    return { a: from ?? coneSocket(cone), b: cone.pos, r, part: 'cone' };
}

/** Sub-capsules per curved (Bezier) segment: the chord alone misses the bulge. */
const BEZIER_SUBDIVISIONS = 8;

function cubic(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return {
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
        z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
    };
}

function segmentCapsules(
    segments: Array<{
        diameter?: number;
        type?: string;
        controlPoint1?: Vec3;
        controlPoint2?: Vec3;
        bottomJoint?: { pos: Vec3 } | null;
        topJoint?: { pos: Vec3 } | null;
    }>,
    firstStart?: Vec3,
): SupportCapsule[] {
    const out: SupportCapsule[] = [];
    let prevTop: Vec3 | undefined = firstStart;
    for (const seg of segments) {
        const a = seg.bottomJoint?.pos ?? prevTop;
        const b = seg.topJoint?.pos;
        const r = ((seg.diameter ?? 1) / 2) * RADIUS_TOLERANCE;
        if (a && b) {
            if (seg.type === 'bezier' && seg.controlPoint1 && seg.controlPoint2) {
                let prev = a;
                for (let i = 1; i <= BEZIER_SUBDIVISIONS; i++) {
                    const p = cubic(a, seg.controlPoint1, seg.controlPoint2, b, i / BEZIER_SUBDIVISIONS);
                    out.push({ a: prev, b: p, r, part: 'shaft' });
                    prev = p;
                }
            } else {
                out.push({ a, b, r, part: 'shaft' });
            }
        }
        if (b) prevTop = b;
    }
    return out;
}

/** Capsules for a trunk/branch/anchor-like entity: shaft segments + contact cone. */
export function shaftEntityCapsules(
    segments: Array<{ diameter?: number; bottomJoint?: { pos: Vec3 } | null; topJoint?: { pos: Vec3 } | null }>,
    cone?: ContactCone,
    firstStart?: Vec3,
): SupportCapsule[] {
    const caps = segmentCapsules(segments, firstStart);
    // The shaft's top joint IS the cone socket: use it rather than re-deriving it.
    const socket = [...segments].reverse().find((seg) => seg.topJoint)?.topJoint?.pos;
    if (cone) caps.push(coneCapsule(cone, socket));
    return caps;
}

/** A leaf is a single cone running from its knot on the host shaft to the tip. */
export function leafCapsules(knotPos: Vec3, cone: ContactCone): SupportCapsule[] {
    return [coneCapsule(cone, knotPos)];
}

/** Model-to-model stick: shaft segments + a cone at each end. */
export function stickCapsules(
    segments: Array<{ diameter?: number; bottomJoint?: { pos: Vec3 } | null; topJoint?: { pos: Vec3 } | null }>,
    coneA: ContactCone,
    coneB: ContactCone,
): SupportCapsule[] {
    return [...segmentCapsules(segments), coneCapsule(coneA), coneCapsule(coneB)];
}

export function capsuleHitsMesh(c: SupportCapsule, mesh: THREE.Mesh, isOwnModel: boolean): boolean {
    const a = c.a;
    let b = c.b;
    if (isOwnModel && c.part === 'cone') {
        // The tip legitimately touches its own model: test only the part of the
        // cone short of the contact.
        const d = len(sub(b, a));
        if (d <= OWN_CONE_TIP_ALLOWANCE_MM + 0.05) return false;
        b = lerp(a, b, (d - OWN_CONE_TIP_ALLOWANCE_MM) / d);
    }
    if (len(sub(b, a)) < 1e-4) return false;
    return isShaftBlocked(a, b, Math.max(0.05, c.r), mesh);
}

/**
 * Where a capsule first enters the mesh: binary search on the blocked prefix.
 * Diagnostic only (audit), so a handful of extra SDF queries is fine.
 */
function firstHitAlong(c: SupportCapsule, mesh: THREE.Mesh, isOwnModel: boolean): { t: number; at: Vec3 } | null {
    if (!capsuleHitsMesh(c, mesh, isOwnModel)) return null;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const prefix: SupportCapsule = { ...c, b: lerp(c.a, c.b, mid) };
        if (capsuleHitsMesh(prefix, mesh, isOwnModel)) hi = mid; else lo = mid;
    }
    // For an own-model cone the tested capsule stops OWN_CONE_TIP_ALLOWANCE_MM
    // short of its end, so the real entry point is that much further back.
    const full = len(sub(c.b, c.a));
    const entry = isOwnModel && c.part === 'cone' ? Math.max(0, full * hi - OWN_CONE_TIP_ALLOWANCE_MM) : full * hi;
    const t = full > 0 ? entry / full : 0;
    return { t, at: lerp(c.a, c.b, t) };
}

/** Ids of the models (other than `modelId`) that any of the capsules intersect. */
export function otherModelsHit(capsules: SupportCapsule[], modelId: string): string[] {
    const hits: string[] = [];
    for (const otherId of getAllModelIds()) {
        if (otherId === modelId) continue;
        const mesh = getModelMesh(otherId);
        if (!mesh) continue;
        if (capsules.some((c) => capsuleHitsMesh(c, mesh, false))) hits.push(otherId);
    }
    return hits;
}

/** True when any capsule runs through a model other than `modelId`. */
export function collidesWithOtherModels(capsules: SupportCapsule[], modelId: string): boolean {
    return otherModelsHit(capsules, modelId).length > 0;
}

// ---------------------------------------------------------------------------
// Plate audit
// ---------------------------------------------------------------------------

export interface SupportAuditOffender {
    kind: 'trunk' | 'branch' | 'leaf' | 'anchor' | 'stick';
    id: string;
    modelId: string;
    throughOwnModel: boolean;
    throughOtherModels: string[];
    /** Contact sits on an up-facing surface (the support reaches a top face from below). */
    tipOnUpFacing: boolean;
    tip?: Vec3;
    /** First hit in another model: which model, capsule and where it enters. */
    otherHit?: { modelId: string; capsule: number; of: number; part: SupportCapsule['part']; at: Vec3 };
    /** First own-model hit: which capsule (index/part/length/radius) and where it enters. */
    ownHit?: { capsule: number; of: number; part: SupportCapsule['part']; lengthMm: number; r: number; t: number; at: Vec3 };
    /** The capsules that were tested, bottom to top: [part, a, b] (debugging). */
    path?: Array<[SupportCapsule['part'], Vec3, Vec3]>;
}

export interface SupportAuditModelStats {
    supports: number;
    throughOwnModel: number;
    throughOtherModels: number;
    tipsOnUpFacing: number;
    crossModelHosted: number;
}

export interface TrunkStats {
    count: number;
    /** Shaft diameter (mm) → number of trunks. */
    diameterHistogram: Record<string, number>;
    /** Free length from plate to contact (mm): p50 / p90 / max. */
    lengthMm: { p50: number; p90: number; max: number };
    /** Length / diameter: p50 / p90 / max (slenderness — high = whippy). */
    slenderness: { p50: number; p90: number; max: number };
    tipContactMm: { min: number; max: number };
    /** Braces (cross-ties between shafts) belonging to this model. */
    braces: number;
}

export interface SupportAuditResult {
    totals: SupportAuditModelStats;
    perModel: Record<string, SupportAuditModelStats>;
    trunks: Record<string, TrunkStats>;
    /** XY extent of each model's support roots (base pads, pos ± diameter/2), mm. Rafts add a margin on top. */
    rootBoundsXY: Record<string, { minX: number; maxX: number; minY: number; maxY: number }>;
    /** Weak-geometry findings per model (see SupportGeometryIssues). */
    geometry: Record<string, SupportGeometryIssues>;
    /** The support currently selected in the app, traced with exact distances to its part. */
    selected?: SelectedSupportTrace | null;
    offenders: SupportAuditOffender[];
}

/**
 * Supports that hold badly even when they do not collide:
 * - wallContacts: the tip sits on a near-vertical face (|normal.z| < 0.34,
 *   i.e. steeper than 70°): it pushes on a wall instead of carrying an underside.
 * - steepShafts: a trunk/branch/anchor shaft segment more than 45° off vertical
 *   (e.g. a horizontal elbow): it carries the peel in bending.
 * - conelessTrunks: a trunk with no contact cone (ends on a bare joint).
 */
export interface SupportGeometryIssues {
    wallContacts: number;
    steepShafts: number;
    conelessTrunks: number;
    /** Auto-bracing kickstands (plate → elbow → host knot on a shaft). */
    kickstands?: number;
    /** Trunks whose printed path goes inside their own part (exact distance < 0). */
    trunksInsidePart?: number;
    /** Contact cones whose axis lies more than 50° off straight down. */
    tiltedCones?: number;
    /** Contact tips that do not reach the part (exact distance > 0.1 mm). */
    detachedTips?: number;
    /** Tips whose contact disk straddles an edge (part of it over the void). */
    unseatedTips?: number;
    samples: Array<{ kind: string; issue: GeometryIssue; at: Vec3; detail: number }>;
}

type GeometryIssue = 'wall' | 'steep' | 'coneless' | 'kickstand' | 'tilted-cone' | 'inside-part' | 'detached-tip' | 'unseated-tip';
/** A contact tip further than this outside its part holds nothing (mm). */
const DETACHED_TIP_MM = 0.1;
/** Contact cone axis more than this off straight down (deg). */
const TILTED_CONE_DEG = 50;

/** Walk a printed polyline and return the smallest exact signed distance to
 *  the part (negative = inside), ignoring the last `tipAllowance` mm. */
function minDistanceAlong(path: Vec3[], mesh: THREE.Mesh, tipAllowance: number, stepMm = 0.25): { d: number; at: Vec3 } {
    const sdf = getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();
    let total = 0;
    for (let i = 1; i < path.length; i++) total += len(sub(path[i], path[i - 1]));
    let walked = 0, minD = Infinity, minAt = path[0];
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const L = len(sub(b, a));
        const steps = Math.max(1, Math.ceil(L / stepMm));
        for (let k = 0; k <= steps; k++) {
            if (walked + (L * k) / steps > total - tipAllowance) break;
            const p = lerp(a, b, k / steps);
            const d = sdf.exactSignedDistanceAt(p.x, p.y, p.z);
            if (d < minD) { minD = d; minAt = p; }
        }
        walked += L;
    }
    return { d: minD, at: minAt };
}

function trunkPath(snap: ReturnType<typeof getSnapshot>, t: ReturnType<typeof getSnapshot>['trunks'][string]): Vec3[] {
    const path: Vec3[] = [];
    const root = snap.roots[t.rootId];
    t.segments.forEach((sg, i) => {
        const ep = getTrunkSegmentEndpoints(t, sg, i, root);
        if (!ep) return;
        if (path.length === 0) path.push(ep.start);
        path.push(ep.end);
    });
    if (t.contactCone) path.push(t.contactCone.pos);
    return path;
}

export interface SelectedSupportTrace {
    kind: string;
    id: string;
    modelId: string;
    tip?: Vec3;
    /** Bottom → top polyline as printed (root top, joints, socket, tip). */
    path: Vec3[];
    /** Smallest exact signed distance to the part along the path, excluding the
     *  last 1.2 mm before the tip (negative = inside the part). */
    minDistanceMm: number;
    minAt: Vec3;
}

const WALL_NORMAL_Z = 0.34;
const STEEP_SHAFT_DEG = 45;
const MAX_GEOMETRY_SAMPLES = 25;

function pct(sorted: number[], q: number): number {
    if (!sorted.length) return 0;
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] * 100) / 100;
}

function trunkStats(): Record<string, TrunkStats> {
    const snap = getSnapshot();
    const by: Record<string, { d: number[]; l: number[]; tip: number[] }> = {};
    for (const t of Object.values(snap.trunks)) {
        const e = (by[t.modelId] ??= { d: [], l: [], tip: [] });
        const d = t.segments[0]?.diameter ?? 1;
        const tipZ = t.contactCone?.pos.z ?? Math.max(...t.segments.map((s) => s.topJoint?.pos.z ?? 0));
        e.d.push(d);
        e.l.push(tipZ);
        if (t.contactCone) e.tip.push(t.contactCone.profile?.contactDiameterMm ?? 0.4);
    }
    const out: Record<string, TrunkStats> = {};
    for (const [id, e] of Object.entries(by)) {
        const hist: Record<string, number> = {};
        for (const d of e.d) { const k = (Math.round(d * 10) / 10).toFixed(1); hist[k] = (hist[k] ?? 0) + 1; }
        const l = [...e.l].sort((a, b) => a - b);
        const sl = e.l.map((len, i) => len / Math.max(e.d[i], 0.1)).sort((a, b) => a - b);
        out[id] = {
            count: e.d.length,
            diameterHistogram: hist,
            lengthMm: { p50: pct(l, 0.5), p90: pct(l, 0.9), max: pct(l, 1) },
            slenderness: { p50: pct(sl, 0.5), p90: pct(sl, 0.9), max: pct(sl, 1) },
            tipContactMm: { min: Math.min(...e.tip), max: Math.max(...e.tip) },
            braces: Object.values(snap.braces ?? {}).filter((b) => b.modelId === id).length,
        };
    }
    return out;
}

function emptyStats(): SupportAuditModelStats {
    return { supports: 0, throughOwnModel: 0, throughOtherModels: 0, tipsOnUpFacing: 0, crossModelHosted: 0 };
}

/**
 * Audit every support on the plate: which run through their own model's body,
 * which run through another model, which touch an up-facing (top/detail)
 * surface, and which leaves/branches hang off a trunk of a DIFFERENT model.
 */
export function auditSupports(maxOffenders = 200): SupportAuditResult {
    const snap = getSnapshot();
    const perModel: Record<string, SupportAuditModelStats> = {};
    const totals = emptyStats();
    const offenders: SupportAuditOffender[] = [];

    const shaftOwner = new Map<string, string>();
    for (const t of Object.values(snap.trunks)) {
        shaftOwner.set(t.id, t.modelId);
        for (const s of t.segments) shaftOwner.set(s.id, t.modelId);
    }
    for (const b of Object.values(snap.branches)) {
        shaftOwner.set(b.id, b.modelId);
        for (const s of b.segments) shaftOwner.set(s.id, b.modelId);
    }

    const visit = (
        kind: SupportAuditOffender['kind'],
        id: string,
        modelId: string,
        caps: SupportCapsule[],
        tipCones: ContactCone[],
        hostShaftId?: string,
    ) => {
        const stats = (perModel[modelId] ??= emptyStats());
        stats.supports++;
        totals.supports++;
        const own = getModelMesh(modelId);
        let ownHit: SupportAuditOffender['ownHit'];
        if (own) {
            for (let i = 0; i < caps.length && !ownHit; i++) {
                const h = firstHitAlong(caps[i], own, true);
                if (h) {
                    const c = caps[i];
                    ownHit = { capsule: i, of: caps.length, part: c.part, lengthMm: len(sub(c.b, c.a)), r: c.r, t: h.t, at: h.at };
                }
            }
        }
        const throughOwnModel = ownHit !== undefined;
        const throughOtherModels = otherModelsHit(caps, modelId);
        let otherHit: SupportAuditOffender['otherHit'];
        if (throughOtherModels.length) {
            const mesh = getModelMesh(throughOtherModels[0]);
            for (let i = 0; mesh && i < caps.length && !otherHit; i++) {
                const h = firstHitAlong(caps[i], mesh, false);
                if (h) otherHit = { modelId: throughOtherModels[0], capsule: i, of: caps.length, part: caps[i].part, at: h.at };
            }
        }
        // surfaceNormal is the outward surface normal at the contact; a support
        // landing on an up-facing (top) surface has it pointing up.
        const tipOnUpFacing = tipCones.some((c) => (c.surfaceNormal ?? c.normal).z > 0.2);
        const hostModel = hostShaftId ? shaftOwner.get(hostShaftId) : undefined;
        const crossHosted = hostModel !== undefined && hostModel !== modelId;
        if (throughOwnModel) { stats.throughOwnModel++; totals.throughOwnModel++; }
        if (throughOtherModels.length) { stats.throughOtherModels++; totals.throughOtherModels++; }
        if (tipOnUpFacing) { stats.tipsOnUpFacing++; totals.tipsOnUpFacing++; }
        if (crossHosted) { stats.crossModelHosted++; totals.crossModelHosted++; }
        if ((throughOwnModel || throughOtherModels.length || tipOnUpFacing || crossHosted) && offenders.length < maxOffenders) {
            const rr = (v: Vec3) => ({ x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 });
            offenders.push({ kind, id, modelId, throughOwnModel, throughOtherModels, tipOnUpFacing, tip: tipCones[0]?.pos, ownHit, otherHit,
                path: caps.map((c) => [c.part, rr(c.a), rr(c.b)] as [SupportCapsule['part'], Vec3, Vec3]) });
        }
    };

    for (const t of Object.values(snap.trunks)) {
        visit('trunk', t.id, t.modelId, shaftEntityCapsules(t.segments, t.contactCone), t.contactCone ? [t.contactCone] : []);
    }
    for (const b of Object.values(snap.branches)) {
        const knot = snap.knots[b.parentKnotId];
        visit('branch', b.id, b.modelId, shaftEntityCapsules(b.segments, b.contactCone, knot?.pos),
            b.contactCone ? [b.contactCone] : [], knot?.parentShaftId);
    }
    for (const l of Object.values(snap.leaves)) {
        const knot = snap.knots[l.parentKnotId];
        const caps = knot ? leafCapsules(knot.pos, l.contactCone) : [coneCapsule(l.contactCone)];
        visit('leaf', l.id, l.modelId, caps, [l.contactCone], knot?.parentShaftId);
    }
    for (const a of Object.values(snap.anchors)) {
        visit('anchor', a.id, a.modelId, shaftEntityCapsules(a.segments, a.contactCone, a.joint?.pos), [a.contactCone]);
    }
    for (const s of Object.values(snap.sticks ?? {})) {
        visit('stick', s.id, s.modelId, stickCapsules(s.segments, s.contactConeA, s.contactConeB), [s.contactConeA, s.contactConeB]);
    }

    const rootBoundsXY: SupportAuditResult['rootBoundsXY'] = {};
    const r2 = (v: number) => Math.round(v * 100) / 100;
    for (const root of Object.values(snap.roots)) {
        const r = root.diameter / 2;
        const { x, y } = root.transform.pos;
        const b = (rootBoundsXY[root.modelId] ??= { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
        b.minX = Math.min(b.minX, r2(x - r)); b.maxX = Math.max(b.maxX, r2(x + r));
        b.minY = Math.min(b.minY, r2(y - r)); b.maxY = Math.max(b.maxY, r2(y + r));
    }

    const geometry: Record<string, SupportGeometryIssues> = {};
    const g = (modelId: string) => (geometry[modelId] ??= { wallContacts: 0, steepShafts: 0, conelessTrunks: 0, samples: [] });
    const sample = (modelId: string, kind: string, issue: GeometryIssue, at: Vec3, detail: number) => {
        const e = g(modelId);
        if (e.samples.length < MAX_GEOMETRY_SAMPLES) e.samples.push({ kind, issue, at: { x: r2(at.x), y: r2(at.y), z: r2(at.z) }, detail: r2(detail) });
    };
    const checkCone = (kind: string, modelId: string, cone: ContactCone | undefined) => {
        if (!cone) return;
        const nz = (cone.surfaceNormal ?? cone.normal).z;
        if (Math.abs(nz) < WALL_NORMAL_Z) { g(modelId).wallContacts++; sample(modelId, kind, 'wall', cone.pos, nz); }
        // The cone's own axis (tip → socket): lying flat means a sideways arm.
        const ax = cone.normal;
        const axLen = Math.hypot(ax.x, ax.y, ax.z) || 1;
        const tilt = (Math.acos(Math.max(-1, Math.min(1, -ax.z / axLen))) * 180) / Math.PI;
        if (tilt > TILTED_CONE_DEG) { const e = g(modelId); e.tiltedCones = (e.tiltedCones ?? 0) + 1; sample(modelId, kind, 'tilted-cone', cone.pos, tilt); }
    };
    const checkShafts = (kind: string, modelId: string, caps: SupportCapsule[]) => {
        for (const c of caps) {
            if (c.part !== 'shaft') continue;
            const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y, dz = c.b.z - c.a.z;
            const len = Math.hypot(dx, dy, dz);
            if (len < 0.15) continue;
            const deg = (Math.acos(Math.min(1, Math.abs(dz) / len)) * 180) / Math.PI;
            if (deg > STEEP_SHAFT_DEG) { g(modelId).steepShafts++; sample(modelId, kind, 'steep', c.b, deg); break; }
        }
    };
    for (const t of Object.values(snap.trunks)) {
        if (!t.contactCone) {
            g(t.modelId).conelessTrunks++;
            const top = t.segments[t.segments.length - 1]?.topJoint?.pos;
            if (top) sample(t.modelId, 'trunk', 'coneless', top, 0);
        }
        checkCone('trunk', t.modelId, t.contactCone);
        // Same endpoints the slicer prints (root top for the first segment,
        // previous joint / cone socket otherwise): joint-less segments were
        // skipped by the generic capsule builder.
        const root = snap.roots[t.rootId];
        const trunkCaps: SupportCapsule[] = [];
        t.segments.forEach((seg, i) => {
            const ep = getTrunkSegmentEndpoints(t, seg, i, root);
            if (ep) trunkCaps.push({ a: ep.start, b: ep.end, r: (seg.diameter ?? 1) / 2, part: 'shaft' });
        });
        checkShafts('trunk', t.modelId, trunkCaps);
    }
    for (const b of Object.values(snap.branches)) {
        checkCone('branch', b.modelId, b.contactCone);
        checkShafts('branch', b.modelId, shaftEntityCapsules(b.segments, b.contactCone, snap.knots[b.parentKnotId]?.pos));
    }
    for (const l of Object.values(snap.leaves)) checkCone('leaf', l.modelId, l.contactCone);
    for (const a of Object.values(snap.anchors)) {
        checkCone('anchor', a.modelId, a.contactCone);
        checkShafts('anchor', a.modelId, shaftEntityCapsules(a.segments, a.contactCone, a.joint?.pos));
    }

    // Selected support: trace it the way the slicer prints it.
    let selected: SelectedSupportTrace | null = null;
    const selId = snap.selectedId;
    if (selId) {
        const ownerTrunk = snap.trunks[selId]
            ?? Object.values(snap.trunks).find((t) => t.segments.some((sg) => sg.id === selId || sg.topJoint?.id === selId || sg.bottomJoint?.id === selId));
        let kind = 'trunk';
        let modelId = '';
        let path: Vec3[] = [];
        let tip: Vec3 | undefined;
        if (ownerTrunk) {
            modelId = ownerTrunk.modelId;
            const root = snap.roots[ownerTrunk.rootId];
            ownerTrunk.segments.forEach((sg, i) => {
                const ep = getTrunkSegmentEndpoints(ownerTrunk, sg, i, root);
                if (!ep) return;
                if (path.length === 0) path.push(ep.start);
                path.push(ep.end);
            });
            if (ownerTrunk.contactCone) { tip = ownerTrunk.contactCone.pos; path.push(tip); }
        } else if (snap.leaves[selId]) {
            const l = snap.leaves[selId]; kind = 'leaf'; modelId = l.modelId;
            const knot = snap.knots[l.parentKnotId];
            tip = l.contactCone.pos;
            path = knot ? [knot.pos, tip] : [tip];
        } else if (snap.branches[selId]) {
            const b = snap.branches[selId]; kind = 'branch'; modelId = b.modelId;
            const knot = snap.knots[b.parentKnotId];
            path = [...(knot ? [knot.pos] : []), ...b.segments.map((sg) => sg.topJoint?.pos).filter(Boolean) as Vec3[]];
            if (b.contactCone) { tip = b.contactCone.pos; path.push(tip); }
        } else if (snap.anchors[selId]) {
            const a = snap.anchors[selId]; kind = 'anchor'; modelId = a.modelId;
            path = [a.joint.pos, ...a.segments.map((sg) => sg.topJoint?.pos).filter(Boolean) as Vec3[], a.contactCone.pos];
            tip = a.contactCone.pos;
        }
        const mesh = modelId ? getModelMesh(modelId) : null;
        if (mesh && path.length >= 2) {
            const { d: minD, at: minAt } = minDistanceAlong(path, mesh, OWN_CONE_TIP_ALLOWANCE_MM, 0.2);
            const rr = (v: Vec3) => ({ x: r2(v.x), y: r2(v.y), z: r2(v.z) });
            selected = { kind, id: selId, modelId, tip: tip ? rr(tip) : undefined, path: path.map(rr), minDistanceMm: r2(minD), minAt: rr(minAt) };
        } else {
            selected = { kind: snap.selectedCategory ?? 'unknown', id: selId, modelId, path: [], minDistanceMm: NaN, minAt: { x: 0, y: 0, z: 0 } };
        }
    }

    // Exact check: trunks whose printed path enters their own part (beyond the
    // contact tip). The capsule/SDF-grid test above is approximate.
    for (const t of Object.values(snap.trunks)) {
        const mesh = getModelMesh(t.modelId);
        const path = trunkPath(snap, t);
        if (!mesh || path.length < 2) continue;
        const { d, at } = minDistanceAlong(path, mesh, OWN_CONE_TIP_ALLOWANCE_MM);
        if (d < 0) {
            const e = g(t.modelId);
            e.trunksInsidePart = (e.trunksInsidePart ?? 0) + 1;
            sample(t.modelId, 'trunk', 'inside-part', at, d);
        }
    }

    // Tips that stop short of the part: a support that prints up to the part
    // without fusing to it.
    const checkTip = (kind: string, modelId: string, cone: ContactCone | undefined) => {
        if (!cone) return;
        const mesh = getModelMesh(modelId);
        if (!mesh) return;
        const sdf = getOrCreateSDFCache(mesh);
        sdf.refreshMatrix();
        const d = sdf.exactSignedDistanceAt(cone.pos.x, cone.pos.y, cone.pos.z);
        if (d > DETACHED_TIP_MM) {
            const e = g(modelId);
            e.detachedTips = (e.detachedTips ?? 0) + 1;
            sample(modelId, kind, 'detached-tip', cone.pos, d);
        }
        const dia = cone.profile?.contactDiameterMm ?? 0.4;
        mesh.updateMatrixWorld();
        // Same disk plane as placement: the clamped surface normal.
        const ring = seatingRing(cone.pos, clampConeAxis(cone.surfaceNormal ?? cone.normal), dia / 2 + 0.05, mesh);
        if (ring.hits < SEAT_MIN_HITS) {
            const e = g(modelId);
            e.unseatedTips = (e.unseatedTips ?? 0) + 1;
            sample(modelId, kind, 'unseated-tip', cone.pos, ring.hits);
        }
    };
    for (const t of Object.values(snap.trunks)) checkTip('trunk', t.modelId, t.contactCone);
    for (const b of Object.values(snap.branches)) checkTip('branch', b.modelId, b.contactCone);
    for (const l of Object.values(snap.leaves)) checkTip('leaf', l.modelId, l.contactCone);
    for (const a of Object.values(snap.anchors)) checkTip('anchor', a.modelId, a.contactCone);

    const ks = getKickstandSnapshot();
    for (const k of Object.values(ks.kickstands)) {
        const e = g(k.modelId);
        e.kickstands = (e.kickstands ?? 0) + 1;
        const host = ks.knots[k.hostKnotId]?.pos;
        if (host) sample(k.modelId, 'kickstand', 'kickstand', host, 0);
    }

    return { totals, perModel, trunks: trunkStats(), rootBoundsXY, geometry, selected, offenders };
}
