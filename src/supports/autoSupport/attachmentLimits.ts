/**
 * Geometry limits for auto-placed attachments that hang off another support
 * (leaves, branches) or lean instead of standing vertical (escape trunks).
 *
 * A real print of a solid 320 mm² front plate hung mostly on leaves up to 8 mm
 * long and 60-80° off vertical, plus trunks tilted up to 48°: every peel pulled
 * them sideways, they flexed, each new layer cured in the displaced position,
 * and the plate came out warped (its first-printed edge bent the wrong way).
 * Inclined members carry the peel in bending, vertical ones in tension — keep
 * them short and steep, and fall back to a vertical trunk otherwise.
 */

/** Max angle from vertical (knot → tip) for an auto leaf or branch. */
export const AUTO_ATTACH_MAX_ANGLE_DEG = 35;
/** Max knot-to-tip length of an auto leaf (mm). */
export const AUTO_LEAF_MAX_SPAN_MM = 5;
/** Tilts tried for an escape trunk (deg from vertical), shallowest first. */
export const ESCAPE_TRUNK_TILTS_DEG = [12, 18, 25];

/** Angle from vertical (deg) of the segment knot → tip; 0 = straight up. */
export function angleFromVerticalDeg(
    knot: { x: number; y: number; z: number },
    tip: { x: number; y: number; z: number },
): number {
    const h = Math.hypot(tip.x - knot.x, tip.y - knot.y);
    const v = tip.z - knot.z;
    if (v <= 0) return 90;
    return (Math.atan2(h, v) * 180) / Math.PI;
}
