import React from 'react';
import { Loader2, RotateCcw, TriangleAlert } from 'lucide-react';
import { Card, CardHeader, IconButton } from '@/components/atoms';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import type { OrganicCutMode } from './types';
import { DEFAULT_CUT_SETTINGS, DEFAULT_TENON_SETTINGS } from './useOrganicCutSession';

/** Tenon width/depth bounds (mm) — shared by the fields and the uniform-scale lock. */
const TENON_DIM_MAX_MM = 20;
/**
 * Smallest width the FRUSTUM tenon accepts. This field IS the floor now: Rust no
 * longer has one of its own — it builds what it is asked for and only says whether
 * it fits — so anything the panel allows is a tenon the user can actually get.
 */
const FRUSTUM_MIN_WIDTH_MM = 1;
/**
 * Smallest width the DOME tenon accepts. Higher than the frustum's because width
 * is a diameter here: Rust stores a dome as semi-axes, so 1.5mm of width is a
 * 0.75mm radius — below that a hemisphere stops locating anything.
 */
const DOME_MIN_WIDTH_MM = 1.5;

/**
 * Frustum taper (Rust's TENON_TOP_SCALE): the top face is half the base, so the
 * narrowest half-extent a corner arc has to fit inside lives at the TOP.
 */
const TENON_TOP_SCALE = 0.5;
/** Rust's TENON_BASE_OVERLAP_MM — the tenon's base sinks this far past the cut plane. */
const TENON_BASE_OVERLAP_MM = 0.3;
/** Field step for the fillet, also the granularity its cap is rounded down to. */
const TENON_FILLET_STEP_MM = 0.1;
/**
 * Fit-tolerance ceiling (mm), mirroring Rust's TENON_TOLERANCE_MAX_MM. Every extra
 * 0.1mm of mortise is 0.1mm less wall to clear, so on a thin part a loose fit is
 * what tips a tenon from fitting to not.
 */
const TENON_TOLERANCE_MAX_MM = 1;

/**
 * Largest fillet the frustum can actually take, given the current width/depth.
 *
 * `build_frustum` clamps the radius to the smallest half-extent (a corner arc
 * can't be wider than the side it rounds) and to a third of the height (so the
 * tip round-over fits under the tip). Offering the full 0–5mm regardless meant
 * that on a 2mm-wide tenon everything from 0.5mm up produced the SAME clamped
 * geometry: the field looked dead in both directions. Cap it here so the range
 * on screen is the range that does something. Width is the binding side
 * (length = 1.25× width), and the top face is the narrowest ring.
 */
function maxTenonFilletMm(widthMm: number, depthMm: number): number {
  const topHalfWidth = widthMm * TENON_TOP_SCALE * 0.5;
  const height = depthMm + TENON_BASE_OVERLAP_MM;
  const limit = Math.min(topHalfWidth * 0.999, height / 3);
  // Down to the field's step, so every reachable value is a value that renders.
  const stepped = Math.floor(limit / TENON_FILLET_STEP_MM) * TENON_FILLET_STEP_MM;
  return Math.max(0, Number(stepped.toFixed(2)));
}

export interface OrganicCutPanelState {
  /** Flat planar cut vs curved contour ("wafer") cut along the drawn loop. */
  cutMode: OrganicCutMode;
  jointClearanceMm: number;
  /** Seam-line smoothing 0..1 — how much the cut line rounds through waypoints. */
  smoothing: number;
  /** Membrane smoothing 0..1 — how smooth/taut the curved cutter surface is. */
  membraneSmoothing: number;
  /** Wafer density multiplier (1..4) — cutter poly count, applied only at cut. */
  density: number;
  /**
   * When true (contour mode), the cut also generates a registration tenon: a tenon
   * union'd onto one half and a matching mortise carved from the other, so the
   * halves mortise together in one alignment. Off by default.
   */
  generateTenon: boolean;
  /** Tenon base width in mm (model units are mm). The length follows a 1.25× ratio. */
  tenonWidthMm: number;
  /** Tenon depth in mm — how far the tenon pokes into the body. */
  tenonDepthMm: number;
  /** Tenon shape: 'frustum' (tapered box, rotation-locking) or 'dome' (half-sphere). */
  tenonShape: 'frustum' | 'dome';
  /** Edge fillet radius (mm) — rounds the frustum's corners + tip. 0 = sharp. */
  tenonFilletMm: number;
  /**
   * Fit tolerance (mm): how much larger than the tenon the mortise is carved, on
   * every face. This is the print-fit knob — 0 is a press fit that needs force
   * (or a printer that already runs small), 0.1 a slide fit, more for a loose one
   * that a filed-down or elephant-footed tenon still enters.
   */
  tenonToleranceMm: number;
  /**
   * Where the tenon sits on the cut face: the model-local point the blue handle
   * was dragged to, or null for the natural middle of the cut. A point, not a
   * displacement — see Rust's `TenonAnchor` for why that distinction is the whole
   * fix. Driven by the handle in the 3D view, not by a field.
   */
  tenonAnchor: [number, number, number] | null;
  /**
   * Dome only: when true, the Width/Depth sliders are ratio-locked — dragging one
   * scales the other to preserve the current proportions (resize as a unit). When
   * false, each is independent (free oblong control).
   */
  tenonUniformScale: boolean;
  /**
   * Flip which cut half gets the tenon vs the mortise. False (default): tenon on the
   * +normal side. True: swap them. Lets the user choose which part keeps the tenon.
   */
  tenonSwapSides: boolean;
  /**
   * Tenon tilt (radians): how far the tenon leans off the cut normal, up to 45°.
   * Driven by the in-viewport aim gizmo (the green ring). The body is rigid — it
   * turns about its base and keeps its size — so the cap ends up at depth·cos(lean)
   * above the cut face. 0 = straight out.
   */
  tenonTiltRad: number;
  /** Tenon roll (radians): spin about the tenon's own axis. Driven by the roll gizmo. */
  tenonRollRad: number;
  /**
   * Render the translucent cut-plan preview (flat plane quad / contour membrane +
   * registration tenon) in the 3D view. When off, only the seam line + loop markers
   * draw, so the model is unobscured while drawing. On by default.
   */
  showPreview: boolean;
}

