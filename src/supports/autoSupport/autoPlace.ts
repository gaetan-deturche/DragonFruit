import { getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import * as THREE from 'three';
import type { CandidatePoint, AutoPlaceResult, AutoPlaceAnalytics, RejectReason } from './types';

function round2(v: number): number { return Math.round(v * 100) / 100; }
import type { AutoSupportSettings } from './settings';
import { normalizeAutoSupportSettings } from './settings';
import { generateCandidates, deduplicateCandidates } from './candidateGeneration';
import { sizeParameters, requiredTipContactDiameterMm } from './parameterSizing';
import type { ModelSizingContext } from './parameterSizing';
import { getSettings } from '../Settings/state';
import { getSnapshot, addRoot, addTrunk, addBranch, addLeaf, addKnot, addAnchor, addStick, addTwig } from '../state';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { buildTrunkData, buildEscapeTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import { buildCavityStick } from '../SupportTypes/Trunk/useTrunkPlacement';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { decideGridPlacement } from '../PlacementLogic/Grid/gridPlacement';
import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';
import { isShaftBlocked } from '../PlacementLogic/CollisionAvoidance';
import { runAutoBracing } from '../autoBracing/autoBrace';
import { pushHistory } from '@/history/historyStore';
import { getModelMesh } from './meshStore';
import { isRootWithinPlate } from '../plateBounds';
import { seatContact, seatingStats, resetSeatingStats } from './contactSeating';
import { AUTO_ATTACH_MAX_ANGLE_DEG, AUTO_LEAF_MAX_SPAN_MM, MAX_CONE_TILT_DEG, angleFromVerticalDeg, clampConeAxis } from './attachmentLimits';
import type { Roots, Trunk } from '../types';
import { generateOverhangCandidates, generateLowestPointCandidates } from './overhangSampling';
import {
    collidesWithOtherModels,
    leafCapsules,
    capsuleHitsMesh,
    shaftEntityCapsules,
    stickCapsules,
    type SupportCapsule,
} from './supportGeometry';

const LOG_PREFIX = '[AutoSupport]';

/**
 * Minimum vertical span (mm) for an auto-placed model-to-model Stick/Twig to be
 * accepted. Bridges shorter than this hold no real load — they only scar both
 * surfaces (the die case, where overhangs sit a fraction of a mm above the
 * surface below). Genuine trapped overhangs (bust hair over shoulders) span far
 * more than this, so they are kept. Tune here if legitimate short bridges get
 * dropped. Only affects auto-support; manual placement passes no threshold.
 */
const MIN_MODEL_TO_MODEL_Z_SPAN_MM = 3.0;

// ---------------------------------------------------------------------------
// History action type
// ---------------------------------------------------------------------------

const SUPPORT_AUTO_PLACE = 'support:auto-place' as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
    trunks: number,
    anchors: number,
    branches: number,
    leaves: number,
    sticks: number,
    rejected: number,
    changed: boolean,
    message: string,
): AutoPlaceResult {
    return {
        placedTrunks: trunks,
        placedAnchors: anchors,
        placedBranches: branches,
        placedLeaves: leaves,
        placedSticks: sticks,
        rejectedCandidates: rejected,
        changed,
        message,
    };
}

// ---------------------------------------------------------------------------
// Normal resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a support contact on a DOWN-facing surface at/above `tipPos`.
 *
 * Supports approach from below, so a valid contact is the first surface an
 * upward ray meets, and that surface must face down (outward normal z < 0).
 * {@link resolveSurfaceNormal} instead takes whichever surface is closest —
 * often the up-facing TOP face of a thin feature — and the caller then forced
 * the normal straight down, producing supports that climb THROUGH the model to
 * land on a top (detail) face. Returns null when no down-facing surface lies
 * within `maxDzMm` above the start, so the caller rejects instead of guessing.
 */
function resolveDownFacingContact(
    tipPos: { x: number; y: number; z: number },
    mesh: THREE.Mesh | undefined,
    startBelowMm = 0.6,
    maxDzMm = 1.2,
): { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } | null {
    if (!mesh) return null;
    const raycaster = new THREE.Raycaster();
    const startZ = tipPos.z - startBelowMm;
    // Contacts often sit exactly on an edge or vertex (an island's lowest
    // point), where a vertical ray can slip past the surface: retry with tiny
    // XY offsets before giving up.
    for (const [dx, dy] of CONTACT_RAY_OFFSETS_MM) {
        raycaster.set(new THREE.Vector3(tipPos.x + dx, tipPos.y + dy, startZ), new THREE.Vector3(0, 0, 1));
        const hit = raycaster.intersectObject(mesh, false)[0];
        if (!hit) continue;
        if (hit.point.z - startZ > startBelowMm + maxDzMm) continue;
        // calculateSmoothedNormal returns the OUTWARD world normal. If the first
        // surface met going up faces up, the ray started inside the solid.
        const n = calculateSmoothedNormal(hit);
        if (n.z > -0.05) continue;
        return { point: { x: hit.point.x, y: hit.point.y, z: hit.point.z }, normal: n };
    }
    return null;
}

const CONTACT_RAY_OFFSETS_MM: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1],
    [0.2, 0.2], [-0.2, 0.2], [0.2, -0.2], [-0.2, -0.2],
];

/** Capsules of a freshly built trunk (shaft from its root + contact cone). */
function trunkCapsulesOf(build: {
    trunk: { segments: Parameters<typeof shaftEntityCapsules>[0]; contactCone?: Parameters<typeof shaftEntityCapsules>[1] };
    root?: { transform?: { pos?: { x: number; y: number; z: number } } };
}): SupportCapsule[] {
    return shaftEntityCapsules(build.trunk.segments, build.trunk.contactCone, build.root?.transform?.pos);
}

/**
 * Whether an island deserves its own support in the post-placement passes.
 * Mirrors {@link generateCandidates}: unconfirmed mesh-minima (sub-resolution
 * sculpt noise) and voxel islands below the minimum area are left alone —
 * the fanning pass used to drop a leaf on every one of them.
 */
function isIslandWorthSupporting(island: DetectedIsland, settings: AutoSupportSettings): boolean {
    if (island.source === 'minima' && island.class === 'minimaOnly') return settings.supportUnconfirmedMinima;
    return (island.areaMm2 ?? 0) >= settings.minIslandAreaMm2;
}

// ---------------------------------------------------------------------------
// Already-supported filter
// ---------------------------------------------------------------------------

/** Distance within which a candidate is considered already supported. */
const ALREADY_SUPPORTED_RADIUS_MM = 3.0;

/**
 * Knot ids must be unique across the whole plate. They used to be derived from
 * the island id alone ("auto-fan-v54-p0"), and island ids restart at v0/m0 for
 * every model scan — so generating supports for a second model OVERWROTE the
 * first model's knots, re-parenting its leaves onto the other model's trunks
 * (100 mm leaves running across the plate).
 */
function uniqueKnotId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Candidates whose tips fall in the same cell of this size are the same contact. */
const DUPLICATE_TIP_MM = 0.4;

/**
 * Remove candidates whose tip position is already covered by an
 * existing support (any trunk / branch / leaf / anchor contact cone).
 * Prevents stacking duplicate supports on repeated runs.
 */
function filterAlreadySupported(candidates: CandidatePoint[]): CandidatePoint[] {
    const snapshot = getSnapshot();
    const existingTips: Array<{ x: number; y: number; z: number }> = [];

    for (const t of Object.values(snapshot.trunks)) {
        if (t.contactCone?.pos) existingTips.push(t.contactCone.pos);
    }
    for (const b of Object.values(snapshot.branches)) {
        if (b.contactCone?.pos) existingTips.push(b.contactCone.pos);
    }
    for (const l of Object.values(snapshot.leaves)) {
        if (l.contactCone?.pos) existingTips.push(l.contactCone.pos);
    }
    for (const a of Object.values(snapshot.anchors)) {
        if (a.contactCone?.pos) existingTips.push(a.contactCone.pos);
    }

    if (existingTips.length === 0) return candidates;

    const r2 = ALREADY_SUPPORTED_RADIUS_MM * ALREADY_SUPPORTED_RADIUS_MM;
    return candidates.filter(c => {
        for (const tip of existingTips) {
            const dx = c.tipPos.x - tip.x;
            const dy = c.tipPos.y - tip.y;
            const dz = c.tipPos.z - tip.z;
            if (dx * dx + dy * dy + dz * dz <= r2) return false;
        }
        return true;
    });
}

// ---------------------------------------------------------------------------
// Nearby-trunk merge (works even without grid mode)
// ---------------------------------------------------------------------------

/** When grid is disabled, merge candidates within this XY distance of an existing trunk. */
const GRIDLESS_MERGE_RADIUS_MM = 4.0;

interface MergeHost {
    trunkId: string;
    tipPos: { x: number; y: number; z: number };
}

// ---------------------------------------------------------------------------
// Leaf fan-out — max distance / angle constants
// ---------------------------------------------------------------------------

const LEAF_FAN_RADIUS_MM = AUTO_LEAF_MAX_SPAN_MM;
/** Shaft points tried per uncovered island (nearest first) before giving up. */
const LEAF_FAN_MAX_TRIES = 12;
/** A fan leaf's knot must sit at least this far below its tip. */
const LEAF_FAN_MIN_DROP_MM = 0.8;
const LEAF_FAN_MAX_ANGLE_DEG = AUTO_ATTACH_MAX_ANGLE_DEG;

