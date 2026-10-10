/**
 * Minimal-displacement overlap resolution for XY footprints.
 *
 * Used after auto-orient: re-orienting changes each model's footprint, so parts
 * that were spaced out can now overlap. Auto-orient must only ORIENT — a full
 * re-pack (auto-arrange) would scatter models the user had placed — so instead
 * we nudge only the overlapping MOVABLE (just-oriented) footprints apart, along
 * the axis of least penetration, by the smallest amount that clears them.
 * Non-movable footprints (models the user didn't orient) act as fixed obstacles.
 */

export interface FootprintRect {
    id: string;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /** Only movable rects are shifted; the others are fixed obstacles. */
    movable: boolean;
}

export interface PlateBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

export interface OverlapResolution {
    /** XY shift to apply to each MOVED rect (absent = not moved). */
    shifts: Map<string, { dx: number; dy: number }>;
    /** False when overlaps remain after the iteration budget (plate too full). */
    resolved: boolean;
}

export function resolveFootprintOverlaps(
    input: FootprintRect[],
    plate: PlateBounds,
    spacingMm: number,
    maxIterations = 300,
): OverlapResolution {
    const rects = input.map((r) => ({ ...r }));
    const gap = Math.max(0, spacingMm);
    const EPS = 1e-4;

    const clampIntoPlate = (r: (typeof rects)[number]) => {
        // Pull a movable rect back inside the plate when it fits; if it is wider
        // than the plate there's nothing sensible to do on that axis.
        const w = r.maxX - r.minX;
        const d = r.maxY - r.minY;
        let dx = 0;
        let dy = 0;
        if (w <= plate.maxX - plate.minX) {
            if (r.minX < plate.minX) dx = plate.minX - r.minX;
            else if (r.maxX > plate.maxX) dx = plate.maxX - r.maxX;
        }
        if (d <= plate.maxY - plate.minY) {
            if (r.minY < plate.minY) dy = plate.minY - r.minY;
            else if (r.maxY > plate.maxY) dy = plate.maxY - r.maxY;
        }
        r.minX += dx; r.maxX += dx; r.minY += dy; r.maxY += dy;
    };

    let resolved = false;
    for (let iter = 0; iter < maxIterations; iter++) {
        let anyOverlap = false;
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                const a = rects[i];
                const b = rects[j];
                if (!a.movable && !b.movable) continue;
                // Penetration including the required spacing gap.
                const px = Math.min(a.maxX + gap - b.minX, b.maxX + gap - a.minX);
                const py = Math.min(a.maxY + gap - b.minY, b.maxY + gap - a.minY);
                if (px <= EPS || py <= EPS) continue;
                anyOverlap = true;

                // Push along the axis of least penetration, away from each other.
                const acx = (a.minX + a.maxX) / 2, bcx = (b.minX + b.maxX) / 2;
                const acy = (a.minY + a.maxY) / 2, bcy = (b.minY + b.maxY) / 2;
                let ax = 0, ay = 0;
                if (px <= py) ax = (acx <= bcx ? -1 : 1) * (px + EPS);
                else ay = (acy <= bcy ? -1 : 1) * (py + EPS);

                // Split the push between movable rects (a gets +, b gets -).
                const aShare = a.movable && b.movable ? 0.5 : (a.movable ? 1 : 0);
                const bShare = a.movable && b.movable ? 0.5 : (b.movable ? 1 : 0);
                a.minX += ax * aShare; a.maxX += ax * aShare;
                a.minY += ay * aShare; a.maxY += ay * aShare;
                b.minX -= ax * bShare; b.maxX -= ax * bShare;
                b.minY -= ay * bShare; b.maxY -= ay * bShare;
            }
        }
        for (const r of rects) if (r.movable) clampIntoPlate(r);
        if (!anyOverlap) {
            resolved = true;
            break;
        }
    }

    const shifts = new Map<string, { dx: number; dy: number }>();
    rects.forEach((r, idx) => {
        const src = input[idx];
        const dx = r.minX - src.minX;
        const dy = r.minY - src.minY;
        if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) shifts.set(r.id, { dx, dy });
    });
    return { shifts, resolved };
}
