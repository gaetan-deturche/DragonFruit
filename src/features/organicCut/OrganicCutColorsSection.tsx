import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_ORGANIC_CUT_COLORS,
  saveOrganicCutColors,
  type OrganicCutColors,
} from './organicCutColors';
import { useOrganicCutColors } from './useOrganicCutColors';

/** Field order + labels, so the grid reads in the order the tool draws things. */
const FIELDS: { key: keyof OrganicCutColors; label: string; hint: string }[] = [
  { key: 'seam', label: 'Seam', hint: 'The cut line you draw, in both cut modes.' },
  { key: 'seamHover', label: 'Seam (hover)', hint: 'The seam while the cursor is over it.' },
  { key: 'seamInactive', label: 'Seam (other loops)', hint: 'The loops of a multi-loop cut you are not editing.' },
  { key: 'seamGlow', label: 'Seam glow', hint: 'Halo around the hovered seam.' },
  { key: 'cutSurface', label: 'Cut surface', hint: 'The contour membrane and the flat cut plane.' },
  { key: 'tenonFront', label: 'Tenon (near faces)', hint: 'The tenon’s faces turned toward you — the half that pokes out.' },
  { key: 'tenonBack', label: 'Tenon (far faces)', hint: 'Its far faces, darker so the shape reads solid.' },
  { key: 'tenonEdge', label: 'Tenon edges', hint: 'The tenon’s silhouette lines.' },
  { key: 'mortiseFront', label: 'Mortise (near faces)', hint: 'The hole carved in the other half — the tenon plus the fit tolerance.' },
  { key: 'mortiseBack', label: 'Mortise (far faces)', hint: 'Its far faces, darker so the shape reads solid.' },
  { key: 'mortiseEdge', label: 'Mortise edges', hint: 'The mortise’s silhouette lines.' },
  { key: 'tenonHandle', label: 'Tenon handle', hint: 'The dot you drag to slide the tenon across the cut.' },
  { key: 'markerFirst', label: 'First waypoint', hint: 'The point the loop starts from.' },
  { key: 'markerPoint', label: 'Waypoint', hint: 'Every other point on the loop.' },
  { key: 'markerSelected', label: 'Waypoint (selected)', hint: 'The point you clicked.' },
  { key: 'markerDragging', label: 'Waypoint (dragging)', hint: 'The point being dragged.' },
];

/**
 * Colour settings for the Cut tool.
 *
 * Self-contained on purpose: it reads and writes the preference module directly
 * instead of taking a dozen props through the settings modal, and the tool picks
 * every change up live through the same subscription.
 */
export function OrganicCutColorsSection() {
  const colors = useOrganicCutColors();
  const isDefault = (Object.keys(DEFAULT_ORGANIC_CUT_COLORS) as (keyof OrganicCutColors)[])
    .every((k) => colors[k] === DEFAULT_ORGANIC_CUT_COLORS[k]);

  const set = (key: keyof OrganicCutColors, value: string) => {
    saveOrganicCutColors({ ...colors, [key]: value });
  };

  return (
    <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Cut Tool Colors</div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            The seam, cut surface, registration tenon and waypoints drawn while cutting.
          </div>
        </div>
        <button
          type="button"
          onClick={() => saveOrganicCutColors(DEFAULT_ORGANIC_CUT_COLORS)}
          disabled={isDefault}
          title="Put every Cut tool colour back to its default."
          aria-label="Reset cut tool colors to defaults"
          className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors hover:brightness-125 disabled:cursor-default disabled:opacity-40"
          style={{
            borderColor: 'color-mix(in srgb, var(--success), transparent 55%)',
            background: 'color-mix(in srgb, var(--success), transparent 88%)',
            color: 'var(--success)',
          }}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map(({ key, label, hint }) => (
          <div key={key} className="space-y-1">
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }} title={hint}>{label}</div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={colors[key]}
                onChange={(e) => set(key, e.target.value)}
                aria-label={label}
                className="h-8 w-10 shrink-0 rounded border"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
              />
              <input
                type="text"
                value={colors[key]}
                onChange={(e) => set(key, e.target.value)}
                aria-label={`${label} hex value`}
                className="ui-input h-8 w-[7.5rem] min-w-0"
                placeholder={DEFAULT_ORGANIC_CUT_COLORS[key]}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