// ---------------------------------------------------------------------------
// Leaf cone triangle collision
// ---------------------------------------------------------------------------

const _leafRaycaster = new THREE.Raycaster();

/** Check whether a leaf cone from `knotPos` to `cone` intersects the model.
 *  Raycasts from the knot toward a point just before the tip (offset inward
 *  along the surface normal), excluding the tip contact itself.  Returns true
 *  if the ray hits a model triangle before reaching the offset point. */
function leafConeCollides(
    knotPos: { x: number; y: number; z: number },
    cone: { pos: { x: number; y: number; z: number }; surfaceNormal?: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } },
    mesh: THREE.Mesh,
): boolean {
    // Ray from knot toward tip. The tip is ON the surface — the first
    // hit should be the tip surface at ~totalDist.  If the first hit
    // is significantly closer, there's geometry between shaft and tip.
    const dx = cone.pos.x - knotPos.x;
    const dy = cone.pos.y - knotPos.y;
    const dz = cone.pos.z - knotPos.z;
    const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (totalDist < 0.01) return false;
    const dir = new THREE.Vector3(dx / totalDist, dy / totalDist, dz / totalDist);

    // Cast two offset rays to account for cone thickness (~0.25mm).
    const n = cone.surfaceNormal ?? cone.normal;
    const perpX = dir.y * n.z - dir.z * n.y;
    const perpY = dir.z * n.x - dir.x * n.z;
    const perpZ = dir.x * n.y - dir.y * n.x;
    const perpLen = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
    const offsets = perpLen > 0.001
        ? [0, 0.25, -0.25]
        : [0];

    for (const off of offsets) {
        const sx = knotPos.x + (perpX / perpLen) * off;
        const sy = knotPos.y + (perpY / perpLen) * off;
        const sz = knotPos.z + (perpZ / perpLen) * off;
        _leafRaycaster.set(new THREE.Vector3(sx, sy, sz), dir);
        const hits = _leafRaycaster.intersectObject(mesh, false);
        if (hits.length > 0 && hits[0].distance < totalDist - 0.5) return true;
    }
    // The rays only sample one plane of the cone: also test its full volume
    // (a cone skimming an edge sideways slipped between them).
    return capsuleHitsMesh(leafCapsules(knotPos, cone as Parameters<typeof leafCapsules>[1])[0], mesh, true);
}

/**
 * Whether the contact cone of a built support runs through its own model.
 * Shafts are checked against the SDF while routing, but the cone is not: on a
 * lip or next to a step, a cone tilted along the surface normal cut through the
 * part for a millimetre or two before reaching its tip.
 */
function coneCutsModel(caps: SupportCapsule[], mesh?: THREE.Mesh): boolean {
    if (!mesh) return false;
    const c = caps.find((k) => k.part === 'cone');
    if (!c) return false;
    return capsuleHitsMesh(c, mesh, true);
}

// ---------------------------------------------------------------------------
// Post-build collision verification
// ---------------------------------------------------------------------------

