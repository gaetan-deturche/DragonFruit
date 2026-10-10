import assert from 'node:assert/strict';
import test from 'node:test';

import { rasterizeLoopsToExistingGridScanline } from '../scanline';

const square = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

test('rasterizeLoopsToExistingGridScanline keeps holes between loops empty', () => {
    // 10 mm square with a 4 mm square hole, 1 mm pixels.
    const ref = { data: new Uint8Array(100), width: 10, height: 10, originX: 0, originZ: -0.5, px_mm: 1 };
    const mask = rasterizeLoopsToExistingGridScanline(
        [square(0, 0, 10, 10), square(3, 3, 7, 7)] as never,
        ref as never,
    );
    assert.equal(mask.data[5 * 10 + 5], 0, 'hole centre must not be filled');
    assert.equal(mask.data[5 * 10 + 1], 1, 'wall must be filled');
    assert.equal(mask.data.reduce((s, v) => s + v, 0), 100 - 16);
});
