import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

/**
 * Self-heal for a camera-controls race.
 *
 * Several camera-animation controllers (focus, home-reset, STL-load auto-frame…)
 * each snapshot `controls.enabled` / `enableRotate|Pan|Zoom`, force them false
 * for the duration of their animation, then restore the snapshot. When two
 * animations overlap in time — e.g. loading models in quick succession — one
 * controller snapshots ANOTHER's transient "disabled" state and later restores
 * it permanently. Orbit then stays dead while selection (a click raycast, not an
 * OrbitControls drag) still works. Confirmed reproducible: after rapid loads
 * `controls.enabled` stuck `false` at rest (see automation `getControlsState`).
 *
 * Rather than coordinate every controller (systemic, error-prone), we watch for
 * the SYMPTOM: controls disabled while the camera is perfectly still. A real
 * camera animation moves the camera every frame, so "disabled AND not moving for
 * a few hundred ms" can only be a stuck restore — so we re-enable orbit.
 *
 * Uses setInterval (not useFrame) so it heals even under on-demand rendering,
 * where the render loop is paused while the scene is idle.
 */

interface OrbitLike {
    enabled?: boolean;
    enableRotate?: boolean;
    enablePan?: boolean;
    enableZoom?: boolean;
}

const POLL_MS = 200;
const STILL_DISABLED_TICKS_TO_HEAL = 2; // ~400ms disabled + camera still => stuck

export function CameraControlsWatchdog(): null {
    const controls = useThree((s) => s.controls) as OrbitLike | null;
    const camera = useThree((s) => s.camera);

    useEffect(() => {
        if (!controls) return;
        const c = controls;
        let lastX = NaN, lastY = NaN, lastZ = NaN;
        let stillDisabledTicks = 0;

        const id = setInterval(() => {
            const p = camera.position;
            const moved = p.x !== lastX || p.y !== lastY || p.z !== lastZ;
            lastX = p.x; lastY = p.y; lastZ = p.z;

            const disabled = c.enabled === false
                || c.enableRotate === false
                || c.enablePan === false
                || c.enableZoom === false;

            if (disabled && !moved) {
                stillDisabledTicks += 1;
                if (stillDisabledTicks >= STILL_DISABLED_TICKS_TO_HEAL) {
                    c.enabled = true;
                    c.enableRotate = true;
                    c.enablePan = true;
                    c.enableZoom = true;
                    stillDisabledTicks = 0;
                }
            } else {
                stillDisabledTicks = 0;
            }
        }, POLL_MS);

        return () => clearInterval(id);
    }, [controls, camera]);

    return null;
}