/** Check all segments of a built branch against the SDF. */
function branchCollidesWithSDF(
    branch: { segments: Array<{ bottomJoint?: { pos: { x: number; y: number; z: number } } | null; topJoint?: { pos: { x: number; y: number; z: number } } | null; diameter?: number }> },
    mesh: THREE.Mesh,
): boolean {
    for (const seg of branch.segments) {
        const start = seg.bottomJoint?.pos;
        const end = seg.topJoint?.pos;
        if (start && end) {
            const r = (seg.diameter ?? 1.0) / 2;
            if (isShaftBlocked(start, end, r, mesh)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Attachment capacity
// ---------------------------------------------------------------------------

/**
 * Count how many knots (branches + leaves) are attached to a trunk.
 * Does NOT count brace knots (they use braceSegment: prefix).
 */
function countAttachmentsOnTrunk(trunkId: string): number {
    const snapshot = getSnapshot();
    const trunk = snapshot.trunks[trunkId];
    if (!trunk) return 0;

    const segmentIds = new Set(trunk.segments.map(s => s.id));
    // Also match legacy knots that reference the trunk ID directly.
    segmentIds.add(trunkId);

    let count = 0;
    for (const knot of Object.values(snapshot.knots)) {
        if (segmentIds.has(knot.parentShaftId)) {
            count++;
        }
    }
    return count;
}

/** Returns true if the trunk has reached its attachment capacity. */
function isTrunkAtAttachmentCapacity(trunkId: string, limit: number): boolean {
    if (limit <= 0) return false;
    return countAttachmentsOnTrunk(trunkId) >= limit;
}

// ---------------------------------------------------------------------------
// Nearby-trunk merge
// ---------------------------------------------------------------------------

/** Find the closest existing trunk (shaft or tip) within merge radius. */
function findMergeHost(
    tipPos: { x: number; y: number; z: number },
    modelId: string,
): MergeHost | null {
    const snapshot = getSnapshot();
    const r2 = GRIDLESS_MERGE_RADIUS_MM * GRIDLESS_MERGE_RADIUS_MM;
    let best: MergeHost | null = null;
    let bestDist2 = Infinity;

    for (const [id, trunk] of Object.entries(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;

        // Check trunk tip (contact cone).
        const tp = trunk.contactCone?.pos;
        if (tp) {
            const dx = tipPos.x - tp.x;
            const dy = tipPos.y - tp.y;
            const dz = tipPos.z - tp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2 && d2 < bestDist2) {
                bestDist2 = d2;
                best = { trunkId: id, tipPos: tp };
            }
        }

        // Also check segment joints (shaft body), preferring lower attachment.
        for (const seg of trunk.segments) {
            const jp = seg.bottomJoint?.pos ?? seg.topJoint?.pos;
            if (!jp) continue;
            const dx = tipPos.x - jp.x;
            const dy = tipPos.y - jp.y;
            const dz = tipPos.z - jp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            // Slight preference for shaft body over tip (multiply by 0.9
            // so a shaft point at the same distance wins).
            const adjustedD2 = d2 * 0.9;
            if (adjustedD2 <= r2 && adjustedD2 < bestDist2) {
                bestDist2 = adjustedD2;
                best = { trunkId: id, tipPos: jp };
            }
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Run a single candidate through the standard placement pipeline:
 * resolve surface normal → buildTrunkData → decideGridPlacement → commit.
 *
 * When grid mode is disabled, we additionally check whether another
 * trunk already sits within {@link GRIDLESS_MERGE_RADIUS_MM} of this
 * candidate's tip.  If so, the candidate is routed as a branch off
 * that host instead of becoming a standalone trunk — preventing
 * clusters of near-identical vertical supports at the same XY.
 *
 * This is the same sequence used by manual placement clicks.
 * Returns the decision kind so the orchestrator can tally.
 */
/**
 * The trunk router may shift the socket sideways to clear the model; the cone
 * then follows that shift and can end up lying almost flat (a horizontal arm
 * on an edge, even pointing upward). Such a contact pushes on the part instead
 * of holding it: treat it like a blocked trunk so the fallbacks get a chance.
 */
const CONE_TILT_REJECT_DEG = MAX_CONE_TILT_DEG + 10;
/** Max angle from vertical of any shaft segment of an auto trunk (deg). The
 *  router can kink a trunk into a long diagonal to reach around the part: a
 *  leaning segment flexes at every peel like a cantilever. */
const MAX_TRUNK_SEGMENT_DEG = 45;

function trunkConeTooTilted(build: { trunk?: Trunk; root?: Roots }): boolean {
    const n = build.trunk?.contactCone?.normal;
    if (n) {
        const len = Math.hypot(n.x, n.y, n.z) || 1;
        const tilt = (Math.acos(Math.max(-1, Math.min(1, -n.z / len))) * 180) / Math.PI;
        if (tilt > CONE_TILT_REJECT_DEG) return true;
    }
    const trunk = build.trunk;
    if (!trunk) return false;
    for (let i = 0; i < trunk.segments.length; i++) {
        const ep = getTrunkSegmentEndpoints(trunk, trunk.segments[i], i, build.root);
        if (!ep) continue;
        const dx = ep.end.x - ep.start.x, dy = ep.end.y - ep.start.y, dz = ep.end.z - ep.start.z;
        const L = Math.hypot(dx, dy, dz);
        if (L < 0.5) continue;
        if ((Math.acos(Math.min(1, Math.abs(dz) / L)) * 180) / Math.PI > MAX_TRUNK_SEGMENT_DEG) return true;
    }
    return false;
}

function placeOneCandidate(
    candidate: CandidatePoint,
    autoSettings: AutoSupportSettings,
    modelCtx?: ModelSizingContext,
    totalArea?: number,
): { kind: string; rejectedReason?: RejectReason; preset?: 'detail' | 'structure' | 'anchor'; entityId?: string; stickCount?: number; detail?: string } {
    const supportSettings = getSettings();
    const snapshot = getSnapshot();
    const mesh = getModelMesh(candidate.modelId) ?? undefined;

    // Resolve the contact point + normal.
    // Overhang candidates already carry an on-surface point and the true
    // down-facing face normal from the sampler. Raycasting would snap to the
    // up-facing TOP surface and flip the normal upward — which buildTrunkData
    // rejects as ANGLE_TOO_STEEP — so use the sampler values directly.
    let tipPos: { x: number; y: number; z: number };
    let tipNormal: { x: number; y: number; z: number };
    // Overhang samples and lowest-point anchors are taken ON the mesh's
    // down-facing surface already (anchors are the bottom vertices themselves).
    if (candidate.source === 'overhang' || candidate.id.startsWith('lowest-')) {
        tipPos = candidate.tipPos;
        tipNormal = candidate.tipNormal;
    } else {
        // Island contacts are the lowest point of a region that faces down: the
        // contact must be ON that down-facing surface. Never snap to a top face
        // (that is what produced supports running through the model).
        const resolved = resolveDownFacingContact(candidate.tipPos, mesh);
        if (!resolved) {
            const areaR = candidate.islandAreaMm2;
            const presetR = areaR <= 0.15 ? 'detail' as const : areaR <= 0.50 ? 'structure' as const : 'anchor' as const;
            return { kind: 'reject', rejectedReason: 'up_facing_contact', preset: presetR, detail: 'NO_DOWN_FACING_SURFACE' };
        }
        tipPos = resolved.point;
        tipNormal = resolved.normal;
    }
    if (tipNormal.z > -0.05) {
        tipNormal = { x: 0, y: 0, z: -1 };
    }
    // Keep the contact cone close to vertical (edge/corner normals lie flat).
    tipNormal = clampConeAxis(tipNormal);
    {
        const isLowestPoint = candidate.source !== 'overhang' || candidate.id.startsWith('lowest-');
        const seated = seatContact(tipPos, tipNormal, modelCtx?.minTipContactMm ?? 0.4, mesh, isLowestPoint);
        tipPos = seated.point;
        tipNormal = seated.normal;
    }

    // Determine preset band for analytics.
    const area = candidate.islandAreaMm2;
    const preset = area <= 0.15 ? 'detail' as const : area <= 0.50 ? 'structure' as const : 'anchor' as const;
    const crossReject = {
        kind: 'reject', rejectedReason: 'cross_model_collision' as RejectReason, preset, detail: 'CROSS_MODEL_COLLISION',
    };
    // Vertical / grid-routed trunks drop straight down from the tip, so a tip
    // near the plate edge can put the root pad (and the raft around it) off-plate.
    const offPlateReject = {
        kind: 'reject', rejectedReason: 'off_plate' as RejectReason, preset, detail: 'ROOT_OFF_PLATE',
    };
    const rootOffPlate = (root: Roots) =>
        !isRootWithinPlate(root.transform.pos.x, root.transform.pos.y, root.diameter / 2);

    // ── Gridless merge check ──────────────────────────────────────
    if (!supportSettings.grid?.enabled) {
        const host = findMergeHost(tipPos, candidate.modelId);
        if (host) {
            // Find the best attachment point on the host trunk's shaft,
            // below the candidate's tip.  This matches the W-key sprout
            // behaviour: leaves/branches fan from the shaft body, not
            // from the contact tip.
            const hostTrunk = snapshot.trunks[host.trunkId];
            let bestKnotPos: { x: number; y: number; z: number } | null = null;
            let bestKnotSegmentId = '';

            // Best attachment: the junction where the shaft meets the
            // contact cone — the topJoint of the topmost segment.
            // For straight trunks this is just below the tip; for routed
            // trunks it's the socket joint before the cone.
            if (hostTrunk && hostTrunk.segments.length > 0) {
                const topSeg = hostTrunk.segments[hostTrunk.segments.length - 1];
                const jp = topSeg.topJoint?.pos;
                if (jp && jp.z < tipPos.z) {
                    bestKnotPos = jp;
                    bestKnotSegmentId = topSeg.id;
                }
            }
            // Fallback: any shaft joint below the tip.
            if (!bestKnotPos && hostTrunk) {
                for (const seg of hostTrunk.segments) {
                    const jp = seg.bottomJoint?.pos ?? seg.topJoint?.pos;
                    if (jp && jp.z < tipPos.z) {
                        if (!bestKnotPos || jp.z > bestKnotPos.z) {
                            bestKnotPos = jp;
                            bestKnotSegmentId = seg.id;
                        }
                    }
                }
            }
            const knotPos = bestKnotPos ?? host.tipPos;
            let knotDiameter = 1.0;
            if (hostTrunk && bestKnotSegmentId) {
                const seg = hostTrunk.segments.find(s => s.id === bestKnotSegmentId);
                if (seg?.diameter) knotDiameter = seg.diameter;
            }
            const parentKnot = {
                id: uniqueKnotId(`auto-merge-${candidate.id}`),
                parentShaftId: bestKnotSegmentId || host.trunkId,
                pos: knotPos,
                diameter: knotDiameter + 0.1,
            };
            // Leaf decision: use tip-to-tip distance (host contact cone →
            // candidate tip), not shaft-knot distance.  This is the visual
            // span the leaf would bridge.
            const hostTip = hostTrunk?.contactCone?.pos ?? knotPos;
            const tipSpanMm = Math.sqrt(
                (tipPos.x - hostTip.x) ** 2 +
                (tipPos.y - hostTip.y) ** 2 +
                (tipPos.z - hostTip.z) ** 2,
            );
            const MAX_AUTO_LEAF_SPAN_MM = AUTO_LEAF_MAX_SPAN_MM;
            const leafAngleDeg = angleFromVerticalDeg(knotPos, tipPos);
            if (tipSpanMm <= MAX_AUTO_LEAF_SPAN_MM && leafAngleDeg > AUTO_ATTACH_MAX_ANGLE_DEG) {
                console.log(LOG_PREFIX,
                    `Leaf (merge) ${candidate.id}: too inclined (${leafAngleDeg.toFixed(0)}° > ${AUTO_ATTACH_MAX_ANGLE_DEG}°), standalone trunk instead`);
            } else if (tipSpanMm <= MAX_AUTO_LEAF_SPAN_MM) {
                // Knot attachment is on the shaft; angle check uses the
                // actual knot-to-tip geometry for the leaf cone.
                const hDist = Math.sqrt(
                    (tipPos.x - knotPos.x) ** 2 + (tipPos.y - knotPos.y) ** 2,
                );
                const vDist = tipPos.z - knotPos.z;
                if (vDist <= 0) {
                    console.log(LOG_PREFIX,
                        `Merge skip ${candidate.id}: knot above tip (kZ=${knotPos.z.toFixed(1)} tZ=${tipPos.z.toFixed(1)})`);
                } else if (vDist < 1.5) {
                    // Too shallow — fall through to branch.
                    console.log(LOG_PREFIX,
                        `Leaf (merge) ${candidate.id}: too shallow (vDist=${vDist.toFixed(1)}mm), trying branch...`);
                } else {
                    try {
                        const { leaf, supportData: sd } = buildLeafData({
                            tipPos,
                            surfaceNormal: tipNormal,
                            modelId: candidate.modelId,
                            parentKnot,
                            hostDiameterMm: parentKnot.diameter ?? 1.0,
                            mesh,
                            contactDiameterMm: modelCtx?.minTipContactMm,
                        });
                        if (sd.error) {
                            console.log(LOG_PREFIX,
                                `Leaf (merge) ${candidate.id}: sd.error, trying branch...`);
                        } else if (mesh && leafConeCollides(parentKnot.pos, leaf.contactCone, mesh)) {
                            console.log(LOG_PREFIX,
                                `Leaf (merge) ${candidate.id}: triangle collision, trying branch...`);
                        } else if (collidesWithOtherModels(leafCapsules(parentKnot.pos, leaf.contactCone), candidate.modelId)) {
                            console.log(LOG_PREFIX,
                                `Leaf (merge) ${candidate.id}: runs through another model, trying branch...`);
                        } else {
                            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                            if (isTrunkAtAttachmentCapacity(host.trunkId, cap)) {
                                console.log(LOG_PREFIX,
                                    `Merge skip ${candidate.id}: host ${host.trunkId} at capacity (${cap} attachments)`);
                                // fall through to standalone trunk
                            } else {
                                addKnot(parentKnot);
                                addLeaf(leaf);
                                const la = (Math.atan2(hDist, vDist) * 180) / Math.PI;
                                console.log(LOG_PREFIX,
                                    `Leaf (merge) ${candidate.id} → host ${host.trunkId} ` +
                                    `span=${tipSpanMm.toFixed(1)}mm angle=${la.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                                return { kind: 'leaf', preset };
                            }
                        }
                    } catch (_) {}
                }
            } else if (tipSpanMm > MAX_AUTO_LEAF_SPAN_MM) {
                // Branch: requires upward angle from knot to tip.
                const hDist2 = Math.sqrt(
                    (tipPos.x - knotPos.x) ** 2 + (tipPos.y - knotPos.y) ** 2,
                );
                const vDist2 = tipPos.z - knotPos.z;
                const mergeAngleDeg = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                if (mergeAngleDeg > AUTO_ATTACH_MAX_ANGLE_DEG) {
                    console.log(LOG_PREFIX,
                        `Merge skip ${candidate.id}: angle too steep (${mergeAngleDeg.toFixed(0)}° > ${AUTO_ATTACH_MAX_ANGLE_DEG}°) span=${tipSpanMm.toFixed(1)}mm`);
                } else try {
                    const { branch, supportData: sd } = buildBranchData({
                        tipPos, tipNormal, modelId: candidate.modelId, parentKnot, mesh,
                    });
                    const collides = sd.error || (mesh && branchCollidesWithSDF(branch, mesh))
                        || collidesWithOtherModels(
                            shaftEntityCapsules(branch.segments, branch.contactCone, parentKnot.pos), candidate.modelId);
                    if (collides) {
                        console.log(LOG_PREFIX, `Branch (merge) ${candidate.id}: collision, falling back`);
                    } else {
                        const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
                        if (isTrunkAtAttachmentCapacity(host.trunkId, cap)) {
                            console.log(LOG_PREFIX,
                                `Merge skip ${candidate.id}: host ${host.trunkId} at capacity (${cap} attachments)`);
                            // fall through to standalone trunk
                        } else {
                            addKnot(parentKnot);
                            addBranch(branch);
                            const ma = (Math.atan2(hDist2, vDist2) * 180) / Math.PI;
                            console.log(LOG_PREFIX,
                                `Branch (merge) ${candidate.id} → host ${host.trunkId} ` +
                                `span=${tipSpanMm.toFixed(1)}mm angle=${ma.toFixed(0)}° kZ=${knotPos.z.toFixed(1)}`);
                            return { kind: 'branch', preset };
                        }
                    }
                } catch (e) {
                    console.log(LOG_PREFIX,
                        `Merge branch failed for ${candidate.id}, falling back to trunk: ` +
                        `${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }
    }

    // Dynamic physics-based sizing using model context + user settings.
    let overrides = sizeParameters(candidate, modelCtx, supportSettings, totalArea);

    // Cone axis: the clamped surface normal first; when that cone cuts the
    // part, straighten it toward vertical (a vertical cone clears a lip).
    const coneAxes = [tipNormal, clampConeAxis(tipNormal, 20), { x: 0, y: 0, z: -1 }];
    let trunkResult!: ReturnType<typeof buildTrunkData>;
    for (const axis of coneAxes) {
        tipNormal = axis;
        trunkResult = buildTrunkData({
            tipPos,
            tipNormal,
            modelId: candidate.modelId,
            mesh,
            overrides,
            isPreview: false,
        });
        if (!trunkResult.error && trunkConeTooTilted(trunkResult)) {
            trunkResult = { ...trunkResult, error: 'COLLISION_WITH_MODEL' };
        }
        if (!trunkResult.error && coneCutsModel(trunkCapsulesOf(trunkResult), mesh)) {
            trunkResult = { ...trunkResult, error: 'COLLISION_WITH_MODEL' };
            continue;
        }
        break;
    }
    // The model-level tip minimum widens the contact disk; in a tight spot
    // (a slot, a lip next to a wall) that wider disk can clip the model and
    // the whole support is lost. A thinner tip beats no support: retry with
    // the island-sized tip before falling back further.
    if (trunkResult.error === 'COLLISION_WITH_MODEL' && modelCtx?.minTipContactMm) {
        const islandSized = sizeParameters(candidate, { ...modelCtx, minTipContactMm: undefined }, supportSettings, totalArea);
        if ((islandSized.tipContactDiameterMm ?? 0) < (overrides.tipContactDiameterMm ?? 0)) {
            const retry = buildTrunkData({
                tipPos, tipNormal, modelId: candidate.modelId, mesh, overrides: islandSized, isPreview: false,
            });
            if (!retry.error && !trunkConeTooTilted(retry) && !coneCutsModel(trunkCapsulesOf(retry), mesh)) {
                overrides = islandSized;
                trunkResult = retry;
            }
        }
    }

    if (trunkResult.error) {
        // Cavity fallback: if the trunk can't reach the build plate, try
        // bridging to a lower surface with a Stick (model-to-model).
        if (trunkResult.error === 'COLLISION_WITH_MODEL' && mesh) {
            if (autoSettings.allowModelToModelSticks) {
                // A model-to-model Stick/Twig is genuinely useful for a trapped
                // overhang (e.g. hair strands caged above shoulders), but it marks
                // BOTH surfaces it touches. When the vertical gap it bridges is tiny
                // — the die case, where the overhang sits a fraction of a mm above
                // the surface below — the stick holds nothing and just scars the
                // print. Require a minimum vertical span so only load-bearing
                // bridges survive; shorter ones return null and fall through to the
                // escape trunk (reaches the plate) or a clean rejection.
                const cavityResult = buildCavityStick(
                    tipPos, tipNormal, candidate.modelId, mesh, MIN_MODEL_TO_MODEL_Z_SPAN_MM,
                );
                if (cavityResult && cavityResult.kind === 'stick' && collidesWithOtherModels(
                    stickCapsules(cavityResult.stick.segments, cavityResult.stick.contactConeA, cavityResult.stick.contactConeB),
                    candidate.modelId,
                )) {
                    console.log(LOG_PREFIX, `Stick (cavity) ${candidate.id}: runs through another model, skipped`);
                } else if (cavityResult) {
                    if (cavityResult.kind === 'stick') {
                        addStick(cavityResult.stick);
                        console.log(LOG_PREFIX,
                            `Stick (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                        return { kind: 'stick', preset };
                    } else {
                        addTwig(cavityResult.twig);
                        console.log(LOG_PREFIX,
                            `Twig (cavity) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                        return { kind: 'twig', preset };
                    }
                }
            }
            // Angled-escape trunk (independent of the stick setting — it lands
            // on the plate, not on the model): tilt the shaft outward to clear the model and
            // reach the plate where a vertical/A*-routed trunk could not.
            const escape = buildEscapeTrunkData({
                tipPos, tipNormal, modelId: candidate.modelId, mesh, overrides, isPreview: false,
            });
            if (!escape.error && !trunkConeTooTilted(escape) && !coneCutsModel(trunkCapsulesOf(escape), mesh) && !rootOffPlate(escape.root) && !collidesWithOtherModels(trunkCapsulesOf(escape), candidate.modelId)) {
                addRoot(escape.root);
                addTrunk(escape.trunk);
                console.log(LOG_PREFIX,
                    `Escape trunk (tilted) ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
                return { kind: 'trunk', preset, entityId: escape.trunk.id };
            }
        }
        console.log(LOG_PREFIX,
            `Rejected ${candidate.id} (${candidate.source}): trunk build error "${trunkResult.error}" ` +
            `tip=(${tipPos.x.toFixed(1)},${tipPos.y.toFixed(1)},${tipPos.z.toFixed(1)}) ` +
            `normal=(${tipNormal.x.toFixed(2)},${tipNormal.y.toFixed(2)},${tipNormal.z.toFixed(2)})`);
        return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, detail: trunkResult.error };
    }

    // Route through the standard grid placement engine.
    // This handles grid snapping, SDF collision checks, host-trunk
    // attachment (branch/leaf), anchor short-circuit, and rejection.
    const decision = decideGridPlacement({
        settings: supportSettings,
        snapshot,
        candidate: trunkResult,
        tipPos,
        tipNormal,
        modelId: candidate.modelId,
        mesh,
    });

    switch (decision.kind) {
        case 'place_trunk': {
            if (rootOffPlate(decision.trunkBuild.root)) return offPlateReject;
            if (trunkConeTooTilted(decision.trunkBuild)) {
                return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, detail: 'CONE_TOO_TILTED' };
            }
            if (coneCutsModel(trunkCapsulesOf(decision.trunkBuild), mesh)) {
                return { kind: 'reject', rejectedReason: 'grid_reject_collision', preset, detail: 'CONE_THROUGH_MODEL' };
            }
            if (collidesWithOtherModels(trunkCapsulesOf(decision.trunkBuild), candidate.modelId)) return crossReject;
            const trunkId = decision.trunkBuild.trunk.id;
            addRoot(decision.trunkBuild.root);
            addTrunk(decision.trunkBuild.trunk);
            console.log(LOG_PREFIX,
                `Trunk ${candidate.id} (→ ${trunkId}) @ grid ${decision.nodeKey} ` +
                `area=${candidate.islandAreaMm2.toFixed(2)}mm² Z=${candidate.zHeight.toFixed(1)}mm ${preset}`);
            return { kind: 'trunk', preset, entityId: trunkId };
        }

        case 'place_anchor':
            if (collidesWithOtherModels(
                shaftEntityCapsules(decision.anchor.segments, decision.anchor.contactCone, decision.anchor.joint?.pos),
                candidate.modelId,
            )) return crossReject;
            addAnchor(decision.anchor);
            console.log(LOG_PREFIX, `Anchor ${candidate.id} Z=${candidate.zHeight.toFixed(1)}mm`);
            return { kind: 'anchor', preset };

        case 'place_branch': {
            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
            if (isTrunkAtAttachmentCapacity(decision.hostTrunkId, cap)) {
                console.log(LOG_PREFIX,
                    `Grid skip ${candidate.id}: host ${decision.hostTrunkId} at capacity (${cap})`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset };
            }
            const branchCaps = shaftEntityCapsules(decision.branch.segments, decision.branch.contactCone, decision.knot.pos);
            if (coneCutsModel(branchCaps, mesh)) {
                return { kind: 'reject', rejectedReason: 'grid_reject_collision', preset, detail: 'CONE_THROUGH_MODEL' };
            }
            if (collidesWithOtherModels(branchCaps, candidate.modelId)) return crossReject;
            addKnot(decision.knot);
            addBranch(decision.branch);
            console.log(LOG_PREFIX,
                `Branch ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'branch', preset };
        }

        case 'place_leaf': {
            const cap = supportSettings.autoSupport?.maxAttachmentsPerTrunk ?? 12;
            if (isTrunkAtAttachmentCapacity(decision.hostTrunkId, cap)) {
                console.log(LOG_PREFIX,
                    `Grid skip ${candidate.id}: host ${decision.hostTrunkId} at capacity (${cap})`);
                return { kind: 'reject', rejectedReason: 'grid_reject_other', preset };
            }
            if (coneCutsModel(leafCapsules(decision.knot.pos, decision.leaf.contactCone), mesh)) {
                return { kind: 'reject', rejectedReason: 'grid_reject_collision', preset, detail: 'CONE_THROUGH_MODEL' };
            }
            if (collidesWithOtherModels(leafCapsules(decision.knot.pos, decision.leaf.contactCone), candidate.modelId)) {
                return crossReject;
            }
            addKnot(decision.knot);
            addLeaf(decision.leaf);
            console.log(LOG_PREFIX,
                `Leaf ${candidate.id} → host ${decision.hostTrunkId} ` +
                `grid ${decision.nodeKey}`);
            return { kind: 'leaf', preset };
        }

        case 'replace_trunk':
            if (rootOffPlate(decision.trunkBuild.root)) return offPlateReject;
            if (trunkConeTooTilted(decision.trunkBuild)) {
                return { kind: 'reject', rejectedReason: 'trunk_build_error', preset, detail: 'CONE_TOO_TILTED' };
            }
            if (coneCutsModel(trunkCapsulesOf(decision.trunkBuild), mesh)) {
                return { kind: 'reject', rejectedReason: 'grid_reject_collision', preset, detail: 'CONE_THROUGH_MODEL' };
            }
            if (collidesWithOtherModels(trunkCapsulesOf(decision.trunkBuild), candidate.modelId)) return crossReject;
            // The old trunk gets removed by the caller (or we accept overwrite).
            // For now: add the new trunk and root.  The old trunk's root is
            // implicitly replaced because we overwrite the grid node.
            addRoot(decision.trunkBuild.root);
            addTrunk(decision.trunkBuild.trunk);
            console.log(LOG_PREFIX,
                `Replace trunk @ ${decision.nodeKey}: ` +
                `${candidate.id} (Z=${candidate.zHeight.toFixed(1)}) → host ${decision.hostTrunkId}`);
            return { kind: 'trunk', preset, entityId: decision.trunkBuild.trunk.id };

        case 'reject': {
            const reason: RejectReason =
                decision.reason === 'COLLISION_WITH_MODEL' ? 'grid_reject_collision' :
                decision.reason === 'NO_VALID_ATTACHMENT' || decision.reason === 'KNOT_ABOVE_TIP' ? 'grid_reject_no_attachment' :
                'grid_reject_other';
            console.log(LOG_PREFIX, `Rejected ${candidate.id}: ${decision.reason} (grid ${decision.nodeKey})`);
            return { kind: 'reject', rejectedReason: reason, preset };
        }
    }
}

// ---------------------------------------------------------------------------
// runAutoPlace
// ---------------------------------------------------------------------------

/**
 * Run the complete auto-support pipeline using the standard placement engine.
 *
 * Each candidate is individually routed through
 * {@link decideGridPlacement}, the same function used by manual support
 * placement.  This guarantees that SDF collision checks, grid snapping,
 * host-trunk attachment rules, and anchor/branch/leaf auto-selection are
 * identical to the manual workflow.
 *
 * Candidates are processed in priority order (largest / lowest islands
 * first).  Because the state snapshot is refreshed after every commit,
 * later candidates see the supports placed by earlier ones, enabling
 * organic tree fan-out via grid occupancy — a subsequent candidate whose
 * preferred grid node is already occupied will automatically become a
 * branch or leaf of the existing trunk.
 */
/** Actual solid volume of a mesh in world mm³ (signed-tetrahedron sum × scale³). */
/** Share of candidates expected to end up as real contacts (sizing estimate). */
const EXPECTED_PLACED_FRACTION = 0.5;
/** Z step between sampled cross-sections (mm). */
const SECTION_STEP_MM = 0.5;

/**
 * Largest horizontal cross-section area of the mesh (world space, mm²), i.e.
 * the biggest layer that will be peeled off the FEP. One pass over the
 * triangles: each one adds its slice segment's shoelace term to every sampled Z
 * it spans; segments are oriented by the triangle normal, so holes subtract and
 * the sum is the enclosed area without stitching loops.
 */
export function computeMaxCrossSectionMm2(mesh: THREE.Mesh): number {
    let max = 0;
    for (const a of crossSectionAreasMm2(mesh)) if (a > max) max = a;
    return max;
}

/** Cross-section area (mm²) every SECTION_STEP_MM from the mesh bottom up. */
export function crossSectionAreasMm2(mesh: THREE.Mesh): Float64Array {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    if (!pos) return new Float64Array(0);
    mesh.updateMatrixWorld(true);
    const m = mesh.matrixWorld;
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const box = new THREE.Box3().setFromObject(mesh);
    const z0 = box.min.z;
    const n = Math.max(1, Math.ceil((box.max.z - z0) / SECTION_STEP_MM));
    const area = new Float64Array(n);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();
    const vx = [0, 0, 0], vy = [0, 0, 0], vz = [0, 0, 0];

    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        nrm.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        vx[0] = a.x; vx[1] = b.x; vx[2] = c.x;
        vy[0] = a.y; vy[1] = b.y; vy[2] = c.y;
        vz[0] = a.z; vz[1] = b.z; vz[2] = c.z;
        const zmin = Math.min(a.z, b.z, c.z), zmax = Math.max(a.z, b.z, c.z);
        const kFrom = Math.max(0, Math.ceil((zmin - z0) / SECTION_STEP_MM - 1e-9));
        const kTo = Math.min(n - 1, Math.floor((zmax - z0) / SECTION_STEP_MM));
        for (let k = kFrom; k <= kTo; k++) {
            const z = z0 + k * SECTION_STEP_MM + 1e-6;
            const px: number[] = [], py: number[] = [];
            for (let e = 0; e < 3; e++) {
                const f = (e + 1) % 3;
                const za = vz[e], zb = vz[f];
                if ((za < z) === (zb < z)) continue;
                const s = (z - za) / (zb - za);
                px.push(vx[e] + s * (vx[f] - vx[e]));
                py.push(vy[e] + s * (vy[f] - vy[e]));
            }
            if (px.length !== 2) continue;
            let x1 = px[0], y1 = py[0], x2 = px[1], y2 = py[1];
            // Orient so the outward normal is on the right of (p1 → p2).
            if ((y2 - y1) * nrm.x - (x2 - x1) * nrm.y < 0) {
                [x1, x2] = [x2, x1];
                [y1, y2] = [y2, y1];
            }
            area[k] += (x1 * y2 - x2 * y1) * 0.5;
        }
    }
    for (let k = 0; k < n; k++) area[k] = Math.abs(area[k]);
    return area;
}

function computeMeshVolumeMm3(mesh: THREE.Mesh): number {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    if (!pos) return 0;
    const index = geom.index;
    let sixV = 0;
    const tet = (ia: number, ib: number, ic: number) => {
        const x1 = pos.getX(ia), y1 = pos.getY(ia), z1 = pos.getZ(ia);
        const x2 = pos.getX(ib), y2 = pos.getY(ib), z2 = pos.getZ(ib);
        const x3 = pos.getX(ic), y3 = pos.getY(ic), z3 = pos.getZ(ic);
        sixV += x1 * (y2 * z3 - z2 * y3) - y1 * (x2 * z3 - z2 * x3) + z1 * (x2 * y3 - y2 * x3);
    };
    if (index) {
        for (let i = 0; i < index.count; i += 3) tet(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    } else {
        for (let i = 0; i < pos.count; i += 3) tet(i, i + 1, i + 2);
    }
    const localVol = Math.abs(sixV) / 6;
    const s = new THREE.Vector3();
    mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    return localVol * Math.abs(s.x * s.y * s.z);
}

export function runAutoPlace(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
): AutoPlaceResult {
    resetSeatingStats();
    // ------------------------------------------------------------------
    // 0. Settings
    // ------------------------------------------------------------------

    const autoSettings = normalizeAutoSupportSettings(settingsOverride ?? undefined);

    if (!autoSettings.enabled) {
        return makeResult(0, 0, 0, 0, 0, 0, false, 'Auto-support is disabled.');
    }

    const beforeSnapshot = getSnapshot();

    // ------------------------------------------------------------------
    // 1. Generate candidates
    // ------------------------------------------------------------------

    console.log(LOG_PREFIX, `Input: ${islands.length} islands from scan`);

    let candidates = generateCandidates(islands, autoSettings);
    candidates = candidates.map((c): CandidatePoint => ({ ...c, modelId }));

    // Overhang surface sampling — broad down-facing faces the island detector
    // misses (islands only flag failures, not layer-supported overhangs that
    // still need holding). These candidates are already on the mesh surface.
    const meshForOverhang = getModelMesh(modelId) ?? undefined;
    if (autoSettings.overhangSamplingEnabled && meshForOverhang) {
        const overhang = generateOverhangCandidates(meshForOverhang, autoSettings, modelId);
        console.log(LOG_PREFIX, `Overhang sampling: +${overhang.length} candidates ` +
            `(angle<${autoSettings.overhangAngleThresholdDeg}°, spacing ${autoSettings.overhangSpacingMm}mm)`);
        candidates = candidates.concat(overhang);
    }

    console.log(LOG_PREFIX,
        `Step 1/3: ${candidates.length} candidates generated ` +
        `(filtered from ${islands.length} islands, min area ${autoSettings.minIslandAreaMm2}mm²)`);

    if (candidates.length === 0) {
        return makeResult(0, 0, 0, 0, 0, 0, false, 'No viable support candidates found.');
    }

    // ------------------------------------------------------------------
    // 2. Deduplicate
    // ------------------------------------------------------------------

    const beforeDedup = candidates.length;
    candidates = deduplicateCandidates(candidates, autoSettings);

    console.log(LOG_PREFIX,
        `Step 2/3: ${candidates.length} candidates after dedup ` +
        `(removed ${beforeDedup - candidates.length} within ${autoSettings.tipInfluenceRadiusMm}mm radius)`);

    if (candidates.length === 0) {
        return makeResult(0, 0, 0, 0, 0, 0, false, 'All candidates deduplicated — nothing to place.');
    }

    // ------------------------------------------------------------------
    // 2b. Filter out already-supported positions
    // ------------------------------------------------------------------

    // Guarantee the model's lowest point(s) get supported — the critical print
    // anchors. Triangle-centroid overhang sampling never lands on the down-pointing
    // vertex, so add explicit anchor candidates and process them FIRST (prepend),
    // before neighbours occupy the grid. Without this the lowest point can be left
    // unsupported, making the part impossible to print.
    const anchorMesh = getModelMesh(modelId);
    if (anchorMesh) {
        const anchors = generateLowestPointCandidates(anchorMesh, modelId, 5, 2)
            .map((c): CandidatePoint => ({ ...c, modelId }));
        if (anchors.length > 0) {
            candidates = [...anchors, ...candidates];
            console.log(LOG_PREFIX, `Lowest-point anchors: +${anchors.length} (critical print anchors)`);
        }
    }

    const beforeSupportFilter = candidates.length;
    candidates = filterAlreadySupported(candidates);
    console.log(LOG_PREFIX,
        `Step 2b: ${candidates.length} candidates after support filter ` +
        `(removed ${beforeSupportFilter - candidates.length} already supported within ${ALREADY_SUPPORTED_RADIUS_MM}mm)`);

    if (candidates.length === 0) {
        return makeResult(0, 0, 0, 0, 0, 0, false,
            'All candidate positions already have supports.');
    }

    // ------------------------------------------------------------------
    // 3. Place candidates through the standard pipeline
    // ------------------------------------------------------------------
    // Each candidate goes through resolveNormal → buildTrunkData →
    // decideGridPlacement.  State is committed after each placement so
    // subsequent candidates see existing supports (enabling organic
    // tree fan-out via grid occupancy).

    const mesh: THREE.Mesh | undefined = getModelMesh(modelId) ?? undefined;
    if (mesh) mesh.updateMatrixWorld();
    console.log(LOG_PREFIX,
        `Mesh for ${modelId}: ${mesh ? 'available (pathfinding + SDF active)' : 'UNAVAILABLE (supports route straight, no collision avoidance)'}`);



    const gridEnabled = getSettings().grid?.enabled;
    console.log(LOG_PREFIX,
        `Grid mode: ${gridEnabled ? 'ENABLED (supports share grid nodes, branch/leaf fan-out active)' : 'DISABLED (all supports become standalone trunks)'}`);

    // ── Model sizing context ────────────────────────────────────────
    // Pre-sort candidates by Z for weight distribution counting.
    const sortedByZ = [...candidates].sort((a, b) => a.zHeight - b.zHeight);
    const belowCount = new Map<string, number>();
    for (let i = 0; i < sortedByZ.length; i++) {
        belowCount.set(sortedByZ[i].id, i + 1);
    }

    let modelCtx: ModelSizingContext | undefined;
    if (mesh) {
        modelCtx = {
            // ACTUAL mesh volume, not the bounding-box volume. For a tilted model
            // the bbox can be several times the real volume, which over-estimates
            // weight and inflates every support's shaft diameter (→ fat trunks
            // whose contact cones then penetrate the model). Volume is rotation-
            // invariant, so this also makes sizing independent of orientation.
            modelVolumeMm3: computeMeshVolumeMm3(mesh),
            modelZMaxMm: new THREE.Box3().setFromObject(mesh).max.z,
            totalCandidates: candidates.length,
            candidatesBelowZ: 0, // placeholder — filled per-candidate below
        };
        modelCtx.maxCrossSectionMm2 = computeMaxCrossSectionMm2(mesh);
        // Not every candidate ends up placed (rejects, merges): count on
        // about half of them actually holding the part (the hollow sides: 142/286).
        modelCtx.minTipContactMm = requiredTipContactDiameterMm(
            modelCtx.maxCrossSectionMm2,
            Math.max(8, candidates.length * EXPECTED_PLACED_FRACTION),
        );
    }

    let placedTrunks = 0;
    let placedAnchors = 0;
    let placedBranches = 0;
    let placedLeaves = 0;
    let placedSticks = 0;
    let rejectedCount = 0;

    // Analytics accumulators
    const presets = { detail: 0, structure: 0, anchor: 0 };
    const rejectionReasons: Record<string, number> = {};
    const debugRejects: Array<{ id: string; source: string; err: string; z: number; nz: number }> = [];

    // Each support is sized for its OWN contact area only. Previously we summed
    // the areas of every candidate within GRIDLESS_MERGE_RADIUS_MM ("cluster
    // total") and sized every trunk for that — but the code passed it to ALL
    // trunks, including standalone ones (contradicting the documented intent),
    // and the cluster included candidates that end up REJECTED and are never
    // actually supported. In dense regions that inflated the load ~6×, saturating
    // the diameter to the 2mm cap → fat trunks that both reject (can't seed under
    // the model) and let their contact cone penetrate. Sizing on own area lets a
    // trunk that genuinely hosts branches/leaves be re-sized later if needed.

    // Tips placed during THIS run: filterAlreadySupported only sees supports that
    // existed before it, so two near-identical candidates (e.g. the lowest-point
    // anchors) could both become trunks on the very same spot.
    const placedTipKeys = new Set<string>();
    const tipKey = (p: { x: number; y: number; z: number }) =>
        `${Math.round(p.x / DUPLICATE_TIP_MM)},${Math.round(p.y / DUPLICATE_TIP_MM)},${Math.round(p.z / DUPLICATE_TIP_MM)}`;
    const countBefore = (): number => {
        const s0 = getSnapshot();
        return Object.keys(s0.trunks).length + Object.keys(s0.leaves).length + Object.keys(s0.branches).length + Object.keys(s0.anchors).length;
    };

    for (const candidate of candidates) {
        if (placedTipKeys.has(tipKey(candidate.tipPos))) continue;
        try {
            const nBefore = countBefore();
            const ctx: ModelSizingContext | undefined = modelCtx
                ? { ...modelCtx, candidatesBelowZ: belowCount.get(candidate.id) ?? candidates.length }
                : undefined;
            const result = placeOneCandidate(candidate, autoSettings, ctx, candidate.islandAreaMm2);
            if (countBefore() > nBefore) placedTipKeys.add(tipKey(candidate.tipPos));
            switch (result.kind) {
                case 'trunk':   placedTrunks++; break;
                case 'anchor':  placedAnchors++; break;
                case 'branch':  placedBranches++; break;
                case 'leaf':    placedLeaves++; break;
                case 'stick':   placedSticks++; break;
                case 'reject':
                    rejectedCount++;
                    if (result.rejectedReason) {
                        rejectionReasons[result.rejectedReason] = (rejectionReasons[result.rejectedReason] ?? 0) + 1;
                    }
                    debugRejects.push({
                        id: candidate.id,
                        source: candidate.source,
                        err: result.detail ?? result.rejectedReason ?? '?',
                        z: round2(candidate.zHeight),
                        nz: round2(candidate.tipNormal.z),
                    });
                    break;
            }
            if (result.preset) presets[result.preset]++;
        } catch (e) {
            rejectedCount++;
            rejectionReasons['exception'] = (rejectionReasons['exception'] ?? 0) + 1;
            console.warn(LOG_PREFIX,
                `Exception placing ${candidate.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const changed =
        placedTrunks > 0 ||
        placedAnchors > 0 ||
        placedBranches > 0 ||
        placedLeaves > 0 ||
        placedSticks > 0;

    console.log(LOG_PREFIX,
        `Step 3/3: ${placedTrunks}T ${placedAnchors}A ${placedBranches}B ${placedLeaves}L ${placedSticks}S — ${rejectedCount} rejected ` +
        `| presets: detail=${presets.detail} structure=${presets.structure} anchor=${presets.anchor}`);

    // ── Coverage analytics ────────────────────────────────────────
    const snapshot = getSnapshot();
    const supportedIds = new Set<string>();
    // How close a support tip must be to an island to count it "covered" — and,
    // via supportedIds below, which islands the leaf-fanning pass still targets.
    // The UI marks an island supported only when a tip lands within ~0.3–0.6mm of
    // it (tip radius) AND at nearly the same Z (annotateAndCountSupports). A loose
    // 4mm here made the generator declare islands covered when a support merely
    // passed nearby, so leaf-fanning skipped them and the UI then flagged them
    // "unsupported". Keep this tight so every island that lacks an on-surface
    // support gets a leaf fanned directly onto it (leaf tips land AT the island).
    const SUPPORT_COVERAGE_RADIUS_MM = 0.6;
    const covR2 = SUPPORT_COVERAGE_RADIUS_MM * SUPPORT_COVERAGE_RADIUS_MM;

    // Collect all support tips from the post-placement snapshot.
    const allTips: Array<{ x: number; y: number; z: number }> = [];
    for (const t of Object.values(snapshot.trunks)) {
        if (t.contactCone?.pos) allTips.push(t.contactCone.pos);
    }
    for (const b of Object.values(snapshot.branches)) {
        if (b.contactCone?.pos) allTips.push(b.contactCone.pos);
    }
    for (const l of Object.values(snapshot.leaves)) {
        if (l.contactCone?.pos) allTips.push(l.contactCone.pos);
    }
    for (const a of Object.values(snapshot.anchors)) {
        if (a.contactCone?.pos) allTips.push(a.contactCone.pos);
    }

    let coveredArea = 0;
    let totalArea = 0;
    // Coverage is measured on the islands the generator intends to support;
    // skipped sub-resolution noise would otherwise read as "uncovered".
    islands = islands.filter((i) => isIslandWorthSupporting(i, autoSettings));
    for (const island of islands) {
        const area = island.areaMm2 ?? 0;
        totalArea += area;
        const cx = island.contact.x;
        const cy = island.contact.y;
        const cz = island.contact.z;
        let covered = false;
        for (const tip of allTips) {
            const dx = cx - tip.x;
            const dy = cy - tip.y;
            const dz = cz - tip.z;
            if (dx * dx + dy * dy + dz * dz <= covR2) {
                covered = true;
                break;
            }
        }
        if (covered) {
            supportedIds.add(island.id);
            coveredArea += area;
        }
    }

    // ── Sizing debug info ───────────────────────────────────────────
    let sizingDebug: AutoPlaceAnalytics['sizingDebug'];
    if (modelCtx && candidates.length > 0) {
        const weightG = modelCtx.modelVolumeMm3 * 0.0011;
        const areas = candidates.map(c => c.islandAreaMm2);
        areas.sort((a, b) => a - b);
        const minArea = areas[0];
        const maxArea = areas[areas.length - 1];
        const avgArea = areas.reduce((s, a) => s + a, 0) / areas.length;
        const zMax = Math.max(...candidates.map(c => c.zHeight), 1);
        // Sample min/max/avg candidates for shaft diameter range.
        const makeSample = (area: number, z: number): CandidatePoint => ({
            id: 'dbg', tipPos: { x: 0, y: 0, z: 0 }, tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '', source: 'voxel', islandAreaMm2: area,
            zHeight: z, overhangAngleDeg: 45, priority: 0,
        });
        const sMin = sizeParameters(makeSample(minArea, 10), modelCtx, getSettings());
        const sMax = sizeParameters(makeSample(maxArea, zMax), modelCtx, getSettings());
        const sAvg = sizeParameters(makeSample(avgArea, zMax / 2), modelCtx, getSettings());
        sizingDebug = {
            modelVolumeMm3: Math.round(modelCtx.modelVolumeMm3),
            maxCrossSectionMm2: Math.round(modelCtx.maxCrossSectionMm2 ?? 0),
            minTipContactMm: round2(modelCtx.minTipContactMm ?? 0),
            estimatedWeightG: round2(weightG),
            totalCandidates: modelCtx.totalCandidates,
            weightPerSupportG: round2(weightG * (zMax / 2) / zMax), // mid-height support
            avgIslandAreaMm2: round2(avgArea),
            avgPeelForceN: round2(maxArea * 0.2), // worst-case peel force
            shaftDiameterRange: {
                min: round2(sMin.shaftDiameterMm ?? 0),
                max: round2(sMax.shaftDiameterMm ?? 0),
                avg: round2(sAvg.shaftDiameterMm ?? 0),
            },
            tipContactRange: {
                min: round2(sMin.tipContactDiameterMm ?? 0),
                max: round2(sMax.tipContactDiameterMm ?? 0),
                avg: round2(sAvg.tipContactDiameterMm ?? 0),
            },
        };
    }

    const analytics: AutoPlaceAnalytics = {
        islandsCovered: supportedIds.size,
        islandsUncovered: islands.length - supportedIds.size,
        presets,
        rejectionReasons,
        areaCoverage: totalArea > 0 ? coveredArea / totalArea : 0,
        sizingDebug,
    };

    console.log(LOG_PREFIX,
        `Coverage: ${analytics.islandsCovered}/${islands.length} islands (${(analytics.areaCoverage * 100).toFixed(0)}% of area). ` +
        `${analytics.islandsUncovered} islands uncovered.`);

    // ── Post-placement leaf fanning (iterative convergence) ──────────
    const MAX_FANNING_PASSES = 5;
    const SHAFT_SAMPLES_PER_SEGMENT = 5;

    console.log(LOG_PREFIX,
        `Leaf fanning: ${analytics.islandsUncovered} uncovered islands, ${placedTrunks} trunks available. ` +
        `Max ${MAX_FANNING_PASSES} passes, fan radius ${LEAF_FAN_RADIUS_MM}mm, max angle ${LEAF_FAN_MAX_ANGLE_DEG}°.`);

    const fan = { passes: 0, placed: 0, noShaftInRange: 0, noDownFacing: 0, tooShallow: 0, tooSteep: 0, trunkFull: 0, pathBlocked: 0, buildError: 0, coneCollides: 0, otherModel: 0 };
    analytics.fanning = fan;
    analytics.seating = seatingStats; // live: fanned leaves add to it
    for (let pass = 0; pass < MAX_FANNING_PASSES && analytics.islandsUncovered > 0; pass++) {
        fan.passes++;
        const snap = getSnapshot();

        // Collect trunk shaft sample points from the current snapshot.
        const shaftPoints: Array<{
            trunkId: string; pos: { x: number; y: number; z: number }; diameter: number;
        }> = [];
        for (const [tid, trunk] of Object.entries(snap.trunks)) {
            // Only this model's trunks: hosting a leaf on a NEIGHBOUR's trunk
            // bridged models and ran supports straight through them.
            if (trunk.modelId !== modelId) continue;
            for (const seg of trunk.segments) {
                const start = seg.bottomJoint?.pos
                    ?? { x: 0, y: 0, z: 1.5 };
                const end = seg.topJoint?.pos;
                if (!end) continue;
                const diameter = seg.diameter ?? 1.0;
                for (let i = 0; i <= SHAFT_SAMPLES_PER_SEGMENT; i++) {
                    const t = i / SHAFT_SAMPLES_PER_SEGMENT;
                    shaftPoints.push({
                        trunkId: tid,
                        pos: {
                            x: start.x + (end.x - start.x) * t,
                            y: start.y + (end.y - start.y) * t,
                            z: start.z + (end.z - start.z) * t,
                        },
                        diameter,
                    });
                }
            }
        }

        if (shaftPoints.length === 0) {
            console.log(LOG_PREFIX, `Leaf fanning pass ${pass}: no shaft points — breaking.`);
            break;
        }

        const fanR2 = LEAF_FAN_RADIUS_MM * LEAF_FAN_RADIUS_MM;
        const maxAngleRad = (LEAF_FAN_MAX_ANGLE_DEG * Math.PI) / 180;
        let fannedCount = 0;

        let skippedDist = 0;
        let skippedAngle = 0;
        let skippedSameZ = 0;

        for (const island of islands) {
            if (supportedIds.has(island.id)) continue;
            if (!isIslandWorthSupporting(island, autoSettings)) continue;
            const cx = island.contact.x;
            const cy = island.contact.y;
            const cz = island.contact.z;

            // Try shaft points nearest-first. Only the single nearest one used
            // to be tried, so an island next to a wall was dropped whenever that
            // one point was blocked by the model, too steep or on a full trunk,
            // even with a clear trunk a few mm further. The knot must sit BELOW
            // the tip: a leaf hanging down onto a down-facing contact pulls the
            // wrong way.
            const ranked: Array<{ sp: typeof shaftPoints[0]; d2: number }> = [];
            for (const sp of shaftPoints) {
                const dx = cx - sp.pos.x;
                const dy = cy - sp.pos.y;
                const dz = cz - sp.pos.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= fanR2) ranked.push({ sp, d2 });
            }
            if (ranked.length === 0) { skippedDist++; fan.noShaftInRange++; continue; }
            ranked.sort((p, q) => p.d2 - q.d2);

            const leafMesh = getModelMesh(modelId);
            const resolvedRaw = resolveDownFacingContact({ x: cx, y: cy, z: cz }, leafMesh ?? undefined);
            if (!resolvedRaw) { fan.noDownFacing++; continue; }
            const resolved = seatContact(resolvedRaw.point, clampConeAxis(resolvedRaw.normal), modelCtx?.minTipContactMm ?? 0.4, leafMesh ?? undefined, true);
            const tip = resolved.point;

            let tries = 0;
            for (const { sp, d2 } of ranked) {
                if (tries >= LEAF_FAN_MAX_TRIES) break;
                const hDist = Math.sqrt((tip.x - sp.pos.x) ** 2 + (tip.y - sp.pos.y) ** 2);
                const vDist = tip.z - sp.pos.z;
                if (vDist < LEAF_FAN_MIN_DROP_MM) { skippedSameZ++; fan.tooShallow++; continue; }
                const angleFromVertical = Math.atan2(hDist, vDist);
                if (angleFromVertical > maxAngleRad) { skippedAngle++; fan.tooSteep++; continue; }
                if (isTrunkAtAttachmentCapacity(sp.trunkId, autoSettings.maxAttachmentsPerTrunk)) { fan.trunkFull++; continue; }
                tries++;

                // The straight path from knot to tip must be clear of the model.
                if (leafMesh && isShaftBlocked(sp.pos, tip, 0.2, leafMesh)) { fan.pathBlocked++; continue; }

                const parentKnot = {
                    id: uniqueKnotId(`auto-fan-${island.id}-p${pass}`),
                    parentShaftId: sp.trunkId,
                    pos: sp.pos,
                    diameter: sp.diameter + 0.1,
                };
                try {
                    const { leaf, supportData: sd } = buildLeafData({
                        tipPos: tip,
                        surfaceNormal: clampConeAxis(resolved.normal),
                        modelId,
                        parentKnot,
                        hostDiameterMm: sp.diameter,
                        mesh: leafMesh ?? undefined,
                        contactDiameterMm: modelCtx?.minTipContactMm,
                    });
                    if (sd.error) { fan.buildError++; continue; }
                    if (leafMesh && leafConeCollides(parentKnot.pos, leaf.contactCone, leafMesh)) { fan.coneCollides++; continue; }
                    if (collidesWithOtherModels(leafCapsules(parentKnot.pos, leaf.contactCone), modelId)) { fan.otherModel++; continue; }
                    addKnot(parentKnot);
                    fan.placed++;
                    addLeaf(leaf);
                    fannedCount++;
                    supportedIds.add(island.id);
                    coveredArea += (island.areaMm2 ?? 0);
                    console.log(LOG_PREFIX,
                        `Leaf (fan p${pass}) ${island.id} → trunk ${sp.trunkId} ` +
                        `dist=${Math.sqrt(d2).toFixed(1)}mm angle=${(angleFromVertical * 180 / Math.PI).toFixed(0)}°`);
                    break;
                } catch (e) {
                    fan.buildError++;
                    // Leaf build failed — try the next shaft point.
                }
            }
        }

        if (fannedCount > 0) {
            placedLeaves += fannedCount;
            analytics.islandsCovered += fannedCount;
            analytics.islandsUncovered -= fannedCount;
            analytics.areaCoverage = totalArea > 0 ? coveredArea / totalArea : 0;
            console.log(LOG_PREFIX,
                `Leaf fanning pass ${pass}: ${fannedCount} leaves, ` +
                `${analytics.islandsUncovered} islands still uncovered.`);
        } else {
            console.log(LOG_PREFIX,
                `Leaf fanning pass ${pass}: 0 leaves — ` +
                `${skippedDist} too far (>${LEAF_FAN_RADIUS_MM}mm), ` +
                `${skippedAngle} angle too steep (>${LEAF_FAN_MAX_ANGLE_DEG}°), ` +
                `${skippedSameZ} same Z (can't attach).`);
            break;
        }
    }

    // ── Overhang surface coverage ──────────────────────────────────
    // Large flat overhangs need more than one support to distribute
    // peel forces evenly.  Use the island's contactVoxels footprint
    // to place additional supports across the surface.
    const OVERHANG_AREA_THRESHOLD_MM2 = 1.5;
    const OVERHANG_GRID_SPACING_MM = 2.5;
    /** A trunk only spreads extra contacts over the island it was placed for. */
    const OVERHANG_HOST_MATCH_MM = 1.0;

    const islandById = new Map(islands.map(i => [i.id, i]));
    let overhangSupportsPlaced = 0;

    for (const [tid, trunk] of Object.entries(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;
        // Find which island this trunk was placed for by matching tip
        // proximity to island contact positions.
        const tip = trunk.contactCone?.pos;
        if (!tip) continue;
        let bestIsland: DetectedIsland | null = null;
        let bestDist2 = Infinity;
        for (const island of islands) {
            const dx = tip.x - island.contact.x;
            const dy = tip.y - island.contact.y;
            const dz = tip.z - island.contact.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestDist2) { bestDist2 = d2; bestIsland = island; }
        }
        // The nearest island must be the one this trunk actually holds — any
        // trunk used to "adopt" the closest island however far, then fan a grid
        // of branches over it.
        if (!bestIsland || bestDist2 > OVERHANG_HOST_MATCH_MM * OVERHANG_HOST_MATCH_MM) continue;

        const area = bestIsland.areaMm2 ?? 0;
        const voxels = bestIsland.contactVoxels;
        if (area < OVERHANG_AREA_THRESHOLD_MM2 || !voxels || voxels.length < 3) continue;

        // Compute bounding box of contact voxels.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const v of voxels) {
            if (v.x < minX) minX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.x > maxX) maxX = v.x;
            if (v.y > maxY) maxY = v.y;
        }
        const width = maxX - minX;
        const height = maxY - minY;
        if (width < OVERHANG_GRID_SPACING_MM && height < OVERHANG_GRID_SPACING_MM) continue;

        // Place a grid of support points across the footprint.
        const cols = Math.max(2, Math.round(width / OVERHANG_GRID_SPACING_MM));
        const rows = Math.max(2, Math.round(height / OVERHANG_GRID_SPACING_MM));

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const gx = minX + (width * (c + 0.5)) / cols;
                const gy = minY + (height * (r + 0.5)) / rows;

                // Check if this grid point is within the voxel footprint
                // (simple containment: near any contact voxel).
                let inFootprint = false;
                for (const v of voxels) {
                    const dx = gx - v.x;
                    const dy = gy - v.y;
                    if (dx * dx + dy * dy <= OVERHANG_GRID_SPACING_MM * OVERHANG_GRID_SPACING_MM) {
                        inFootprint = true;
                        break;
                    }
                }
                if (!inFootprint) continue;

                // Skip the centroid (already covered by the trunk tip).
                const cDist = (gx - bestIsland.contact.x) ** 2 + (gy - bestIsland.contact.y) ** 2;
                if (cDist < 1.0) continue;

                // Place as a branch from the existing trunk.
                try {
                    const overhangTip = { x: gx, y: gy, z: bestIsland.contact.z };
                    // The grid point sits at the island's base Z; on a sloped
                    // underside the real surface can be a little higher.
                    const resolved = resolveDownFacingContact(overhangTip, mesh, 0.6, 2.0);
                    if (!resolved) continue;
                    const knotPos = trunk.segments[trunk.segments.length - 1]?.topJoint?.pos ?? tip;
                    const parentKnot = {
                        id: uniqueKnotId(`auto-overhang-${bestIsland.id}-${r}-${c}`),
                        parentShaftId: tid,
                        pos: knotPos,
                        diameter: (trunk.segments[trunk.segments.length - 1]?.diameter ?? 1.0) + 0.1,
                    };
                    const bm: THREE.Mesh | undefined = mesh ?? undefined;
                    const { branch, supportData: sd } = buildBranchData({
                        tipPos: resolved.point,
                        tipNormal: resolved.normal,
                        modelId,
                        parentKnot,
                        mesh: bm,
                    });
                    const blocked = sd.error
                        || (bm && branchCollidesWithSDF(branch, bm))
                        || collidesWithOtherModels(shaftEntityCapsules(branch.segments, branch.contactCone, knotPos), modelId);
                    if (!blocked) {
                        const ohCap = autoSettings.maxAttachmentsPerTrunk;
                        if (isTrunkAtAttachmentCapacity(tid, ohCap)) {
                            continue;
                        }
                        addKnot(parentKnot);
                        addBranch(branch);
                        overhangSupportsPlaced++;
                    }
                } catch (_) {
                    // Skip this grid point.
                }
            }
        }

        if (overhangSupportsPlaced > 0) {
            console.log(LOG_PREFIX,
                `Overhang coverage: ${overhangSupportsPlaced} additional branches placed for flat surfaces.`);
        }
    }

    // ── Diagnostics: rejected candidates + still-uncovered islands ──────
    analytics.debug = {
        rejects: debugRejects,
        uncovered: islands
            .filter(i => !supportedIds.has(i.id))
            .map(i => ({
                id: i.id,
                x: round2(i.contact.x),
                y: round2(i.contact.y),
                z: round2(i.contact.z),
                area: round2(i.areaMm2 ?? 0),
            })),
    };

    // ------------------------------------------------------------------
    // 4. Auto-bracing + history
    // ------------------------------------------------------------------

    if (changed) {
        if (!autoSettings.debugSkipAutoBracing) {
            console.log(LOG_PREFIX, 'Running auto-brace...');
            try {
                const braceResult = runAutoBracing();
                console.log(LOG_PREFIX, `Auto-brace: ${braceResult.message}`);
            } catch (e) {
                console.warn(LOG_PREFIX,
                    `Auto-brace failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
            }
        } else {
            console.log(LOG_PREFIX, 'Auto-brace skipped (debug setting).');
        }

        try {
            const afterSnapshot = getSnapshot();
            pushHistory({
                type: SUPPORT_AUTO_PLACE,
                payload: { before: beforeSnapshot, after: afterSnapshot },
            });
            console.log(LOG_PREFIX, 'History entry pushed — undo available.');
        } catch (e) {
            console.warn(LOG_PREFIX,
                `History push failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return {
        ...makeResult(
            placedTrunks,
            placedAnchors,
            placedBranches,
            placedLeaves,
            placedSticks,
            rejectedCount,
            changed,
            `Placed ${placedTrunks} trunks, ${placedAnchors} anchors, ${placedBranches} branches, ${placedLeaves} leaves, ${placedSticks} sticks. ` +
            `${rejectedCount} rejected. Coverage: ${analytics.islandsCovered}/${islands.length} islands (${(analytics.areaCoverage * 100).toFixed(0)}%).`,
        ),
        analytics,
    };
}
