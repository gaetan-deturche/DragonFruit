/**
 * Contact seating: whether a support tip's contact disk rests fully on the
 * part, and sliding it inward when it straddles an edge.
 */
import * as THREE from 'three';
import { clampConeAxis } from './attachmentLimits';

type V3 = { x: number; y: number; z: number };
const _seatRay = new THREE.Raycaster();
const SEAT_RING_SAMPLES = 8;
/** Ring samples that must find the surface for the tip to count as seated. */
export const SEAT_MIN_HITS = 7;
/** Max surface offset from the contact plane at a ring sample (mm). */
const SEAT_TOLERANCE_MM = 0.3;
/** Ring tolerance when the cone sits in an edge/corner along the bisector (mm). */
const BISECTOR_TOLERANCE_MM = 0.5;
const SEAT_SHIFT_STEPS_MM = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2];

/** Surface hit along `axis` (into the part) through `p`, or null. */
function surfaceAlong(p: V3, axis: V3, mesh: THREE.Mesh, back: number, reach: number): THREE.Intersection | null {
    _seatRay.set(new THREE.Vector3(p.x - axis.x * back, p.y - axis.y * back, p.z - axis.z * back), new THREE.Vector3(axis.x, axis.y, axis.z));
    _seatRay.far = back + reach;
    return _seatRay.intersectObject(mesh, false)[0] ?? null;
}

/** Ring samples around the tip: which ones find the surface near the contact plane. */
export function seatingRing(tip: V3, n: V3, radius: number, mesh: THREE.Mesh, tolerance = SEAT_TOLERANCE_MM): { hits: number; toward: V3 } {
    const axis = { x: -n.x, y: -n.y, z: -n.z };
    const ref = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const a = new THREE.Vector3(axis.x, axis.y, axis.z);
    const u = new THREE.Vector3().crossVectors(a, ref).normalize();
    const v = new THREE.Vector3().crossVectors(a, u).normalize();
    let hits = 0;
    const toward = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < SEAT_RING_SAMPLES; i++) {
        const t = (i / SEAT_RING_SAMPLES) * Math.PI * 2;
        const ox = u.x * Math.cos(t) + v.x * Math.sin(t);
        const oy = u.y * Math.cos(t) + v.y * Math.sin(t);
        const oz = u.z * Math.cos(t) + v.z * Math.sin(t);
        const p = { x: tip.x + ox * radius, y: tip.y + oy * radius, z: tip.z + oz * radius };
        const h = surfaceAlong(p, axis, mesh, 1, tolerance);
        if (h && Math.abs(h.distance - 1) <= tolerance) {
            hits++;
            toward.x += ox; toward.y += oy; toward.z += oz;
        }
    }
    return { hits, toward };
}

/**
 * Outward normals of the faces meeting at the tip, averaged: the bisector of
 * an edge or a corner. Rays aimed at the tip from a fan of outside directions
 * hit whichever face looks their way; null when the tip is on a single face.
 */
function cornerBisector(tip: V3, normal: V3, mesh: THREE.Mesh): V3 | null {
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(n, ref).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    const dirs: THREE.Vector3[] = [n.clone()];
    for (const tilt of [35, 65, 85]) {
        const t = (tilt * Math.PI) / 180;
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            dirs.push(n.clone().multiplyScalar(Math.cos(t))
                .addScaledVector(u, Math.sin(t) * Math.cos(a))
                .addScaledVector(v, Math.sin(t) * Math.sin(a)));
        }
    }
    // Aim just inside the part, not at the tip itself: a ray hitting exactly
    // on the edge reports the same face whatever its direction, while one
    // aimed below it enters through the face that looks its way.
    const target = new THREE.Vector3(tip.x, tip.y, tip.z).addScaledVector(n, -0.08);
    const normals: THREE.Vector3[] = [];
    for (const d of dirs) {
        _seatRay.set(target.clone().addScaledVector(d, 0.7), d.clone().negate());
        _seatRay.far = 0.8;
        const h = _seatRay.intersectObject(mesh, false)[0];
        if (!h?.face) continue;
        if (Math.hypot(h.point.x - tip.x, h.point.y - tip.y, h.point.z - tip.z) > 0.3) continue; // another feature
        const fn = h.face.normal.clone().transformDirection(mesh.matrixWorld);
        if (fn.dot(d) < 0.2) continue;
        if (!normals.some((m) => m.dot(fn) > 0.98)) normals.push(fn);
    }
    if (normals.length < 2) return null;
    const avg = normals.reduce((acc, m) => acc.add(m), new THREE.Vector3()).normalize();
    return { x: avg.x, y: avg.y, z: avg.z };
}

