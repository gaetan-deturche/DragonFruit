/**
 * Build-plate XY bounds for support placement.
 *
 * A support whose ROOT (plate contact) falls outside the printable rectangle can
 * never be printed — there is no plate under it — and DragonFruit's raft then
 * stretches off-plate to reach it. This holds the min/max XY of the plate so
 * placement can reject such roots.
 *
 * Bounds are supplied by the React layer from the active build volume, which
 * already accounts for the origin convention (centered vs front-left corner).
 * When unset (null), the guard is a no-op so non-UI callers and tests behave
 * exactly as before.
 */

interface PlateBoundsXY {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

let bounds: PlateBoundsXY | null = null;

/** Keep the whole root disk on-plate, not just its center. */
const EDGE_MARGIN_MM = 2;
/**
 * Extra room past the root disk for the raft that is grown around the roots
 * (footprint margin + optional wall), so the raft outline stays on-plate too.
 */
const RAFT_MARGIN_MM = 1;

export function setPlateBoundsXY(b: PlateBoundsXY | null): void {
    bounds = b;
}

export function hasPlateBounds(): boolean {
    return bounds != null;
}

/**
 * True if a support root centered at (x,y) lands within the printable plate
 * area. Pass the root disk radius so a wide pad (plus the raft around it) is
 * kept fully on-plate, not just its center.
 */
export function isRootWithinPlate(x: number, y: number, rootRadiusMm = 0): boolean {
    if (!bounds) return true; // no limit configured
    const m = Math.max(EDGE_MARGIN_MM, rootRadiusMm + RAFT_MARGIN_MM);
    return x >= bounds.minX + m
        && x <= bounds.maxX - m
        && y >= bounds.minY + m
        && y <= bounds.maxY - m;
}
