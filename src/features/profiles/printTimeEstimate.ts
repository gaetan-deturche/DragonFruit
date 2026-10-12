import type { MaterialProfile, PrinterProfile } from './profileStore';
import { normalizeOutputFormat } from './outputFormatUtils';

/**
 * Per-layer time the printer spends beyond "exposure + wait + lift + retract":
 * acceleration ramps, direction-change pauses, firmware delays. A plain sum of
 * the profile settings under-estimated a 2350-layer Anycubic Mono X2 print by
 * ~1 h 30 (printer: 13.9 s/layer vs 11.5 s computed). Chitubox's own estimate
 * for the same printer carries the same ~2.5 s/layer on top of its settings.
 */
export const LAYER_MOTION_OVERHEAD_SEC = 2.5;

function num(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Estimated print duration (s) for `totalLayers` layers with this material.
 * Output-format settings (e.g. .pmx2: wait before cure, transition layers) win
 * over the generic material fields when the printer's format defines them —
 * they are what actually reaches the sliced file.
 */
export function estimatePrintTimeSec(
    material: MaterialProfile,
    printer: PrinterProfile | null | undefined,
    totalLayers: number,
): number {
    if (!(totalLayers > 0)) return 0;
    const format = printer ? normalizeOutputFormat(printer.display.outputFormat) : null;
    const local = format
        ? (material.localSettingsByOutput?.[format] ?? material.localSettingsByOutput?.[format.replace(/^\./, '')] ?? {})
        : {};

    const normalExposure = num(local.normalExposureSec, material.normalExposureSec);
    const bottomExposure = num(local.bottomExposureSec, material.bottomExposureSec);
    const bottomLayers = Math.max(0, Math.min(totalLayers, Math.round(num(local.bottomLayerCount, material.bottomLayerCount))));
    const transitionLayers = Math.max(0, Math.min(totalLayers - bottomLayers, Math.round(num(local.transitionLayerCount, 0))));
    const waitSec = Math.max(0, num(local.waitTimeBeforeCureSec, 0));
    const liftMm = Math.max(0, num(local.liftDistanceMm, material.liftDistanceMm));
    const liftSpeed = num(local.liftSpeedMmMin, material.liftSpeedMmMin);
    const retractSpeed = num(local.retractSpeedMmMin, material.retractSpeedMmMin);

    const travelSec = (liftSpeed > 0 ? (liftMm / liftSpeed) * 60 : 0) + (retractSpeed > 0 ? (liftMm / retractSpeed) * 60 : 0);
    const perLayerFixed = travelSec + waitSec + LAYER_MOTION_OVERHEAD_SEC;

    // Transition layers step linearly from bottom to normal exposure.
    let exposureSum = bottomLayers * bottomExposure;
    for (let i = 0; i < transitionLayers; i++) {
        const t = (i + 1) / (transitionLayers + 1);
        exposureSum += bottomExposure + (normalExposure - bottomExposure) * t;
    }
    exposureSum += (totalLayers - bottomLayers - transitionLayers) * normalExposure;

    return exposureSum + totalLayers * perLayerFixed;
}