/**
 * The small square reset in a card's top-right corner — same affordance the
 * Hotkeys tab uses per card, so "this card's settings, back to default" reads the
 * same everywhere. Disabled (and dimmed) while nothing differs from the default.
 */
function CardResetButton({
  onClick,
  disabled,
  title,
  ariaLabel,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors hover:brightness-125 disabled:cursor-default disabled:opacity-40"
      style={{
        borderColor: 'color-mix(in srgb, var(--success), transparent 55%)',
        background: 'color-mix(in srgb, var(--success), transparent 88%)',
        color: 'var(--success)',
      }}
    >
      <RotateCcw className="h-3 w-3" />
    </button>
  );
}

interface OrganicCutPanelProps {
  state: OrganicCutPanelState;
  onStateChange: (next: OrganicCutPanelState) => void;
  /** Number of loop points placed so far (shown to the user). */
  pointCount: number;
  onClearLoop: () => void;
  /**
   * Snap the active loop's waypoints onto the model's nearest sharp edges
   * (creases/boundaries) — for tidying points dropped roughly in a crease.
   */
  onSnapToEdges?: () => void;
  /** True when snapping is possible (geometry present + at least one waypoint). */
  canSnapToEdges?: boolean;
  // --- Multi-loop (contour) -------------------------------------------------
  /** Total loops in the current cut. */
  loopCount?: number;
  /** Index of the loop currently being edited. */
  activeLoopIndex?: number;
  /** Per-loop summaries (index + waypoint count + whether it has a tenon) for chips. */
  loopSummaries?: { index: number; pointCount: number; hasTenon: boolean }[];
  /** Switch which loop is active (editable). */
  onSelectLoop?: (index: number) => void;
  /** Append a new loop and make it active. */
  onAddLoop?: () => void;
  /** True when a new loop can be added (active loop is already a real loop). */
  canAddLoop?: boolean;
  /** Remove a loop (never the last one). */
  onRemoveLoop?: (index: number) => void;
  /** True when there's more than one loop, so removing is allowed. */
  canRemoveLoop?: boolean;
  onApply: () => void;
  isApplying?: boolean;
  canApply?: boolean;
  disabled?: boolean;
  /**
   * Which tenon the live preview placed: 'frustum' (the full tenon), 'dome' (the
   * half-sphere fallback for a thin part), or 'none'. Drives the alert below the
   * toggle so the user knows when the cut fell back.
   */
  /**
   * Whether the previewed tenon fits where it sits. False blocks Cut: Rust would
   * refuse the tenon anyway, and the halves would come out unpinned with the
   * reason buried in a report nobody reads.
   */
  tenonFits?: boolean;
  /**
   * Why the last cut refused, or null. Shown by the Cut button, because that is
   * where the user just clicked and got nothing.
   */
  cutError?: string | null;
  /** Reason the tenon shrank / fell back / was skipped (shown as an alert). */
  tenonDetail?: string;
}

/**
 * Tool panel for Organic Cut. Structurally mirrors HolePunchPanel (collapsible
 * Card, accent sub-cards, ScrollableNumberField, Reset/Apply row) so it sits
 * naturally beside the other Prepare-mode tool panels.
 *
 * M1: thickness/smoothing are wired but the backend ignores them (no-op cut).
 */