/**
 * Keep the whole contact disk on the surface. The lowest point of an island
 * is usually an edge or a corner (the rim of a groove, the border of a tilted
 * plate): a tip whose cone follows ONE of the faces has half its disk over
 * the void and fuses to a sliver. First keep the tip on the edge and aim the
 * cone along the bisector of the faces, so it bites into the corner and
 * bears on both: the lowest point - the first layer of that region - stays
 * supported (always, for an island's lowest point). Otherwise, when that does not seat, slide the tip inward toward the
 * side where the surface is (which leaves the very corner to print unsupported
 * for a few layers); keep the original contact if no nearby spot is better.
 */
/** Outcome counters of seatContact since the last reset (diagnostics). */
export const seatingStats = { flat: 0, bisector: 0, shifted: 0, unseated: 0 };
export function resetSeatingStats(): void {
    seatingStats.flat = 0; seatingStats.bisector = 0; seatingStats.shifted = 0; seatingStats.unseated = 0;
}

export function seatContact(
    tip: V3,
    normal: V3,
    contactDiameterMm: number,
    mesh: THREE.Mesh | undefined,
    /** The tip is the lowest point of an island: never move it off that point. */
    keepPoint = false,
): { point: V3; normal: V3; shiftedMm: number } {
    const keep = { point: tip, normal, shiftedMm: 0 };
    if (!mesh) return keep;
    mesh.updateMatrixWorld();
    const radius = contactDiameterMm / 2 + 0.05;
    const first = seatingRing(tip, normal, radius, mesh);
    if (first.hits >= SEAT_MIN_HITS) { seatingStats.flat++; return keep; }
    if (first.hits === 0) { seatingStats.unseated++; return keep; }
    const bis = cornerBisector(tip, normal, mesh);
    if (bis && bis.z < -0.05) {
        const nb = clampConeAxis(bis);
        // Faces fall away from the contact plane on every side of an edge or a
        // corner (more at a 3-face corner): what matters is that surface
        // surrounds the disk, within reach of the tip's penetration.
        if (keepPoint || seatingRing(tip, nb, radius, mesh, BISECTOR_TOLERANCE_MM).hits >= SEAT_MIN_HITS) { seatingStats.bisector++; return { point: tip, normal: nb, shiftedMm: 0 }; }
    }
    // An island's lowest point is the first layer of that region: moving the
    // tip off it leaves that layer - and the next ones up to the new contact -
    // printing in the void. Keep it even when the disk is not fully seated.
    if (keepPoint) { seatingStats.unseated++; return keep; }
    const tl = Math.hypot(first.toward.x, first.toward.y, first.toward.z);
    if (tl < 1e-6) { seatingStats.unseated++; return keep; }
    const dir = { x: first.toward.x / tl, y: first.toward.y / tl, z: first.toward.z / tl };
    const axis = { x: -normal.x, y: -normal.y, z: -normal.z };
    for (const step of SEAT_SHIFT_STEPS_MM) {
        const p = { x: tip.x + dir.x * step, y: tip.y + dir.y * step, z: tip.z + dir.z * step };
        const h = surfaceAlong(p, axis, mesh, 1.5, 1.5);
        if (!h || !h.face) continue;
        const fn = h.face.normal.clone().transformDirection(mesh.matrixWorld);
        if (fn.z > -0.05) continue; // slid onto a wall or a top face
        const n2 = clampConeAxis({ x: fn.x, y: fn.y, z: fn.z });
        const pt = { x: h.point.x, y: h.point.y, z: h.point.z };
        if (seatingRing(pt, n2, radius, mesh).hits >= SEAT_MIN_HITS) { seatingStats.shifted++; return { point: pt, normal: n2, shiftedMm: step }; }
    }
    seatingStats.unseated++;
    return keep;
}

/** Whether a placed tip's contact disk is seated: flat on a face, or along the bisector of an edge/corner. */
export function isTipSeated(tip: V3, normal: V3, contactDiameterMm: number, mesh: THREE.Mesh): boolean {
    const radius = contactDiameterMm / 2 + 0.05;
    if (seatingRing(tip, normal, radius, mesh).hits >= SEAT_MIN_HITS) return true;
    if (!cornerBisector(tip, normal, mesh)) return false;
    return seatingRing(tip, normal, radius, mesh, BISECTOR_TOLERANCE_MM).hits >= SEAT_MIN_HITS;
}
