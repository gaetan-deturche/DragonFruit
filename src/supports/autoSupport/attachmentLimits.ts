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

/**
 * Max tilt of a contact cone's axis from straight down (deg). The axis follows
 * the (smoothed) surface normal; on an edge or corner that normal lies almost
 * flat, so the cone stuck out sideways and the shaft had to elbow over to reach
 * it — a horizontal arm pushing on the part instead of holding it from below.
 */
export const MAX_CONE_TILT_DEG = 40;

/** Tilt an outward contact normal toward straight down so it stays within maxDeg. */
export function clampConeAxis(
    n: { x: number; y: number; z: number },
    maxDeg = MAX_CONE_TILT_DEG,
): { x: number; y: number; z: number } {
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    const nx = n.x / len, ny = n.y / len, nz = n.z / len;
    const tilt = (Math.acos(Math.max(-1, Math.min(1, -nz))) * 180) / Math.PI;
    if (tilt <= maxDeg) return { x: nx, y: ny, z: nz };
    const h = Math.hypot(nx, ny);
    if (h < 1e-9) return { x: 0, y: 0, z: -1 };
    const r = (maxDeg * Math.PI) / 180;
    return { x: (nx / h) * Math.sin(r), y: (ny / h) * Math.sin(r), z: -Math.cos(r) };
}