export function OrganicCutPanel({
  state,
  onStateChange,
  pointCount,
  onClearLoop,
  onSnapToEdges,
  canSnapToEdges = false,
  loopCount = 1,
  activeLoopIndex = 0,
  loopSummaries = [],
  onSelectLoop,
  onAddLoop,
  canAddLoop = false,
  onRemoveLoop,
  canRemoveLoop = false,
  onApply,
  isApplying = false,
  canApply = false,
  disabled = false,
  tenonFits = true,
  cutError = null,
  tenonDetail = '',
}: OrganicCutPanelProps) {
  const [expanded, setExpanded] = React.useState(true);

  const clampFloat = React.useCallback((value: number, min: number, max: number, decimals = 1) => {
    const safe = Number.isFinite(value) ? value : min;
    const rounded = Number(safe.toFixed(decimals));
    return Math.min(max, Math.max(min, rounded));
  }, []);

  const setState = React.useCallback((patch: Partial<OrganicCutPanelState>) => {
    onStateChange({ ...state, ...patch });
  }, [onStateChange, state]);

  // Set the dome's Width or Depth, honoring Uniform Scale: when locked, dragging
  // one slider scales the OTHER by the same factor so the current width:depth
  // proportion is preserved (resize as a unit). Unlocked → set just that axis.
  const tenonDimMinMm = state.tenonShape === 'dome' ? DOME_MIN_WIDTH_MM : FRUSTUM_MIN_WIDTH_MM;
  const tenonFilletMaxMm = maxTenonFilletMm(state.tenonWidthMm, state.tenonDepthMm);

  // Is there anything for each card's reset to undo? Derived from the defaults
  // rather than listed by hand, so a setting added later is covered on its own.
  // A tenon that doesn't fit blocks the cut. Rust refuses to place it anyway, so
  // cutting anyway would hand back two halves that don't locate, with the reason
  // buried in a report — better to stop at the button, next to the red tenon.
  const tenonBlocksCut = state.generateTenon && !tenonFits;
  const tenonSettingsDirty = (Object.keys(DEFAULT_TENON_SETTINGS) as (keyof typeof DEFAULT_TENON_SETTINGS)[])
    .some((k) => k !== 'generateTenon' && state[k] !== DEFAULT_TENON_SETTINGS[k]);
  const cutSettingsDirty = (Object.keys(DEFAULT_CUT_SETTINGS) as (keyof typeof DEFAULT_CUT_SETTINGS)[])
    .some((k) => state[k] !== DEFAULT_CUT_SETTINGS[k]);

  // Set the frustum's Width or Depth. Shrinking either lowers the fillet ceiling,
  // so the stored radius comes down with it — otherwise it stays parked above the
  // new limit and the field is dead until the user drags back under it.
  const setFrustumDim = React.useCallback((axis: 'width' | 'depth', next: number) => {
    const clamped = clampFloat(next, tenonDimMinMm, TENON_DIM_MAX_MM, 1);
    const widthMm = axis === 'width' ? clamped : state.tenonWidthMm;
    const depthMm = axis === 'depth' ? clamped : state.tenonDepthMm;
    setState({
      tenonWidthMm: widthMm,
      tenonDepthMm: depthMm,
      tenonFilletMm: Math.min(state.tenonFilletMm, maxTenonFilletMm(widthMm, depthMm)),
    });
  }, [clampFloat, tenonDimMinMm, setState, state.tenonDepthMm, state.tenonFilletMm, state.tenonWidthMm]);

  const setDomeDim = React.useCallback((axis: 'width' | 'depth', next: number) => {
    const clamped = clampFloat(next, tenonDimMinMm, TENON_DIM_MAX_MM, 1);
    if (!state.tenonUniformScale) {
      setState(axis === 'width' ? { tenonWidthMm: clamped } : { tenonDepthMm: clamped });
      return;
    }
    const cur = axis === 'width' ? state.tenonWidthMm : state.tenonDepthMm;
    if (cur <= 0) {
      // Degenerate current value — just set both to the new value (round).
      setState({ tenonWidthMm: clamped, tenonDepthMm: clamped });
      return;
    }
    // Clamp the FACTOR, not each axis on its own. Clamping them separately lets
    // the dragged axis keep moving after the other has hit 1mm or 20mm, which
    // silently destroys the proportion the lock exists to preserve. Limiting the
    // factor makes the pinned axis hold BOTH: they stop together and the ratio
    // survives.
    const other = axis === 'width' ? state.tenonDepthMm : state.tenonWidthMm;
    let factor = clamped / cur;
    if (other > 0) {
      factor = Math.min(factor, TENON_DIM_MAX_MM / other);
      factor = Math.max(factor, tenonDimMinMm / other);
    }
    const nextDriven = clampFloat(cur * factor, tenonDimMinMm, TENON_DIM_MAX_MM, 1);
    const nextOther = clampFloat(other * factor, tenonDimMinMm, TENON_DIM_MAX_MM, 1);
    setState(
      axis === 'width'
        ? { tenonWidthMm: nextDriven, tenonDepthMm: nextOther }
        : { tenonDepthMm: nextDriven, tenonWidthMm: nextOther },
    );
  }, [clampFloat, setState, tenonDimMinMm, state.tenonUniformScale, state.tenonWidthMm, state.tenonDepthMm]);

  const cardStyle: React.CSSProperties = {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
  };

  const accentCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 76%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)',
  };

  const activeModeStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
    color: 'var(--text-strong)',
  };

  const disabledStyle: React.CSSProperties | undefined = disabled
    ? { opacity: 0.45, filter: 'grayscale(0.7)' }
    : undefined;

  const isContour = state.cutMode === 'contour';
  const statusLabel = isContour
    ? pointCount < 3
      ? `Click points around the model to trace the seam (${pointCount}/3+)`
      : `${pointCount} points — ready to cut (contour seam)`
    : pointCount === 0
      ? 'Click 2 points across the model to set a flat cut'
      : pointCount === 1
        ? '1 point — click one more on the other side'
        : `${pointCount} points — ready to cut (flat plane)`;

  // Bound the expanded panel to the viewport so its body can scroll. Collapsed it
  // stays unbounded, which keeps it the height of its header.
  const cardShellStyle: React.CSSProperties = {
    ...disabledStyle,
    ...(expanded
      ? { maxHeight: 'calc(100vh - var(--topbar-height) - 140px)' }
      : {}),
  };

  return (
    <Card className="flex flex-col" style={cardShellStyle}>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => {
                if (disabled) return;
                setExpanded((prev) => !prev);
              }}
              className="!p-0.5"
              title={expanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Cut Tool</h3>
          </>
        )}
        right={expanded ? (
          // The cut's OWN settings — mode, kerf, both smoothings, resolution. It
          // sits in the tool header rather than on a card because those settings
          // are spread over several cards; the drawn loops and the tenon are left
          // alone (the tenon card has its own reset, and losing a seam to a stray
          // click on a reset button would be a cruel way to find this button).
          <CardResetButton
            onClick={() => setState({ ...DEFAULT_CUT_SETTINGS })}
            disabled={disabled || isApplying || !cutSettingsDirty}
            title="Put the cut settings back to their defaults: cut mode, thickness, both smoothings and resolution. Your drawn loops and tenon settings are untouched."
            ariaLabel="Reset cut settings to defaults"
          />
        ) : null}
      />

      {expanded && (
        <>
        {/* Scrollable body. The panel has more controls than a 1200px-tall screen
            can show, so it scrolls instead of running off the bottom. */}
        <div className="px-2 space-y-2 sm:px-2.5 overflow-y-auto custom-scrollbar flex-1 min-h-0">
          {/* Live session status */}
          <div
            className="rounded-md border p-2 text-center text-[11px]"
            style={{
              borderColor: 'var(--accent-secondary-action-border)',
              background: 'var(--accent-secondary-action-bg-92)',
              color: 'var(--accent-secondary-action-color)',
            }}
          >
            {statusLabel}
          </div>

          {/* Cut mode: flat plane vs curved contour seam */}
          <div className="rounded-md border p-2 space-y-1.5" style={accentCardStyle}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Cut Mode</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ cutMode: 'contour' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'contour' ? activeModeStyle : undefined}
                title="Split along a curved seam that follows your drawn loop (zero-thickness mate)."
              >
                Contour
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ cutMode: 'plane' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'plane' ? activeModeStyle : undefined}
                title="Slice along a single flat plane derived from your points."
              >
                Flat
              </button>
            </div>
          </div>

          {/* Show Preview: render the translucent cut-plan surfaces (plane quad /
              membrane + tenon) on or off. Off → only the seam line + markers draw,
              so the model is unobscured while drawing. */}
          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setState({ showPreview: !state.showPreview })}
              disabled={disabled || isApplying}
              title="Show or hide the translucent cut preview in the 3D view. The drawn seam and points stay visible either way."
            >
              <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Show Preview</span>
              <span
                className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                style={{
                  background: state.showPreview
                    ? 'var(--accent)'
                    : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                }}
              >
                <span
                  className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                  style={{ transform: state.showPreview ? 'translateX(14px)' : 'translateX(2px)' }}
                />
              </span>
            </button>
          </div>

          {/* Seam-line smoothing: rounds the GEODESIC through the waypoints, so it
              means nothing for a flat cut — that seam is the plane ∩ mesh curve,
              which the waypoints only position. Contour mode only. */}
          {isContour && (
          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Seam Smoothing</label>
            <ScrollableNumberField
              value={state.smoothing}
              onChange={(value) => setState({ smoothing: clampFloat(value, 0, 2, 2) })}
              min={0}
              max={2}
              step={0.05}
              unit=""
              ariaLabel="Seam line smoothing strength"
              disabled={disabled || isApplying}
              className="mt-1"
            />
          </div>
          )}

          {/* Joint clearance — slack in the mortise, NOT a kerf. The cut removes
              nothing: both halves share their cut face. */}
          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Joint Clearance</label>
            <ScrollableNumberField
              value={state.jointClearanceMm}
              onChange={(value) => setState({ jointClearanceMm: clampFloat(value, 0, 1.5, 2) })}
              min={0}
              max={1.5}
              step={0.05}
              unit="mm"
              ariaLabel="Joint clearance in millimeters"
              disabled={disabled || isApplying}
              className="mt-1"
            />
          </div>

          {/* Cut smoothing (how smooth/taut the curved cutter surface is).
              Only meaningful for the contour cut. */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Cut Smoothing</label>
              <ScrollableNumberField
                value={state.membraneSmoothing}
                onChange={(value) => setState({ membraneSmoothing: clampFloat(value, 0, 2, 2) })}
                min={0}
                max={2}
                step={0.05}
                unit=""
                ariaLabel="Cut surface smoothing strength"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          {/* Cut resolution (cutter poly count). Higher = denser cut mesh. The
              preview reflects this live so the user sees the change. Contour-only. */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Cut Resolution</label>
              <ScrollableNumberField
                value={state.density}
                onChange={(value) => setState({ density: clampFloat(value, 1, 4, 2) })}
                min={1}
                max={4}
                step={0.5}
                unit="×"
                ariaLabel="Cut mesh resolution multiplier (applied at cut)"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          {/* Registration tenon: tenon + mortise so the two halves index together.
              Both cut modes: the contour cut frames it on the membrane, the flat
              cut on the plane's own cross-section. */}
          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="flex flex-1 items-center justify-between gap-2 text-left"
                onClick={() => setState({ generateTenon: !state.generateTenon })}
                disabled={disabled || isApplying}
                title="Add a tenon to one half and a matching mortise to the other so the parts align when reassembled."
              >
                <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                  Generate Tenon{loopCount > 1 ? ` · Loop ${activeLoopIndex + 1}` : ''}
                </span>
                <span
                  className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                  style={{
                    background: state.generateTenon
                      ? 'var(--accent)'
                      : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                  }}
                >
                  <span
                    className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                    style={{ transform: state.generateTenon ? 'translateX(14px)' : 'translateX(2px)' }}
                  />
                </span>
              </button>
              {/* Card reset, top-right: puts every tenon setting back to default but
                  leaves the Generate Tenon toggle alone (resetting the settings
                  shouldn't switch the feature off under the user). */}
              <CardResetButton
                onClick={() => setState({ ...DEFAULT_TENON_SETTINGS, generateTenon: state.generateTenon })}
                disabled={disabled || isApplying || !tenonSettingsDirty}
                title="Put every tenon setting back to its default: shape, width, depth, fillet, fit tolerance, uniform scale, side and aim."
                ariaLabel="Reset tenon settings to defaults"
              />
              </div>

              {/* Tenon shape + size. Shape picks frustum (tapered box, locks
                  rotation) vs dome (half-sphere, locates only). Width drives the
                  base; depth (frustum only) is how far the tenon pokes in. The
                  1 mm-wall fit rule still shrinks below these on thin parts. */}
              {state.generateTenon && (
                <div className="space-y-1.5 pt-0.5">
                  <div>
                    <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Tenon Shape</label>
                    <div className="mt-1 grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        className="ui-button ui-button-secondary !h-7 whitespace-nowrap px-1.5 text-[10px]"
                        onClick={() =>
                          // Only the frustum is filleted, so the radius can be
                          // stale (above what this width/depth allows) after a
                          // detour through the dome. Bring it back in range.
                          setState({
                            tenonShape: 'frustum',
                            tenonFilletMm: Math.min(
                              state.tenonFilletMm,
                              maxTenonFilletMm(state.tenonWidthMm, state.tenonDepthMm),
                            ),
                          })
                        }
                        disabled={disabled || isApplying}
                        style={state.tenonShape === 'frustum' ? activeModeStyle : undefined}
                        title="Tapered rectangular tenon — locks the parts against rotation."
                      >
                        Frustum
                      </button>
                      <button
                        type="button"
                        className="ui-button ui-button-secondary !h-7 whitespace-nowrap px-1.5 text-[10px]"
                        onClick={() =>
                          // A dome's floor is higher than a frustum's, so lift any
                          // dimension that would be rejected outright on switch.
                          setState({
                            tenonShape: 'dome',
                            tenonWidthMm: Math.max(state.tenonWidthMm, DOME_MIN_WIDTH_MM),
                            tenonDepthMm: Math.max(state.tenonDepthMm, DOME_MIN_WIDTH_MM),
                          })
                        }
                        disabled={disabled || isApplying}
                        style={state.tenonShape === 'dome' ? activeModeStyle : undefined}
                        title="Half-sphere tenon — locates the parts but allows rotation."
                      >
                        Dome
                      </button>
                    </div>
                  </div>
                  {/* Flip which half gets the tenon vs the mortise. Affects the cut
                      (not the preview shape, which is identical either way). */}
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-7 w-full whitespace-nowrap px-1.5 text-[10px]"
                    onClick={() => setState({ tenonSwapSides: !state.tenonSwapSides })}
                    disabled={disabled || isApplying}
                    title="Swap which cut half receives the tenon and which receives the mortise."
                  >
                    <span className="inline-flex items-center justify-center gap-1.5">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      <span>{state.tenonSwapSides ? 'Tenon on Side B' : 'Tenon on Side A'}</span>
                    </span>
                  </button>
                  {/* Aim readout + a Reset that zeroes the tilt/roll. The aim is set
                      with the rotate gizmo at the tenon's base in the 3D view, so there
                      is nothing to say here until the tenon actually leans. */}
                  {(() => {
                    // Report at the precision shown. The old threshold was ~0.06°,
                    // far finer than the whole degrees displayed, so a sliver of
                    // lean rendered as "0°" that only Reset could clear. Roll was
                    // never reported at all, so spinning the tenon also read 0°.
                    const toDeg = (rad: number) => Math.round((rad * 180) / Math.PI * 10) / 10;
                    const leanDeg = toDeg(state.tenonTiltRad);
                    const rollDeg = toDeg(state.tenonRollRad);
                    if (leanDeg === 0 && rollDeg === 0) return null;
                    const parts = [
                      leanDeg !== 0 ? `${leanDeg}° lean` : null,
                      rollDeg !== 0 ? `${rollDeg}° roll` : null,
                    ].filter(Boolean);
                    return (
                      <div className="flex items-center justify-between gap-2">
                        <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                          {`Aim: ${parts.join(', ')}`}
                        </span>
                        <button
                          type="button"
                          className="ui-button ui-button-secondary !h-6 whitespace-nowrap px-1.5 text-[10px]"
                          onClick={() => setState({ tenonTiltRad: 0, tenonRollRad: 0 })}
                          disabled={disabled || isApplying}
                          title="Reset the tenon to point straight out of the cut (no lean / roll)."
                        >
                          Reset Aim
                        </button>
                      </div>
                    );
                  })()}
                  {/* Recentre. Like the aim above, WHERE the tenon sits is set in
                      the viewport (drag the blue dot at its base), so there is
                      nothing to show until it has actually been moved. The place
                      itself is a point in model space — a pair of millimetre
                      readouts would be measuring it against an origin the user
                      cannot see, which is what it used to do. */}
                  {(() => {
                    if (!state.tenonAnchor) return null;
                    return (
                      <div className="flex items-center justify-between gap-2">
                        <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                          Moved off centre
                        </span>
                        <button
                          type="button"
                          className="ui-button ui-button-secondary !h-6 whitespace-nowrap px-1.5 text-[10px]"
                          onClick={() => setState({ tenonAnchor: null })}
                          disabled={disabled || isApplying}
                          title="Put the tenon back in the middle of the cut."
                        >
                          Center
                        </button>
                      </div>
                    );
                  })()}
                  {/* The four size knobs sit two per row: they are short numeric
                      fields and a single column wasted half the panel's width. */}
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                    {/* Width — frustum: sets just width; dome: ratio-locks depth
                        when Uniform Scale is on. */}
                    <div>
                      <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Tenon Width</label>
                      <ScrollableNumberField
                        value={state.tenonWidthMm}
                        onChange={(value) =>
                          state.tenonShape === 'dome'
                            ? setDomeDim('width', value)
                            : setFrustumDim('width', value)
                        }
                        min={tenonDimMinMm}
                        max={TENON_DIM_MAX_MM}
                        step={0.5}
                        unit="mm"
                        ariaLabel="Tenon width in millimeters"
                        compact
                        disabled={disabled || isApplying}
                        className="mt-1"
                      />
                    </div>
                    {/* Depth — applies to BOTH shapes now (dome bulge into the body
                        / frustum tenon depth). Dome ratio-locks width when Uniform. */}
                    <div>
                      <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Tenon Depth</label>
                      <ScrollableNumberField
                        value={state.tenonDepthMm}
                        onChange={(value) =>
                          state.tenonShape === 'dome'
                            ? setDomeDim('depth', value)
                            : setFrustumDim('depth', value)
                        }
                        min={tenonDimMinMm}
                        max={TENON_DIM_MAX_MM}
                        step={0.5}
                        unit="mm"
                        ariaLabel="Tenon depth in millimeters"
                        compact
                        disabled={disabled || isApplying}
                        className="mt-1"
                      />
                    </div>
                    {/* Edge Fillet: frustum only (a dome is already fully round). */}
                    {state.tenonShape === 'frustum' && (
                      <div>
                        <label
                          className="ui-meta block"
                          style={{ color: 'var(--text-muted)' }}
                          title={`Rounds the tenon's corners and tip. On this tenon the geometry accepts up to ${tenonFilletMaxMm}mm — a wider or deeper tenon raises that ceiling.`}
                        >
                          Edge Fillet
                        </label>
                        <ScrollableNumberField
                          value={state.tenonFilletMm}
                          onChange={(value) => setState({ tenonFilletMm: clampFloat(value, 0, tenonFilletMaxMm, 2) })}
                          min={0}
                          max={tenonFilletMaxMm}
                          step={TENON_FILLET_STEP_MM}
                          unit="mm"
                          ariaLabel="Tenon edge fillet radius in millimeters (0 = sharp)"
                          compact
                          disabled={disabled || isApplying}
                          className="mt-1"
                        />
                      </div>
                    )}
                    {/* Fit tolerance: applies to BOTH shapes — the mortise is carved
                        this much larger than the tenon on every face. The print-fit
                        knob: the tenon's own size is what the user drew, this is the
                        slack around it. */}
                    <div className={state.tenonShape === 'frustum' ? undefined : 'col-span-2'}>
                      <label
                        className="ui-meta block"
                        style={{ color: 'var(--text-muted)' }}
                        title="Slack between tenon and mortise, on every face. 0 = press fit (needs force). 0.1mm is a slide fit on a well-calibrated printer; raise it if the halves won't go together."
                      >
                        Fit Tolerance
                      </label>
                      <ScrollableNumberField
                        value={state.tenonToleranceMm}
                        onChange={(value) =>
                          setState({ tenonToleranceMm: clampFloat(value, 0, TENON_TOLERANCE_MAX_MM, 2) })
                        }
                        min={0}
                        max={TENON_TOLERANCE_MAX_MM}
                        step={0.05}
                        unit="mm"
                        ariaLabel="Tenon to mortise fit tolerance in millimeters (0 = press fit)"
                        compact
                        disabled={disabled || isApplying}
                        className="mt-1"
                      />
                    </div>
                  </div>
                  {/* Uniform Scale: dome only — lock width:depth so the dome resizes
                      as a unit (keeps its shape), or unlock for free oblong control. */}
                  {state.tenonShape === 'dome' && (
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 text-left"
                      onClick={() => setState({ tenonUniformScale: !state.tenonUniformScale })}
                      disabled={disabled || isApplying}
                      title="Lock width and depth together so the dome keeps its shape when resized. Unlock for an oblong dome."
                    >
                      <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Uniform Scale</span>
                      <span
                        className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                        style={{
                          background: state.tenonUniformScale
                            ? 'var(--accent)'
                            : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                        }}
                      >
                        <span
                          className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                          style={{ transform: state.tenonUniformScale ? 'translateX(14px)' : 'translateX(2px)' }}
                        />
                      </span>
                    </button>
                  )}
                </div>
              )}

              {/* Won't-fit alert. There is only one tier now: the tenon goes in as
                  asked, or it doesn't go in and this says which way it doesn't fit
                  and by how much. (It used to have three, because the cut used to
                  shrink the tenon or swap it for a half-sphere behind the user's
                  back and had to confess to it afterwards.) */}
              {state.generateTenon && !tenonFits && tenonDetail && (
                <div
                  className="rounded border px-2 py-1.5 text-[10px] leading-snug"
                  style={{
                    borderColor: 'color-mix(in srgb, #b3121b, var(--border-subtle) 40%)',
                    background: 'color-mix(in srgb, #b3121b, var(--surface-1) 88%)',
                    color: 'var(--text-strong)',
                  }}
                >
                  {tenonDetail}
                </div>
              )}
            </div>
          {/* Multi-loop cut (contour only): a list of loops, each editable. Switch
              between them to adjust any one; Cut severs them all at once. This is
              how you free a part connected in several places — e.g. a tail joined
              to the body at two posts with an air gap between — where a single
              loop can't span the gap cleanly. */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <div className="flex items-center justify-between gap-2">
                <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                  Loops{loopCount > 1 ? ` (${loopCount})` : ''}
                </span>
                {canRemoveLoop && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-6 whitespace-nowrap px-1.5 text-[10px] disabled:opacity-60"
                    onClick={() => onRemoveLoop?.(activeLoopIndex)}
                    disabled={disabled || isApplying}
                    title="Remove the loop you're editing."
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {loopSummaries.map((s) => {
                  const isActive = s.index === activeLoopIndex;
                  const incomplete = s.pointCount < 3;
                  return (
                    <button
                      key={s.index}
                      type="button"
                      className="ui-button ui-button-secondary !h-7 !min-w-7 whitespace-nowrap px-1.5 text-[10px] disabled:opacity-60"
                      onClick={() => onSelectLoop?.(s.index)}
                      disabled={disabled || isApplying}
                      style={
                        isActive
                          ? activeModeStyle
                          : incomplete
                            ? { borderStyle: 'dashed', color: 'var(--text-muted)' }
                            : undefined
                      }
                      title={
                        `Loop ${s.index + 1} — ${s.pointCount} point${s.pointCount === 1 ? '' : 's'}` +
                        (s.hasTenon ? ', tenoned' : '') +
                        (incomplete ? ' (needs 3+ to cut)' : '') +
                        (isActive ? ' — editing' : ' — click to edit')
                      }
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {s.index + 1}
                        {s.hasTenon && (
                          <span
                            aria-hidden
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{ background: isActive ? 'currentColor' : 'var(--accent)' }}
                            title="This loop has a registration tenon"
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-7 !min-w-7 whitespace-nowrap px-1.5 text-[11px] disabled:opacity-60"
                  onClick={onAddLoop}
                  disabled={disabled || isApplying || !canAddLoop}
                  title="Add another loop and start drawing it. On Cut, every loop is cut together — use it to free a part attached in several places (e.g. a tail joined at two posts)."
                >
                  +
                </button>
              </div>
              {loopCount > 1 && (
                <div className="ui-meta leading-snug" style={{ color: 'var(--text-muted)' }}>
                  Cut severs all loops at once. Click a number to edit that loop —
                  its tenon settings (below) and waypoints are its own. A dot marks a
                  loop that has a tenon.
                </div>
              )}
            </div>
          )}

          {/* Snap to edges: pull every waypoint onto the model's
              nearest sharp crease/boundary, for tidying points placed roughly in
              a fold. No-op when the model has no sharp edges. */}
          <button
            type="button"
            className="ui-button ui-button-secondary w-full !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
            onClick={onSnapToEdges}
            disabled={disabled || isApplying || !canSnapToEdges}
            title="Nudge every waypoint onto the model's nearest sharp edge (crease or boundary), preferring a corner where several edges meet — for points placed roughly in a crease or corner. Does nothing on a smooth model with no sharp edges. Double-click a waypoint to lock it (white cage) so snap leaves it where it is."
          >
            Snap to edges
          </button>
          <div className="text-[9px] sm:text-[10px] text-neutral-400 leading-tight text-center -mt-1">
            Double-click a waypoint to lock it from snapping.
          </div>

        </div>

        {/* Actions stay pinned below the scroll area: Cut must be reachable
            without scrolling to the bottom of a long panel. */}
        <div
          className="px-2 pb-2 pt-2 sm:px-2.5 sm:pb-2.5 border-t"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {/* Why the last cut refused. It belongs HERE, by the button that just did
              nothing — the reason used to go to stderr, so from the user's side the
              cut either silently failed or (worse) came back as a plane cut through
              the whole model that nobody asked for. */}
          {cutError && (
            <div
              role="alert"
              className="mb-2 flex items-start gap-2 rounded border px-2.5 py-2 text-[11px] leading-snug"
              style={{
                borderColor: 'color-mix(in srgb, #b3121b, var(--border-subtle) 25%)',
                background: 'color-mix(in srgb, #b3121b, var(--surface-1) 80%)',
                color: 'var(--text-strong)',
              }}
            >
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" style={{ color: '#ff6b6b' }} />
              <span>{cutError}</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onClearLoop}
              disabled={disabled || isApplying || !loopSummaries.some((s) => s.pointCount > 0)}
              title="Discard every loop in this cut, not just the active one."
            >
              Clear all
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onApply}
              disabled={disabled || isApplying || !canApply || tenonBlocksCut}
              title={tenonBlocksCut ? tenonDetail : undefined}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {isApplying && <Loader2 className="h-3 w-3 animate-spin" />}
                <span>{isApplying ? 'Cutting...' : 'Cut'}</span>
              </span>
            </button>
          </div>
        </div>
        </>
      )}
    </Card>
  );
}
