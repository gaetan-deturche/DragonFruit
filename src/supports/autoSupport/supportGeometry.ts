import type * as THREE from 'three';
import type { Vec3 } from '../types';
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

function segmentCapsules(
    segments: Array<{ diameter?: number; bottomJoint?: { pos: Vec3 } | null; topJoint?: { pos: Vec3 } | null }>,
    firstStart?: Vec3,
): SupportCapsule[] {
    const out: SupportCapsule[] = [];
    let prevTop: Vec3 | undefined = firstStart;
    for (const seg of segments) {
        const a = seg.bottomJoint?.pos ?? prevTop;
        const b = seg.topJoint?.pos;
        if (a && b) out.push({ a, b, r: ((seg.diameter ?? 1) / 2) * RADIUS_TOLERANCE, part: 'shaft' });
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

function capsuleHitsMesh(c: SupportCapsule, mesh: THREE.Mesh, isOwnModel: boolean): boolean {
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
}

export interface SupportAuditModelStats {
    supports: number;
    throughOwnModel: number;
    throughOtherModels: number;
    tipsOnUpFacing: number;
    crossModelHosted: number;
}

export interface SupportAuditResult {
    totals: SupportAuditModelStats;
    perModel: Record<string, SupportAuditModelStats>;
    offenders: SupportAuditOffender[];
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
            offenders.push({ kind, id, modelId, throughOwnModel, throughOtherModels, tipOnUpFacing, tip: tipCones[0]?.pos, ownHit, otherHit });
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

    return { totals, perModel, offenders };
}
