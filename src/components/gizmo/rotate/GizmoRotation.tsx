"use client";

import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { ThreeEvent, useThree, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { GIZMO_COLORS, GIZMO_SIZES, GIZMO_LIGHTING } from '../constants';
import {
  DIAL_ANATOMY,
  emittedDeltaForSweep,
  distancePointToLine,
  polarToLocal,
  rayToRingLocal,
  resolveDialAngle,
  ringGroupEuler,
  shortestAngleDelta,
  type DialSnapTarget,
} from './rotationDialModel';
import { RotationDial } from './RotationDial';
import type { GizmoAxis } from '../types';
import {
  getCachedConeGeometry,
  getCachedRotationArcGeometry,
  getCachedRotationArcPoints,
  getCachedSphereGeometry,
} from '../gizmoGeometryCache';
import { usePicking } from '@/components/picking';
import type { GizmoHandleType } from '@/components/picking/types';

/**
 * Radius around the projected gizmo centre where the pointer's angle is not a
 * signal at all: at a couple of pixels out, one pixel of travel swings it by a
 * quadrant, so it is pixel quantisation rather than intent.
 *
 * Deliberately small. The old drag accumulated screen-space deltas and needed a
 * 24px dead zone plus a "no jump larger than 90 degrees near the centre" guard,
 * because one bad sample there poisoned the accumulator for the rest of the
 * gesture. This drag reads the pointer's angle absolutely, so a bad sample is
 * just one frame and the next one is right — and swallowing samples across the
 * centre would break the rule that the moving radius follows the pointer
 * everywhere, magnet or no magnet.
 */
const ROTATION_CENTER_SINGULARITY_PX = 8;
/**
 * Pointer travel below this keeps the sweep pinned at the dial's zero.
 *
 * Without it a press that never meant to rotate — a click, or the pixel of
 * jitter a mouse produces while a button goes down — would resolve to an angle a
 * fraction off zero and commit it, since the sweep tracks the pointer's absolute
 * angle rather than accumulating deltas.
 */
const DIAL_MOVE_SLOP_PX = 3;

// Scratch objects for pointer resolution during a drag; reused, never retained.
const dragRaycaster = new THREE.Raycaster();
const dragNdc = new THREE.Vector2();
const ringCenter = new THREE.Vector3();
const markPoint = new THREE.Vector3();

interface GizmoRotationProps {
  axis: GizmoAxis;
  isHovered?: boolean;
  isActive?: boolean;
  isDimmed?: boolean;
  isHidden?: boolean;
  suppressHover?: boolean;
  opacityScale?: number;
  interactionsEnabled?: boolean;
  suppressAxisAnimations?: boolean;
  enableLighting?: boolean;
  gizmoPosition: THREE.Vector3;
  disableRingBillboard?: boolean;
  /** Scale factor for the rotation handle (diamond cones and pick sphere) relative to gizmo size */
  handleScale?: number;
  /**
   * Optional override for the visual animation sign.
   * Set to -1 to invert the ring handle animation direction relative to the
   * object rotation (e.g. when the gizmo local frame has an inverted axis
   * convention like displayY = -cutterY in HolePunchGizmo).
   */
  axisVisualFlip?: number;
  /**
   * True when the PARENT turns the whole gizmo by this very rotation — the tenon's
   * roll ring, whose frame is built from the roll it is setting. The ring then
   * already carries the movement on screen, and a handle that also advanced inside
   * it would travel twice as far as the pointer and overtake it.
   */
  frameCarriesRotation?: boolean;
  onDragStart: () => boolean | void;
  /**
   * Turn the object by this much. Return how much of it the object ACTUALLY took
   * when the rotation has a hard end (the tenon's lean stops where the geometry
   * stops); return nothing and all of it is assumed to have gone through.
   */
  onDrag: (angle: number) => number | void;
  onDragEnd: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

function getPositiveAxisMidpointAngle(axis: GizmoAxis): number {
  if (axis === 'x') {
    // X rotation lives in the Y/Z plane. In X-ring local space,
    // +Y is local +Y and +Z is local -X.
    return (3 * Math.PI) / 4;
  }
  if (axis === 'y') {
    // Y rotation lives in the X/Z plane. With the +Y ring orientation,
    // +X is local +X and +Z is local -Y.
    return -Math.PI / 4;
  }
  // Z rotation lives in the X/Y plane, directly between local +X and +Y.
  return Math.PI / 4;
}

/**
 * GizmoRotation - Ring with diamond handle for rotation
 *
 * Holding the handle raises a protractor dial (see RotationDial) anchored at the
 * angle the handle was grabbed at. The sweep is the pointer's angle IN THE RING'S
 * PLANE, measured from that anchor, and it is magnetised onto the dial's marks —
 * so the rotation the gesture applies is always relative to wherever the model
 * already was.
 *
 * The pointer is resolved by intersecting its ray with the ring's own plane
 * rather than by accumulating screen-space deltas around the projected centre.
 * That is what lets the moving radius sit exactly under the pointer and the
 * magnet measure against the marks where they are actually drawn; it also drops
 * the old camera-side flip entirely, since an angle read in the ring's frame is
 * already correct from either side of the plane.
 */
export function GizmoRotation({
  axis,
  isHovered,
  isActive,
  isDimmed,
  isHidden,
  suppressHover = false,
  opacityScale = 1,
  interactionsEnabled = true,
  suppressAxisAnimations = false,
  enableLighting = true,
  gizmoPosition,
  disableRingBillboard = false,
  handleScale = 1.0,
  axisVisualFlip = 1,
  frameCarriesRotation = false,
  onDragStart,
  onDrag,
  onDragEnd,
  onPointerEnter,
  onPointerLeave,
}: GizmoRotationProps) {
  const [isDragging, setIsDragging] = useState(false);
  const positiveAxisMidpointAngle = getPositiveAxisMidpointAngle(axis);
  const handleAngleRef = useRef<number>(positiveAxisMidpointAngle);
  const targetHandleAngleRef = useRef<number>(positiveAxisMidpointAngle);
  const billboardRotationRef = useRef<number>(0);
  /** Root of the ring's local frame — the dial and the pointer maths read its world pose. */
  const ringGroupRef = useRef<THREE.Group>(null);
  /** Group carrying the dial's moving radius; rotated imperatively per pointer sample. */
  const sweepGroupRef = useRef<THREE.Group>(null);
  /** Ring-local angle the dial is anchored at: where the handle was grabbed. */
  const dialZeroRef = useRef<number>(0);
  /** Same value for rendering. Non-null exactly while the dial is up. */
  const [dialZero, setDialZero] = useState<number | null>(null);
  /** Dial-relative angle last applied, wrapped. Deltas are measured from it. */
  const prevTargetRef = useRef<number>(0);
  /** Unwrapped sweep since the grab, so multi-turn drags keep counting up. */
  const sweepAccumRef = useRef<number>(0);
  /** Mark the magnet is holding. Ref drives the maths, state drives the drawing. */
  const heldRef = useRef<DialSnapTarget | null>(null);
  const [heldMark, setHeldMark] = useState<DialSnapTarget | null>(null);
  /** Screen position of the press, for the click slop. */
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Mirror of isDragging for the pointer handlers.
   *
   * A ref, not the state: these are R3F handlers firing mid-gesture, and the
   * hint has to be suppressed by what is true right now rather than by what the
   * last render captured.
   */
  const isDraggingRef = useRef(false);
  // Callback refs to stabilize useEffect deps (prevents effect churn during drag)
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const rotatingArcRef = useRef<THREE.Group>(null);
  const handleRootRef = useRef<THREE.Group>(null);
  const billboardGroupRef = useRef<THREE.Group>(null);
  const pointLightRef = useRef<THREE.PointLight>(null);
  const { camera, gl } = useThree();

  useEffect(() => {
    onDragRef.current = onDrag;
    onDragEndRef.current = onDragEnd;
  }, [onDrag, onDragEnd]);

  // GPU Picking registration
  const pickMeshRef = useRef<THREE.Mesh>(null);
  const pickIdRef = useRef<number | null>(null);
  const { register, unregister, hit } = usePicking();

  // Map axis to gizmo handle type
  const handleType: GizmoHandleType = `rotate-${axis}` as GizmoHandleType;

  // Register with picking system
  useEffect(() => {
    if (!pickMeshRef.current) return;

    pickIdRef.current = register({
      category: 'gizmo',
      objectId: null,
      gizmoHandle: handleType,
      object: pickMeshRef.current,
    });

    return () => {
      if (pickIdRef.current !== null) {
        unregister(pickIdRef.current);
        pickIdRef.current = null;
      }
    };
  }, [register, unregister, handleType]);

  // Check if this handle is hovered via GPU picking
  const isPickingHovered = !suppressHover && hit.category === 'gizmo' &&
    'gizmoHandle' in hit &&
    hit.gizmoHandle === handleType;

  // Get colors for this axis
  const ringColors = axis === 'x' ? GIZMO_COLORS.xRing : axis === 'y' ? GIZMO_COLORS.yRing : GIZMO_COLORS.zRing;
  const axisColors = axis === 'x' ? GIZMO_COLORS.xAxis : axis === 'y' ? GIZMO_COLORS.yAxis : GIZMO_COLORS.zAxis;

  const getCameraAlignedAngle = useCallback(() => {
    const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();

    if (axis === 'x') {
      return Math.atan2(cameraDir.z, cameraDir.y) + Math.PI / 2;
    }
    if (axis === 'y') {
      // The Y ring is rotated into the X/Z plane with local +Y mapped to
      // world -Z, so project camera Z with the matching sign.
      return Math.atan2(-cameraDir.z, cameraDir.x);
    }
    return Math.atan2(cameraDir.y, cameraDir.x);
  }, [axis, camera.position, gizmoPosition]);

  React.useEffect(() => {
    if (disableRingBillboard) {
      if (isDragging) return;
      // Center the active arc between the two positive arrow axes after
      // the drag completes so the handle stays aligned with the new frame.
      handleAngleRef.current = positiveAxisMidpointAngle;
      targetHandleAngleRef.current = positiveAxisMidpointAngle;
      return;
    }
    if (!suppressAxisAnimations || isDragging) return;
    const aligned = getCameraAlignedAngle();
    handleAngleRef.current = aligned;
    targetHandleAngleRef.current = aligned;

    const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
    billboardRotationRef.current = Math.atan2(cameraDir.y, cameraDir.x);
  }, [camera.position, getCameraAlignedAngle, gizmoPosition, isDragging, positiveAxisMidpointAngle, suppressAxisAnimations, disableRingBillboard]);

  // Ref-based temporal smoothing to avoid micro-shimmer from per-frame React state updates.
  useFrame(() => {
    if (!isDragging && !disableRingBillboard) {
      targetHandleAngleRef.current = getCameraAlignedAngle();
    }

    let delta = targetHandleAngleRef.current - handleAngleRef.current;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    const smoothing = isDragging || suppressAxisAnimations ? 1 : 0.2;
    handleAngleRef.current += delta * smoothing;

    const handleAngle = handleAngleRef.current;
    const radius = GIZMO_SIZES.ringMajorRadius;
    const hx = Math.cos(handleAngle) * radius;
    const hy = Math.sin(handleAngle) * radius;

    if (rotatingArcRef.current) {
      rotatingArcRef.current.rotation.z = handleAngle;
    }

    if (handleRootRef.current) {
      handleRootRef.current.position.set(hx, hy, 0);
      handleRootRef.current.rotation.set(0, 0, handleAngle + Math.PI / 2);
    }

    if (pickMeshRef.current) {
      pickMeshRef.current.position.set(hx, hy, 0);
    }

    if (pointLightRef.current) {
      pointLightRef.current.position.set(hx, hy, 0);
    }

    if (!disableRingBillboard) {
      const cameraDir = new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
      const billboardTarget = Math.atan2(cameraDir.y, cameraDir.x);
      if (suppressAxisAnimations) {
        billboardRotationRef.current = billboardTarget;
      } else {
        billboardRotationRef.current += (billboardTarget - billboardRotationRef.current) * 0.2;
      }
      if (billboardGroupRef.current) {
        billboardGroupRef.current.rotation.x = billboardRotationRef.current;
      }
    }
  }, -1);

  // Ring-local frame orientation — the same source the dial and the rotation
  // sign are derived from, so drawing and maths cannot disagree.
  const rotation = ringGroupEuler(axis);

  const initialHandlePos: [number, number, number] = [
    Math.cos(positiveAxisMidpointAngle) * GIZMO_SIZES.ringMajorRadius,
    Math.sin(positiveAxisMidpointAngle) * GIZMO_SIZES.ringMajorRadius,
    0,
  ];

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Ignore right-click to allow camera orbit controls
    if (e.button === 2) {
      return;
    }
    if (!interactionsEnabled) {
      return;
    }

    e.stopPropagation();
    e.stopped = true; // Mark event as handled for OrbitControls

    const allowed = onDragStart();
    if (allowed === false) {
      return;
    }

    // Anchor the dial where the handle visually is. Zero of the dial, zero of
    // the sweep and the handle are then the same place, which is what makes the
    // gesture relative: the marks count degrees away from the model's current
    // rotation, not away from any absolute reference.
    dialZeroRef.current = handleAngleRef.current;
    setDialZero(handleAngleRef.current);
    prevTargetRef.current = 0;
    sweepAccumRef.current = 0;
    // Seed the magnet holding the zero mark. The handle sits exactly on it, so
    // the first few pixels of drag stay at zero instead of jumping to whichever
    // neighbouring mark the press happened to land nearest.
    const zeroHold: DialSnapTarget = { angleRad: 0, tier: 'long' };
    heldRef.current = zeroHold;
    setHeldMark(zeroHold);
    pressPointRef.current = { x: e.clientX, y: e.clientY };

    isDraggingRef.current = true;
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: false } }));
    setIsDragging(true);
  };

  const handlePointerEnterLocal = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return;
    e.stopPropagation();
    onPointerEnter();
    // The handle rides the sweep, so it keeps arriving under the pointer and
    // re-firing this while the gesture is running. Announcing "drag to rotate"
    // on top of the dial you are already dragging is pure noise.
    if (isDraggingRef.current) return;
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: true, axis } }));
  };

  const handlePointerLeaveLocal = (e: ThreeEvent<PointerEvent>) => {
    if (!interactionsEnabled) return;
    e.stopPropagation();
    onPointerLeave();
    window.dispatchEvent(new CustomEvent('dragonfruit:rotation-hint', { detail: { visible: false } }));
  };

  // Global pointer move and up listeners during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalPointerMove = (e: PointerEvent) => {
      const press = pressPointRef.current;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DIAL_MOVE_SLOP_PX) return;

      const ringGroup = ringGroupRef.current;
      if (!ringGroup) return;
      // The world matrix, not rotation plus position: the gizmo root is scaled to
      // keep a constant size on screen, and both the corona test and the mark
      // positions have to go through that scale. See rayToRingLocal.
      const ringMatrix = ringGroup.matrixWorld;
      ringCenter.setFromMatrixPosition(ringMatrix);

      const rect = gl.domElement.getBoundingClientRect();
      const toScreen = (point: THREE.Vector3) => {
        const projected = point.clone().project(camera);
        return {
          x: rect.left + ((projected.x + 1) * 0.5) * rect.width,
          y: rect.top + ((1 - projected.y) * 0.5) * rect.height,
        };
      };

      const centerScreen = toScreen(ringCenter);
      // The angle around the projected centre is meaningless this close in.
      if (Math.hypot(e.clientX - centerScreen.x, e.clientY - centerScreen.y) < ROTATION_CENTER_SINGULARITY_PX) return;

      dragNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1),
      );
      dragRaycaster.setFromCamera(dragNdc, camera);
      const hitPlane = rayToRingLocal(
        dragRaycaster.ray.origin,
        dragRaycaster.ray.direction,
        ringMatrix,
      );
      // Nearly edge-on ring: hold the previous angle rather than inventing one.
      if (!hitPlane) return;

      const cursorAngleRel = shortestAngleDelta(dialZeroRef.current, hitPlane.angleRad);

      const resolved = resolveDialAngle({
        cursorAngleRad: cursorAngleRel,
        cursorRadius: hitPlane.radius,
        held: heldRef.current,
        gapPxForAngle: (markAngleRel) => {
          const local = polarToLocal(dialZeroRef.current + markAngleRel, DIAL_ANATOMY.rimRadius);
          markPoint.set(local[0], local[1], local[2]).applyMatrix4(ringMatrix);
          return distancePointToLine({ x: e.clientX, y: e.clientY }, centerScreen, toScreen(markPoint));
        },
      });

      const held = heldRef.current;
      if (held?.angleRad !== resolved.held?.angleRad || held?.tier !== resolved.held?.tier) {
        heldRef.current = resolved.held;
        setHeldMark(resolved.held);
      }

      const delta = shortestAngleDelta(prevTargetRef.current, resolved.angleRad);

      if (sweepGroupRef.current) sweepGroupRef.current.rotation.z = resolved.angleRad;
      prevTargetRef.current = resolved.angleRad;

      if (delta !== 0) {
        // What comes back is how much the object actually took. A rotation with a
        // hard end (the tenon's lean stops where the geometry stops) returns less
        // than it was asked for, and the sweep has to stop with it — the dial's own
        // radius keeps following the pointer above, so easing back off the end
        // picks up again straight away, but the reading and the handle must never
        // claim an angle the object never reached.
        const asked = emittedDeltaForSweep(delta, axisVisualFlip);
        const answer = onDragRef.current(asked);
        const applied = typeof answer === 'number' ? answer : asked;
        // Back into dial units, the same mapping run backwards.
        const appliedSweep =
          axisVisualFlip === 0 || applied === asked ? delta : -applied / axisVisualFlip;
        sweepAccumRef.current += appliedSweep;
        // The handle rides the sweep so it stays under the pointer, on the mark
        // when the magnet has it — unless the parent is turning the whole gizmo by
        // this rotation, in which case the ring already carries it and advancing
        // here too would send the handle round at twice the pointer's speed.
        if (!frameCarriesRotation) {
          handleAngleRef.current = dialZeroRef.current + sweepAccumRef.current;
          targetHandleAngleRef.current = handleAngleRef.current;
        }
      }

      // Readout shows the sweep since the grab, which is what the dial measures.
      window.dispatchEvent(new CustomEvent('dragonfruit:snap-angle', {
        detail: { active: true, angle: sweepAccumRef.current, axis },
      }));
    };

    const handleGlobalPointerUp = () => {
      // Remove pointermove synchronously so it can't re-fire active:true before React re-renders
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      isDraggingRef.current = false;
      setIsDragging(false);
      setDialZero(null);
      setHeldMark(null);
      heldRef.current = null;
      pressPointRef.current = null;
      onDragEndRef.current();
      window.dispatchEvent(new CustomEvent('dragonfruit:snap-angle', { detail: { active: false } }));
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
    };
  }, [isDragging, camera, gl, axis, axisVisualFlip]);

  // Use GPU picking hover state OR prop-based hover (fallback)
  const effectiveHovered = !suppressHover && (isPickingHovered || isHovered);
  const isHighlighted = !!(effectiveHovered || isActive);
  const ringIsActive = !!isActive;

  const baseOpacity = isHidden ? 0 : isDimmed ? 0.15 : ringIsActive ? 0.95 : 0.72;
  const opacity = baseOpacity * opacityScale;
  // The dial only exists while the handle is held, and while it shows it damps
  // the arc gradient: the ring is already the busiest part of the gizmo, so the
  // dial has to displace something rather than pile on.
  const dialVisible = dialZero !== null && !isHidden && !isDimmed;
  const arcOpacity = dialVisible ? opacity * 0.4 : opacity;
  const dimmedColor = '#cccccc'; // Light grey for dimmed state
  const diamondPrimaryColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : effectiveHovered
        ? GIZMO_COLORS.hover
        : axisColors.end;
  const diamondSecondaryColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : effectiveHovered
        ? new THREE.Color(GIZMO_COLORS.hover).lerp(new THREE.Color(axisColors.start), 0.35).getStyle()
        : axisColors.start;
  const ringColor = isDimmed
    ? dimmedColor
    : isActive
      ? GIZMO_COLORS.active
      : ringColors.ring;

  // Point light intensity based on state (uses effectiveHovered for GPU picking support)
  const lightIntensity = isActive
    ? GIZMO_LIGHTING.pointLightIntensity.active
    : effectiveHovered
    ? GIZMO_LIGHTING.pointLightIntensity.hovered
    : GIZMO_LIGHTING.pointLightIntensity.idle;

  const frontArcPoints = useMemo(() => getCachedRotationArcPoints('front'), []);
  const backArcPoints = useMemo(() => getCachedRotationArcPoints('back'), []);

  // Ring rotation uses same logic as handle position
  // (The handleAngle already calculated above is what we need)

  const arcGeometry = useMemo(() => getCachedRotationArcGeometry(axis), [axis]);
  const pickGeometry = useMemo(
    () => getCachedSphereGeometry(Math.max(0.18, GIZMO_SIZES.ringDiamondRadius * 0.9 * handleScale), 16, 16),
    [handleScale],
  );
  const diamondConeGeometry = useMemo(
    () => getCachedConeGeometry(GIZMO_SIZES.ringDiamondRadius * 0.36, GIZMO_SIZES.ringDiamondRadius, 16),
    [],
  );

  return (
    <group
      ref={ringGroupRef}
      rotation={rotation}
    >
      {/* Pickable mesh for GPU picking - invisible but rendered in pick pass.
          visible={false} when isHidden disables raycasting so this handle does
          not block pointer events during another gizmo's active drag. */}
      <mesh
        ref={pickMeshRef}
        visible={!isHidden && interactionsEnabled}
        position={initialHandlePos}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnterLocal}
        onPointerLeave={handlePointerLeaveLocal}
      >
        <primitive object={pickGeometry} attach="geometry" />
        <meshBasicMaterial visible={false} />
      </mesh>

      <Line
        points={backArcPoints}
        color={isDimmed ? dimmedColor : ringColor}
        lineWidth={0.8}
        transparent
        opacity={Math.max(0, opacity * 0.26)}
        depthTest={false}
      />

      {/* Protractor dial, anchored at the grab. Mounted in the ring's own frame
          and NOT inside the camera-following arc group below: fixed angular
          positions inside a camera-following frame would drift away from the
          marks they are supposed to measure against. */}
      {dialVisible && (
        <group rotation={[0, 0, dialZero]}>
          <RotationDial
            color={ringColors.ring}
            opacity={0.9 * opacityScale}
            sweepGroupRef={sweepGroupRef}
            held={heldMark}
          />
        </group>
      )}

      {/* Rotating group to keep colored arc facing camera - uses same angle as handle */}
      <group ref={rotatingArcRef}>
        {/* Front arc with gradient - pure color at center, lighter at ends */}
        <mesh geometry={arcGeometry} scale={ringIsActive ? 1.02 : 1.0}>
          <meshBasicMaterial
            vertexColors={!isDimmed}
            color={isDimmed ? dimmedColor : ringColor}
            opacity={arcOpacity}
            transparent
            depthTest={false}
            toneMapped={false}
          />
        </mesh>

        <Line
          points={frontArcPoints}
          color={isDimmed ? dimmedColor : ringColor}
          lineWidth={0.92}
          transparent
          opacity={Math.max(0, arcOpacity * 0.38)}
          depthTest={false}
        />

        {ringIsActive && !isDimmed && !isHidden && (
          <Line
            points={frontArcPoints}
            color={new THREE.Color(ringColor).lerp(new THREE.Color('#ffffff'), 0.35).getStyle()}
            lineWidth={1.34}
            transparent
            opacity={0.22}
            depthTest={false}
          />
        )}
      </group>

      {/* Double-pointed arrow handle (two cones) */}
      <group
        ref={handleRootRef}
        position={initialHandlePos}
        scale={(isHighlighted ? 1.08 : 1.0) * handleScale}
        onPointerDown={interactionsEnabled ? handlePointerDown : undefined}
        onPointerEnter={interactionsEnabled ? handlePointerEnterLocal : undefined}
        onPointerLeave={interactionsEnabled ? handlePointerLeaveLocal : undefined}
      >
        {/* Billboard group to improve arrow readability relative to camera */}
        <group ref={billboardGroupRef}>
          {/* Clockwise-pointing cone along tangent */}
          <group position={[GIZMO_SIZES.ringDiamondRadius * 0.52, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
            {/* Outline - slightly larger with darker color */}
            <mesh scale={1.08}>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={new THREE.Color(diamondPrimaryColor).multiplyScalar(0.3).getHex()}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
            {/* Main colored cone */}
            <mesh>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={diamondPrimaryColor}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
          </group>

          {/* Counter-clockwise-pointing cone along tangent */}
          <group position={[-GIZMO_SIZES.ringDiamondRadius * 0.52, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            {/* Outline - slightly larger with darker color */}
            <mesh scale={1.08}>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={new THREE.Color(diamondSecondaryColor).multiplyScalar(0.32).getHex()}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
            {/* Main colored cone */}
            <mesh>
              <primitive object={diamondConeGeometry} attach="geometry" />
              <meshBasicMaterial
                color={diamondSecondaryColor}
                transparent
                opacity={opacity}
                depthTest={false}
              />
            </mesh>
          </group>
        </group>
      </group>

      {/* Point light at diamond handle to cast colored light on model */}
      {enableLighting && !isDimmed && (
        <pointLight
          ref={pointLightRef}
          position={initialHandlePos}
          color={isActive ? GIZMO_COLORS.active : effectiveHovered ? GIZMO_COLORS.hover : diamondPrimaryColor}
          intensity={lightIntensity}
          distance={GIZMO_LIGHTING.pointLightDistance}
          decay={GIZMO_LIGHTING.pointLightDecay}
        />
      )}
    </group>
  );
}
