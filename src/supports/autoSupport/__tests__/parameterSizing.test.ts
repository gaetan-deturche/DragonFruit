import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeParameters, requiredTipContactDiameterMm, type ModelSizingContext } from '../parameterSizing';
import type { CandidatePoint } from '../types';

const candidate = (zHeight: number, islandAreaMm2 = 1): CandidatePoint => ({
    id: 'c', tipPos: { x: 0, y: 0, z: zHeight }, tipNormal: { x: 0, y: 0, z: -1 },
    modelId: 'm', source: 'voxel', islandAreaMm2, zHeight, overhangAngleDeg: 45, priority: 0,
});

const ctx: ModelSizingContext = { modelVolumeMm3: 27000, modelZMaxMm: 116, totalCandidates: 280, candidatesBelowZ: 100 };

test('tall trunks get a stiffness floor, short ones keep the 1.2 mm floor', () => {
    const short = sizeParameters(candidate(10), ctx).shaftDiameterMm!;
    const mid = sizeParameters(candidate(50), ctx).shaftDiameterMm!;
    const tall = sizeParameters(candidate(100), ctx).shaftDiameterMm!;
    assert.ok(short >= 1.2 - 1e-6 && short <= 1.25, `short ${short}`);
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

test('tip minimum covers the largest layer peel', () => {
    // 516 mm² panel, ~170 contacts: total contact must hold 516·0.2·4 N at 10 MPa.
    const d = requiredTipContactDiameterMm(516, 170);
    const total = 170 * Math.PI * (d / 2) ** 2;
    assert.ok(total >= (516 * 0.2 * 4) / 10 - 1e-6, `total ${total}`);
    assert.ok(d > 0.45 && d <= 0.7, `d ${d}`);
    assert.equal(requiredTipContactDiameterMm(5000, 10), 0.7); // capped
    assert.equal(requiredTipContactDiameterMm(0, 10), 0);
});

test('model tip minimum raises the contact, within the shaft', () => {
    const base = sizeParameters(candidate(20), ctx).tipContactDiameterMm!;
    const raised = sizeParameters(candidate(20), { ...ctx, minTipContactMm: 0.7 });
    assert.ok(base < 0.7, `base ${base}`);
    assert.ok(raised.tipContactDiameterMm! >= 0.7 - 1e-6, `raised ${raised.tipContactDiameterMm}`);
    assert.ok(raised.tipContactDiameterMm! <= raised.shaftDiameterMm! * 0.8 + 1e-6);
});

test('no auto tip below 0.6 mm, sunk at least 0.2 mm', () => {
    const tiny = sizeParameters(candidate(5, 0.01), { ...ctx, minTipContactMm: 0.1 });
    assert.ok(tiny.tipContactDiameterMm! >= 0.6 - 1e-6, `tip ${tiny.tipContactDiameterMm}`);
    assert.ok(tiny.tipPenetrationMm! >= 0.2 - 1e-6, `pen ${tiny.tipPenetrationMm}`);
});
