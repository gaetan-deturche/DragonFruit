import type { CandidatePoint } from './types';
import type { SupportSettings } from '../Settings/types';

// ---------------------------------------------------------------------------
// Physics constants
// ---------------------------------------------------------------------------

/** Typical SLA resin density (g/mm³).  ~1.1 g/cm³. */
const RESIN_DENSITY_G_PER_MM3 = 0.0011;
/** Approximate peel force per mm² of cross-section (N/mm²).
 *  Real measured values are 0.1–0.5 N/mm² for typical resins. */
const PEEL_FORCE_N_PER_MM2 = 0.2;
/** Base shaft diameter floor (mm).  Supports thinner than this
 *  are too fragile for any practical load. */
const MIN_SHAFT_DIAMETER_MM = 0.75;
/** Maximum shaft diameter (mm). */
const MAX_SHAFT_DIAMETER_MM = 2.5;
/** Tensile strength of freshly printed (green, not post-cured) standard resin,
 *  conservatively (N/mm² = MPa). Post-cured parts are 3-5× stronger. */
const GREEN_RESIN_TENSILE_MPA = 10;
/** Safety factor applied to the estimated load when sizing a shaft. */
const SHAFT_SAFETY_FACTOR = 3;
/** Typical resin layer height, used to estimate the per-layer peel area of an
 *  inclined overhang (support settings do not carry the print layer height). */
const LAYER_HEIGHT_FOR_SIZING_MM = 0.05;
/**
 * Stiffness floor for a trunk of free length L: d ≥ L / SLENDERNESS_LIMIT +
 * STIFFNESS_BASE_MM. Tension alone (above) asks for ~0.8 mm whatever the
 * height, but a long thin shaft is a spring: every peel tugs the hanging part
 * sideways, the 0.8 mm × 100 mm trunks of a tall plate whipped, snapped
 * mid-print and left the parts unformed. This keeps L/d ≲ 45-55 (≈1.3 mm at
 * 50 mm, ≈2.2 mm at 100 mm), in line with what tall resin prints need.
 */
const SLENDERNESS_LIMIT = 55;
const STIFFNESS_BASE_MM = 0.4;

/** Peel/suction pull per mm² of the layer being separated from the FEP (N/mm²). */
const LAYER_PEEL_N_PER_MM2 = 0.2;
/** Safety factor on the total tip contact area vs the worst layer's peel. */
const TIP_SAFETY_FACTOR = 3;
/** Upper bound for the model-level tip minimum: bigger contacts scar details, and
 *  past ~0.5 mm the tip disk no longer clears sloped surfaces (trunk builds fail). */
const MAX_REQUIRED_TIP_MM = 0.5;
/**
 * Absolute floor for an auto-placed contact. 0.24 mm tips (5 LCD pixels) held
 * nothing in practice, even on a small 42 mm² part. A Chitubox slice of the
 * same parts that printed fine had its thinnest 10 % of junctions at
 * 0.28-0.47 mm and a 0.66-0.69 mm median.
 */
const MIN_TIP_CONTACT_MM = 0.35;
/** Minimum depth a tip is sunk into the part (mm): ~4 layers at 0.05 mm. */
const MIN_TIP_PENETRATION_MM = 0.2;

/**
 * Every layer of a part is torn off the FEP as a whole, and that pull is carried
 * by the support tips holding the part. Tip size used to depend only on the
 * island each tip touches, so a part with a large cross-section (a solid front
 * plate, a long side panel: 300-500 mm² per layer) hung on ~0.3 mm tips whose
 * total contact (~10 mm²) sat right at the green-resin limit: the tips tore and
 * the part stayed on the FEP. Size the tips so that all of them together hold
 * the largest layer with a margin: A = maxSection · peel · SF / σ, shared over
 * the expected number of contacts.
 */
export function requiredTipContactDiameterMm(maxSectionMm2: number, expectedContacts: number): number {
    if (!(maxSectionMm2 > 0) || !(expectedContacts > 0)) return 0;
    const totalAreaMm2 = (maxSectionMm2 * LAYER_PEEL_N_PER_MM2 * TIP_SAFETY_FACTOR) / GREEN_RESIN_TENSILE_MPA;
    const perTipMm2 = totalAreaMm2 / expectedContacts;
    return Math.min(MAX_REQUIRED_TIP_MM, Math.sqrt((4 * perTipMm2) / Math.PI));
}

// ---------------------------------------------------------------------------
// Override type
// ---------------------------------------------------------------------------

export interface SizeOverrides {
    shaftDiameterMm?: number;
    tipContactDiameterMm?: number;
    tipBodyDiameterMm?: number;
    tipLengthMm?: number;
    tipPenetrationMm?: number;
    rootsDiameterMm?: number;
    rootsDiskHeightMm?: number;
    rootsConeHeightMm?: number;
}

