import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePrintTimeSec } from '../printTimeEstimate';
import type { MaterialProfile, PrinterProfile } from '../profileStore';

const printer = { display: { outputFormat: '.aff' } } as unknown as PrinterProfile;
const material = {
    normalExposureSec: 2,
    bottomExposureSec: 25,
    bottomLayerCount: 5,
    liftDistanceMm: 5,
    liftSpeedMmMin: 60,
    retractSpeedMmMin: 120,
    localSettingsByOutput: {
        '.aff': { waitTimeBeforeCureSec: 2, transitionLayerCount: 15 },
    },
} as unknown as MaterialProfile;

test('matches what the Mono X2 reported for a 2350-layer print', () => {
    // Printer: 8 h 30 left at layer 150 → ~13.9 s/layer → ~9 h 05 in total.
    const sec = estimatePrintTimeSec(material, printer, 2350);
    const printerTotal = 8.5 * 3600 + 150 * 13.9;
    assert.ok(Math.abs(sec - printerTotal) / printerTotal < 0.05, `estimate ${(sec / 3600).toFixed(2)} h vs printer ${(printerTotal / 3600).toFixed(2)} h`);
});

test('output-format settings win over generic fields; wait time counts', () => {
    const noLocal = estimatePrintTimeSec({ ...material, localSettingsByOutput: undefined }, printer, 1000);
    const withLocal = estimatePrintTimeSec(material, printer, 1000);
    assert.ok(withLocal - noLocal >= 1000 * 2 - 1e-6, 'wait time before cure must be counted per layer');
});
