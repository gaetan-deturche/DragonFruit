import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { unsupportedIslandWarnings } from '../autoPlace';
import { setModelMesh } from '../meshStore';
import type { DetectedIsland } from '../../../volumeAnalysis/Islands/types';

const island = (id: string, x: number, y: number, z: number, areaMm2: number): DetectedIsland => ({
    id, source: 'voxel', contact: new THREE.Vector3(x, y, z), baseZ: z, areaMm2,
});

test('an unsupported starting point is always reported', () => {
    // 1.1 × 6 × 9 mm plate standing 5 mm above the plate: lowest point at z = 5.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 6, 9));
    mesh.position.set(9, 0, 9.5);
    mesh.updateMatrixWorld();
    setModelMesh('plate', mesh);
    try {
        const w = unsupportedIslandWarnings([island('v0', 9, 0, 5.02, 0.01)], 'plate');
        assert.equal(w.length, 1);
        assert.match(w[0], /starting point/);
    } finally {
        setModelMesh('plate', null);
    }
});

test('a higher island is reported only when sizeable and far from every tip', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    mesh.position.set(0, 0, 10);
    mesh.updateMatrixWorld();
    setModelMesh('box', mesh);
    try {
        // No supports at all on this model: a 0.5 mm² island at mid-height warns,
        // a 0.01 mm² speck does not.
        assert.equal(unsupportedIslandWarnings([island('a', 0, 0, 10, 0.5)], 'box').length, 1);
        assert.equal(unsupportedIslandWarnings([island('b', 0, 0, 10, 0.01)], 'box').length, 0);
        assert.equal(unsupportedIslandWarnings([], 'box').length, 0);
    } finally {
        setModelMesh('box', null);
    }
});
