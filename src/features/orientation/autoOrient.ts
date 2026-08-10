import * as THREE from 'three';

/**
 * Automatic build-orientation (v1) — resin/SLA.
 *
 * Multi-objective build-orientation optimization is well studied: minimize a
 * weighted sum of support amount, build height (time), staircase, and trapped
 * volume over a set of candidate orientations, then pick the minimum
 * (Ezair & Barequet; Guacheta Alba et al.; Cheng et al.). This v1 covers the
 * two dominant, cheap-to-evaluate terms — supported (down-facing) area and
 * build height — and leaves trapped-volume/cupping and cosmetic-face weighting
 * for v2.
 *
 * Speed trick: we never build a rotation matrix per candidate. For a chosen
 * LOCAL down-direction `d` (the model vector that will point at the plate), the
 * post-rotation world normal Z is exactly `-(n · d)` and the world height is the
 * spread of `v · d` — both plain dot products. So hundreds of orientations cost
 * one pass over the (sub-sampled) triangles.
 *
 * Everything is computed in the mesh's LOCAL geometry frame, so the result is an
 * ABSOLUTE orientation independent of the model's current transform.
 */

export interface AutoOrientOptions {
    /** Down-faces more horizontal than this (degrees from horizontal) need support. */
    overhangAngleDeg?: number;
    /** Weight of build height (mm) relative to supported area (mm²) in the cost. */
    heightWeight?: number;
    /** Cap on triangles actually evaluated (sub-sampled above this for big meshes). */
    maxTriangles?: number;
    /** Number of Fibonacci-sphere candidate directions. */
    candidateCount?: number;
    // ── v2: cupping / trapped-volume avoidance ──────────────────────────────
    /** Faces within this angle of horizontal count as flat "cups". */
    flatAngleDeg?: number;
    /** Penalty per mm² of near-flat DOWN-face (suction cup / air trap — the resin
     *  killer during peel). */
    suctionWeight?: number;
    /** Penalty per mm² of near-flat UP-face (resin pool that can't drain). */
    poolWeight?: number;
}

export interface AutoOrientResult {
    /** Rotation to APPLY (radians), in DragonFruit's global-XYZ convention
     *  (set via THREE.Euler order 'ZYX'). */
    rotationRad: { x: number; y: number; z: number };
    /** The local down-direction chosen. */
    downDirLocal: { x: number; y: number; z: number };
    cost: number;
    supportScore: number;
    heightMm: number;
    /** Near-flat down-facing area (suction-cup risk) at the chosen orientation. */
    suctionAreaMm2: number;
    /** Near-flat up-facing area (resin-pool risk) at the chosen orientation. */
    poolAreaMm2: number;
    /** World Z of the lowest vertex once the rotation is applied at unit scale
     *  with the model origin at Z=0. Drop a model to sit `lift` mm above the
     *  plate with:  position.z = lift - scale * restZOffsetMm. */
    restZOffsetMm: number;
    candidatesEvaluated: number;
    trianglesEvaluated: number;
}

interface ModelTransformLike {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
}

export interface OrientableModel {
    id: string;
    transform: ModelTransformLike;
}

export interface ModelOrientationUpdate {
    id: string;
    transform: ModelTransformLike;
    result: AutoOrientResult;
}

/**
 * Orient EACH model independently to its own optimal build orientation. Every
 * mesh is analysed on its own geometry and rotated + dropped to the plate in
 * place (XY kept, so models don't pile onto each other). The caller applies the
 * returned transforms — e.g. via `scene.updateModelTransforms(...)`.
 *
 * This is the correct multi-model behaviour: never rotate the whole set as one
 * rigid group (that would only suit one part and drag the others off-plate).
 */
export function orientModelsIndependently(
    models: OrientableModel[],
    getMesh: (id: string) => THREE.Mesh | null | undefined,
    liftMm: number,
    opts?: AutoOrientOptions,
): ModelOrientationUpdate[] {
    const out: ModelOrientationUpdate[] = [];
    for (const model of models) {
        const mesh = getMesh(model.id);
        if (!mesh) continue;
        const res = computeAutoOrientation(mesh, opts);
        if (!res) continue;
        // Assume ~uniform scale (the common case) for the drop-to-plate offset.
        const s = model.transform.scale.x || 1;
        out.push({
            id: model.id,
            transform: {
                position: new THREE.Vector3(
                    model.transform.position.x,
                    model.transform.position.y,
                    liftMm - s * res.restZOffsetMm,
                ),
                rotation: new THREE.Euler(
                    res.rotationRad.x,
                    res.rotationRad.y,
                    res.rotationRad.z,
                    model.transform.rotation.order,
                ),
                scale: model.transform.scale.clone(),
            },
            result: res,
        });
    }
    return out;
}

/** Even-ish points on the unit sphere. */
function fibonacciSphere(n: number): Array<[number, number, number]> {
    const pts: Array<[number, number, number]> = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = n > 1 ? 1 - (i / (n - 1)) * 2 : 0;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        pts.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
    }
    return pts;
}

