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

export function setPlateBoundsXY(b: PlateBoundsXY | null): void {
    bounds = b;
}

export function hasPlateBounds(): boolean {
    return bounds != null;
}

/** True if a support root at (x,y) lands within the printable plate area. */
export function isRootWithinPlate(x: number, y: number): boolean {
    if (!bounds) return true; // no limit configured
    return x >= bounds.minX + EDGE_MARGIN_MM
        && x <= bounds.maxX - EDGE_MARGIN_MM
        && y >= bounds.minY + EDGE_MARGIN_MM
        && y <= bounds.maxY - EDGE_MARGIN_MM;
}
