import * as THREE from 'three';
import type { CandidatePoint } from './types';
import type { AutoSupportSettings } from './settings';

/**
 * Sample down-facing overhang surfaces of the model and emit evenly-spaced
 * support candidates across them.
 *
 * The island detector only flags *failure* regions (floating voxels, sharp
 * minima). It does not cover broad down-facing faces that, while technically
 * layer-supported, still need holding against peel forces on an elevated part.
 * This pass fills that gap: it walks every triangle, keeps the ones facing
 * downward beyond the configured overhang angle, and buckets their centroids
 * into an XY grid so each column gets one candidate at its lowest point.
 *
 * All coordinates are returned in WORLD space (matrixWorld applied), so the
 * candidates lie exactly on the displayed mesh surface — no snapping needed.
 */
/**
 * The model's lowest point(s) are the critical print anchors: in bottom-up SLA
 * they cure first and the whole part hangs from them, so they MUST be supported
 * or the print detaches. Triangle-centroid overhang sampling never lands on a
 * down-pointing vertex (the centroid always sits above it), so this emits an
 * explicit candidate at every vertex within `bandMm` of the global minimum world
 * Z. Normal points straight down — the space directly below the lowest point of
 * a model is always clear, so a straight trunk to the plate is guaranteed.
 */
export function generateLowestPointCandidates(
    mesh: THREE.Mesh,
    modelId: string,
    bandMm = 0.6,
    spacingMm = 2,
): CandidatePoint[] {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return [];
    mesh.updateMatrixWorld();
    const mw = mesh.matrixWorld;
    const v = new THREE.Vector3();

    let minZ = Infinity;
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        if (v.z < minZ) minZ = v.z;
    }
    if (!isFinite(minZ)) return [];

    const spacing = Math.max(0.5, spacingMm);
    const cells = new Map<string, { x: number; y: number; z: number }>();
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        if (v.z > minZ + bandMm) continue;
        const key = `${Math.round(v.x / spacing)},${Math.round(v.y / spacing)}`;
        const ex = cells.get(key);
        if (!ex || v.z < ex.z) cells.set(key, { x: v.x, y: v.y, z: v.z });
    }

    const out: CandidatePoint[] = [];
    for (const [key, c] of cells) {
        out.push({
            id: `lowest-${modelId}-${key}`,
            tipPos: { x: c.x, y: c.y, z: c.z },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId,
            source: 'minima',
            islandAreaMm2: spacing * spacing * 0.5,
            zHeight: c.z,
            overhangAngleDeg: 180,
            priority: 1000,
        });
    }
    return out;
}

export function generateOverhangCandidates(
    mesh: THREE.Mesh,
    settings: AutoSupportSettings,
    modelId: string,
): CandidatePoint[] {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return [];

    mesh.updateMatrixWorld();
    const mw = mesh.matrixWorld;

    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;

    const thresholdRad = (settings.overhangAngleThresholdDeg * Math.PI) / 180;
    // Support down-faces whose inclination from horizontal is below the
    // threshold, i.e. normal.z < -cos(threshold). (Flat ceiling: nz=-1.)
    const nzCutoff = -Math.cos(thresholdRad);
    const spacing = Math.max(0.5, settings.overhangSpacingMm);
    const GROUND_Z = 0.8; // skip faces essentially on the plate

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const cb = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const normal = new THREE.Vector3();

    type Pt = {
        x: number; y: number; z: number;
        nx: number; ny: number; nz: number;
        area: number;
        incDeg: number;
    };
    // Points are collected per XY column, then split into Z-separated layers so
    // that stacked overhangs (e.g. a bust's hair ABOVE the chest, with air
    // between) each get a candidate. Keeping only the lowest point per column
    // dropped every overhang sitting above a lower one.
    const columns = new Map<string, Pt[]>();

    for (let t = 0; t < triCount; t++) {
        const iA = index ? index.getX(t * 3) : t * 3;
        const iB = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const iC = index ? index.getX(t * 3 + 2) : t * 3 + 2;

        vA.fromBufferAttribute(pos, iA).applyMatrix4(mw);
        vB.fromBufferAttribute(pos, iB).applyMatrix4(mw);
        vC.fromBufferAttribute(pos, iC).applyMatrix4(mw);

        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        normal.crossVectors(cb, ab);
        const doubleArea = normal.length();
        if (doubleArea < 1e-9) continue;
        normal.divideScalar(doubleArea); // normalize
        const area = 0.5 * doubleArea;

        if (normal.z >= nzCutoff) continue; // not a down-facing overhang

        // Centroid (world).
        const cx = (vA.x + vB.x + vC.x) / 3;
        const cy = (vA.y + vB.y + vC.y) / 3;
        const cz = (vA.z + vB.z + vC.z) / 3;
        if (cz < GROUND_Z) continue;

        const gx = Math.round(cx / spacing);
        const gy = Math.round(cy / spacing);
        const key = `${gx},${gy}`;
        const inc = (Math.acos(Math.min(1, Math.max(0, -normal.z))) * 180) / Math.PI;

        const pt: Pt = { x: cx, y: cy, z: cz, nx: normal.x, ny: normal.y, nz: normal.z, area, incDeg: inc };
        const col = columns.get(key);
        if (col) col.push(pt);
        else columns.set(key, [pt]);
    }

    // A vertical gap larger than this between consecutive down-faces in the same
    // column marks a separate overhang (e.g. hair over shoulders). Continuous
    // sloped faces stay a single candidate at their lowest point.
    const LAYER_Z_GAP_MM = 10;

    const candidates: CandidatePoint[] = [];
    for (const [key, pts] of columns) {
        pts.sort((a, b) => a.z - b.z);
        let clusterLow = pts[0];
        let clusterArea = pts[0].area;
        let prevZ = pts[0].z;
        let layer = 0;
        const flush = () => {
            candidates.push({
                id: `overhang-${modelId}-${key}-L${layer}`,
                tipPos: { x: clusterLow.x, y: clusterLow.y, z: clusterLow.z },
                tipNormal: { x: clusterLow.nx, y: clusterLow.ny, z: clusterLow.nz },
                modelId,
                source: 'overhang',
                islandAreaMm2: Math.min(clusterArea, spacing * spacing),
                zHeight: clusterLow.z,
                overhangAngleDeg: clusterLow.incDeg,
                priority: 0,
            });
            layer++;
        };
        for (let i = 1; i < pts.length; i++) {
            if (pts[i].z - prevZ > LAYER_Z_GAP_MM) {
                flush();
                clusterLow = pts[i];
                clusterArea = pts[i].area;
            } else {
                clusterArea += pts[i].area;
            }
            prevZ = pts[i].z;
        }
        flush();
    }
    return candidates;
}
