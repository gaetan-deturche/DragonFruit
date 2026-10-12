import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeMaxCrossSectionMm2, crossSectionAreasMm2 } from '../autoPlace';

test('max cross-section of a tilted solid box', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 5));
    mesh.rotation.set(0, 0, 0.7); // turning about Z keeps the 200 mm² section
    mesh.position.set(30, -12, 40);
    const a = computeMaxCrossSectionMm2(mesh);
    assert.ok(Math.abs(a - 200) < 1, `area ${a}`);
});

test('hollow box: the cavity is subtracted', () => {
    const outer = new THREE.BoxGeometry(20, 20, 20);
    const inner = new THREE.BoxGeometry(16, 16, 16);
    // Flip the inner shell so its normals point into the cavity.
    const idx = inner.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
        const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t);
    }
    const geom = mergeGeometries([outer, inner])!;
    const areas = crossSectionAreasMm2(new THREE.Mesh(geom));
    const mid = areas[Math.floor(areas.length / 2)];
    assert.ok(Math.abs(mid - (400 - 256)) < 1, `mid-height area ${mid}`);
    assert.ok(Math.abs(areas[1] - 400) < 1, `floor area ${areas[1]}`); // solid floor (z 0.5)
});