export function computeAutoOrientation(
    mesh: THREE.Mesh,
    opts: AutoOrientOptions = {},
): AutoOrientResult | null {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : Math.floor(pos.count / 3);
    if (triCount < 1) return null;

    const cosT = Math.cos(((opts.overhangAngleDeg ?? 45) * Math.PI) / 180);
    const wHeight = opts.heightWeight ?? 4;
    const cosFlat = Math.cos(((opts.flatAngleDeg ?? 20) * Math.PI) / 180);
    const wSuction = opts.suctionWeight ?? 3;
    const wPool = opts.poolWeight ?? 1;
    const maxTris = opts.maxTriangles ?? 120000;
    const stride = Math.max(1, Math.ceil(triCount / maxTris));

    // ── Precompute per-(sampled)triangle normal, area, centroid (LOCAL) ──
    const cap = Math.ceil(triCount / stride);
    const nx = new Float32Array(cap), ny = new Float32Array(cap), nz = new Float32Array(cap);
    const area = new Float32Array(cap);
    const cx = new Float32Array(cap), cy = new Float32Array(cap), cz = new Float32Array(cap);
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const cb = new THREE.Vector3(), ab = new THREE.Vector3(), nrm = new THREE.Vector3();
    let M = 0;
    for (let t = 0; t < triCount; t += stride) {
        const iA = index ? index.getX(t * 3) : t * 3;
        const iB = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const iC = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        vA.fromBufferAttribute(pos, iA);
        vB.fromBufferAttribute(pos, iB);
        vC.fromBufferAttribute(pos, iC);
        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        nrm.crossVectors(cb, ab);
        const dbl = nrm.length();
        if (dbl < 1e-12) continue;
        nx[M] = nrm.x / dbl; ny[M] = nrm.y / dbl; nz[M] = nrm.z / dbl;
        area[M] = 0.5 * dbl * stride; // scale to approximate the skipped triangles' area
        cx[M] = (vA.x + vB.x + vC.x) / 3;
        cy[M] = (vA.y + vB.y + vC.y) / 3;
        cz[M] = (vA.z + vB.z + vC.z) / 3;
        M++;
    }
    if (M < 1) return null;

    // ── Candidate down-directions: Fibonacci sphere + primary axes ──
    const cands = fibonacciSphere(opts.candidateCount ?? 256);
    for (const a of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
        cands.push(a as [number, number, number]);
    }

    let bestCost = Infinity;
    let bestD: [number, number, number] = [0, 0, -1];
    let bestSup = 0, bestH = 0, bestSuction = 0, bestPool = 0;
    const invRange = 1 / Math.max(1e-6, 1 - cosT);

    for (const d of cands) {
        const dx = d[0], dy = d[1], dz = d[2];
        let minP = Infinity, maxP = -Infinity, sup = 0, suction = 0, pool = 0;
        for (let i = 0; i < M; i++) {
            const p = cx[i] * dx + cy[i] * dy + cz[i] * dz;
            if (p < minP) minP = p;
            if (p > maxP) maxP = p;
            // Post-rotation world normal Z is -(n·d): a down-facing overhang has
            // n·d > cos(overhang); a near-flat down-face (suction cup) has
            // n·d > cos(flat); a near-flat up-face (resin pool) has n·d < -cos(flat).
            const ndotd = nx[i] * dx + ny[i] * dy + nz[i] * dz;
            if (ndotd > cosT) sup += area[i] * ((ndotd - cosT) * invRange);
            if (ndotd > cosFlat) suction += area[i];
            else if (ndotd < -cosFlat) pool += area[i];
        }
        const height = maxP - minP;
        const cost = sup + wHeight * height + wSuction * suction + wPool * pool;
        if (cost < bestCost) {
            bestCost = cost; bestD = d; bestSup = sup; bestH = height;
            bestSuction = suction; bestPool = pool;
        }
    }

    // Vertex-accurate lowest point along the chosen build direction, for drop-
    // to-plate. World Z at unit scale = -(v · d), so the lowest vertex sits at
    // -max_v(v · d). Full-resolution pass (not sub-sampled) for exact seating.
    let maxVdotD = -Infinity;
    for (let i = 0; i < pos.count; i++) {
        vA.fromBufferAttribute(pos, i);
        const vd = vA.x * bestD[0] + vA.y * bestD[1] + vA.z * bestD[2];
        if (vd > maxVdotD) maxVdotD = vd;
    }
    const restZOffsetMm = Number.isFinite(maxVdotD) ? -maxVdotD : 0;

    // ── Rotation mapping local down-dir → world -Z (no twist) ──
    const dv = new THREE.Vector3(bestD[0], bestD[1], bestD[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(dv, new THREE.Vector3(0, 0, -1));
    // 'ZYX' euler order encodes DragonFruit's extrinsic global-XYZ convention.
    const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');

    return {
        rotationRad: { x: e.x, y: e.y, z: e.z },
        downDirLocal: { x: dv.x, y: dv.y, z: dv.z },
        cost: bestCost,
        supportScore: bestSup,
        heightMm: bestH,
        suctionAreaMm2: bestSuction,
        poolAreaMm2: bestPool,
        restZOffsetMm,
        candidatesEvaluated: cands.length,
        trianglesEvaluated: M,
    };
}
