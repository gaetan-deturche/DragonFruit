import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeParameters, type ModelSizingContext } from '../parameterSizing';
import type { CandidatePoint } from '../types';

const candidate = (zHeight: number, islandAreaMm2 = 1): CandidatePoint => ({
    id: 'c', tipPos: { x: 0, y: 0, z: zHeight }, tipNormal: { x: 0, y: 0, z: -1 },
    modelId: 'm', source: 'voxel', islandAreaMm2, zHeight, overhangAngleDeg: 45, priority: 0,
});

const ctx: ModelSizingContext = { modelVolumeMm3: 27000, modelZMaxMm: 116, totalCandidates: 280, candidatesBelowZ: 100 };

test('tall trunks get a stiffness floor, short ones stay thin', () => {
    const short = sizeParameters(candidate(10), ctx).shaftDiameterMm!;
    const mid = sizeParameters(candidate(50), ctx).shaftDiameterMm!;
    const tall = sizeParameters(candidate(100), ctx).shaftDiameterMm!;
    assert.ok(short <= 0.85, `short ${short}`);
    assert.ok(mid >= 1.25, `mid ${mid}`);
    assert.ok(tall >= 2.0 && tall <= 2.5, `tall ${tall}`);
    // Slenderness of the shaft itself stays bounded.
    assert.ok(100 / tall <= 55, `L/d ${100 / tall}`);
});

test('tip contact does not grow with trunk height', () => {
    const short = sizeParameters(candidate(10), ctx).tipContactDiameterMm!;
    const tall = sizeParameters(candidate(100), ctx).tipContactDiameterMm!;
    assert.ok(Math.abs(tall - short) < 0.05, `short ${short} tall ${tall}`);
});

test('root pad out-spans a thick shaft', () => {
    const s = sizeParameters(candidate(100), ctx);
    assert.ok(s.rootsDiameterMm! >= 2 * s.shaftDiameterMm! - 1e-6 || s.rootsDiameterMm === 4);
});

test('candidates above 30 mm still carry model weight', () => {
    // Heavy model, few supports: the tension term must see the weight above.
    const heavy: ModelSizingContext = { modelVolumeMm3: 2000000, modelZMaxMm: 120, totalCandidates: 4, candidatesBelowZ: 1 };
    const d = sizeParameters(candidate(40, 0.01), heavy).shaftDiameterMm!;
    const stiffnessOnly = 40 / 55 + 0.4;
    assert.ok(d > stiffnessOnly + 0.1, `d ${d} should exceed the stiffness floor ${stiffnessOnly}`);
});
