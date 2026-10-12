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
const SEAT_SHIFT_STEPS_MM = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2];

/** Surface hit along `axis` (into the part) through `p`, or null. */
function surfaceAlong(p: V3, axis: V3, mesh: THREE.Mesh, back: number, reach: number): THREE.Intersection | null {
    _seatRay.set(new THREE.Vector3(p.x - axis.x * back, p.y - axis.y * back, p.z - axis.z * back), new THREE.Vector3(axis.x, axis.y, axis.z));
    _seatRay.far = back + reach;
    return _seatRay.intersectObject(mesh, false)[0] ?? null;
}

/** Ring samples around the tip: which ones find the surface near the contact plane. */
export function seatingRing(tip: V3, n: V3, radius: number, mesh: THREE.Mesh): { hits: number; toward: V3 } {
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
        const h = surfaceAlong(p, axis, mesh, 1, SEAT_TOLERANCE_MM);
        if (h && Math.abs(h.distance - 1) <= SEAT_TOLERANCE_MM) {
            hits++;
            toward.x += ox; toward.y += oy; toward.z += oz;
        }
    }
    return { hits, toward };
}

/**
 * Keep the whole contact disk on the surface. The lowest point of an island
 * is usually an edge or a corner (the rim of a groove, the border of a tilted
 * plate): a tip placed right on it has half its disk over the void and fuses
 * to a sliver, so the support holds almost nothing. Slide the tip inward,
 * toward the side where the surface is, until the disk is seated; keep the
 * original contact if no nearby spot is better.
 */
export function seatContact(tip: V3, normal: V3, contactDiameterMm: number, mesh: THREE.Mesh | undefined): { point: V3; normal: V3; shiftedMm: number } {
    const keep = { point: tip, normal, shiftedMm: 0 };
    if (!mesh) return keep;
    mesh.updateMatrixWorld();
    const radius = contactDiameterMm / 2 + 0.05;
    const first = seatingRing(tip, normal, radius, mesh);
    if (first.hits >= SEAT_MIN_HITS || first.hits === 0) return keep;
    const tl = Math.hypot(first.toward.x, first.toward.y, first.toward.z);
    if (tl < 1e-6) return keep;
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
        if (seatingRing(pt, n2, radius, mesh).hits >= SEAT_MIN_HITS) return { point: pt, normal: n2, shiftedMm: step };
    }
    return keep;
}