/** Context passed from the orchestrator for model-level sizing. */
export interface ModelSizingContext {
    /** Estimated model volume in mm³ (from bounding box or mesh). */
    modelVolumeMm3: number;
    /** World Z of the model's top (mm). Weight above a candidate is
     *  estimated from the share of the model height that lies above it. */
    modelZMaxMm?: number;
    /** Minimum contact (tip) diameter for this model, from its largest layer
     *  cross-section — see requiredTipContactDiameterMm. */
    minTipContactMm?: number;
    /** Largest layer cross-section (mm²), for diagnostics. */
    maxCrossSectionMm2?: number;
    /** Total number of candidates being placed. */
    totalCandidates: number;
    /** Number of candidates at or below this candidate's Z height.
     *  These share the weight of layers above this Z. */
    candidatesBelowZ: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute support dimensions dynamically using physics-informed scaling.
 *
 * Shaft diameter scales with estimated load (model weight per support +
 * peel force from island area).  Tip diameter scales with island area.
 * Root diameter and base flare scale with trunk height.
 *
 * Falls back to preset-based sizing when no model context is available.
 *
 * @param candidate  - The island to size supports for.
 * @param ctx        - Optional model-level context for dynamic sizing.
 *                     When omitted, falls back to heuristic scaling from
 *                     island area alone.
 * @param baseSettings - The user's current support settings (baseline).
 */
export function sizeParameters(
    candidate: CandidatePoint,
    ctx?: ModelSizingContext,
    baseSettings?: SupportSettings,
    /** For core trunks: total area of all candidates this trunk supports
     *  (own area + branches + leaves).  For standalone trunks: own area. */
    totalSupportedAreaMm2?: number,
): SizeOverrides {
    // ── Baseline from user settings ───────────────────────────────
    const shaftBase = baseSettings?.shaft?.diameterMm ?? 1.0;
    const tipContactBase = baseSettings?.tip?.contactDiameterMm ?? 0.3;
    const tipLengthBase = baseSettings?.tip?.lengthMm ?? 2.5;
    const tipPenBase = baseSettings?.tip?.penetrationMm ?? 0.1;
    const rootsDiaBase = baseSettings?.roots?.diameterMm ?? 2.0;

    if (!ctx) {
        // No model context — use island-area-based heuristic scaling.
        const area = Math.max(candidate.islandAreaMm2, 0.01);
        const areaScale = clampStretch(area, 0.1, 2.0, 0.8, 1.5);
        const shaft = round(shaftBase * areaScale, 3);
        return {
            shaftDiameterMm: shaft,
            tipContactDiameterMm: round(clamp(tipContactBase * areaScale, shaft * 0.3, shaft * 0.6), 3),
            tipBodyDiameterMm: shaft,
            tipLengthMm: round(tipLengthBase, 3),
            tipPenetrationMm: round(tipPenBase, 3),
            rootsDiameterMm: round(rootsDiaBase * clamp(areaScale * 0.8, 1.0, 1.5), 3),
            rootsDiskHeightMm: baseSettings?.roots?.diskHeightMm ?? 0.5,
            rootsConeHeightMm: baseSettings?.roots?.coneHeightMm ?? 1.0,
        };
    }

    // ── Dynamic physics-based sizing (upside-down printing) ───────
    // In bottom-up SLA the model hangs from the build plate (Z=0).
    // Supports at low Z are printed first and carry everything above.
    //
    // Weight is distributed simply: the N supports at or below Z
    // share the weight of all layers remaining above Z.

    const modelWeightG = ctx.modelVolumeMm3 * RESIN_DENSITY_G_PER_MM3;
    const zHeight = Math.max(candidate.zHeight, 1);
    // Was max(candidate.z, 30): any candidate above 30 mm got weightFraction 0
    // (no carried weight at all) — exactly the tall trunks that carry most.
    const modelZMax = Math.max(ctx.modelZMaxMm ?? 30, zHeight);

    // Count supports at or below this Z (including this one).
    const supportsBelow = ctx.candidatesBelowZ ?? ctx.totalCandidates;
    const weightFraction = (modelZMax - zHeight) / modelZMax;
    const carriedWeightG = (modelWeightG * weightFraction) / Math.max(supportsBelow, 1);

    // Peel force from the supported area.
    let effArea = Math.max(totalSupportedAreaMm2 ?? candidate.islandAreaMm2, 0.01);
    if (candidate.source === 'overhang') {
        // An overhang sample stands for a whole spacing² cell of an INCLINED
        // face, but the face is built a thin strip per layer, each strip fused to
        // the one below: the area pulled off the FEP at any one layer is
        // ~ cellWidth × layerHeight / tan(θ). Only near-flat ceilings approach
        // the full cell (true islands keep their full area). Sizing every sample
        // for the whole cell gave 1.7-2 mm trunks under every sloped wall.
        const cellWidth = Math.sqrt(effArea);
        const inclinationRad = (Math.max(candidate.overhangAngleDeg, 1) * Math.PI) / 180;
        const stripArea = cellWidth * (LAYER_HEIGHT_FOR_SIZING_MM / Math.tan(inclinationRad));
        effArea = Math.max(Math.min(effArea, stripArea), 0.01);
    }
    const peelForceN = effArea * PEEL_FORCE_N_PER_MM2;

    // Total load.  Mesh minima are point contacts — 1.5× factor
    // because peel stress concentrates at a single sharp tip.
    const rawLoadN = carriedWeightG * 0.0098 + peelForceN;
    const loadN = candidate.source === 'minima' ? rawLoadN * 1.5 : rawLoadN;

    // Shaft diameter: the section that carries the load in tension with a
    // safety margin — A = SF·F/σ  →  d = √(4·SF·F / (π·σ)). The previous
    // empirical `√F × 1.2` (in shaftBase units) was ~2× the diameter physics
    // asks for, so any candidate over ~16 mm² hit the 2 mm cap (overhang samples
    // are 36 mm² cells → every one of them a 2 mm trunk). Floor and cap unchanged.
    const requiredDiameterMm = Math.sqrt((4 * SHAFT_SAFETY_FACTOR * loadN) / (Math.PI * GREEN_RESIN_TENSILE_MPA));
    // Free length ≈ tip height above the plate (the trunk drops to the plate).
    const stiffnessDiameterMm = zHeight / SLENDERNESS_LIMIT + STIFFNESS_BASE_MM;
    const strengthDiameterMm = clamp(
        Math.max(shaftBase * 0.8, requiredDiameterMm),
        MIN_SHAFT_DIAMETER_MM,
        Math.min(MAX_SHAFT_DIAMETER_MM, shaftBase * 2.0),
    );
    // The stiffness floor may exceed the user-relative cap, up to the hard max.
    const shaftDiameterMm = round(
        Math.max(strengthDiameterMm, Math.min(stiffnessDiameterMm, MAX_SHAFT_DIAMETER_MM)),
    3);

    // Tip contact: scaled by island area, but never thinner than 30%
    // of the shaft — a thick shaft needs a decent tip to transfer load.
    const ownArea = Math.max(candidate.islandAreaMm2, 0.01);
    const tipScale = clampStretch(ownArea, 0.05, 1.0, 0.5, 1.2);
    const tipContactDiameterMm = round(
        // Tied to the load-bearing (strength) section, not the stiffness
        // floor: a tall trunk must not leave a bigger scar on the detail.
        clamp(
            Math.max(tipContactBase * tipScale, ctx.minTipContactMm ?? 0, MIN_TIP_CONTACT_MM),
            Math.max(strengthDiameterMm * 0.3, MIN_TIP_CONTACT_MM),
            // The model-level minimum may exceed 0.6×shaft on thin shafts.
            Math.max(strengthDiameterMm * 0.6, Math.min(ctx.minTipContactMm ?? 0, shaftDiameterMm * 0.8)),
        ),
    3);
    const tipBodyDiameterMm = shaftDiameterMm;

    // Tip length: slightly longer for taller supports.
    const tipLengthMm = round(tipLengthBase * clamp(1 + (zHeight - 10) / 100, 0.9, 1.3), 3);

    // Penetration: proportional to tip size.
    // A 0.1 mm (2-layer) bite left the junction to a couple of layers of resin.
    const tipPenetrationMm = round(Math.max(tipPenBase, MIN_TIP_PENETRATION_MM, tipContactDiameterMm * 0.25), 3);

    // Root diameter: wider for taller/heavier supports.
    const rootScale = clamp(Math.sqrt(loadN) * 0.6, 0.8, 1.8);
    // The pad must also out-span a thick shaft (≥ 2× its diameter).
    const rootsDiameterMm = round(clamp(Math.max(rootsDiaBase * rootScale, shaftDiameterMm * 2), rootsDiaBase, 4.0), 3);

    return {
        shaftDiameterMm,
        tipContactDiameterMm,
        tipBodyDiameterMm,
        tipLengthMm,
        tipPenetrationMm,
        rootsDiameterMm,
        rootsDiskHeightMm: baseSettings?.roots?.diskHeightMm ?? 0.5,
        rootsConeHeightMm: baseSettings?.roots?.coneHeightMm ?? 1.0,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Clamp a value after linear remapping from [loIn, hiIn] to [loOut, hiOut]. */
function clampStretch(
    value: number,
    loIn: number, hiIn: number,
    loOut: number, hiOut: number,
): number {
    const t = (value - loIn) / (hiIn - loIn);
    return clamp(loOut + t * (hiOut - loOut), loOut, hiOut);
}

function round(value: number, decimals: number): number {
    return Number(value.toFixed(decimals));
}
