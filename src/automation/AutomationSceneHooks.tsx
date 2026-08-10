import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { getAllModelMeshes } from '@/supports/autoSupport/meshStore';

/**
 * Registers viewport-capture and camera-control functions on
 * `window.__dfAutomation` so the automation bridge (which lives outside the
 * R3F tree) can screenshot the live viewport and move the camera.
 *
 * The public functions are STABLE thin wrappers registered once; they delegate
 * to a ref that is refreshed every render. That keeps the API hot-reloadable —
 * editing the capture/camera logic below takes effect without an app restart.
 *
 * The main Canvas is created with `preserveDrawingBuffer: true`, so a
 * post-render `toDataURL` reliably captures the current frame.
 */

type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

interface DfAutomationImpl {
    captureViewport: () => string | null;
    setView: (preset: ViewPreset) => void;
    fit: () => void;
    getControlsState: () => { enabled?: boolean; enableRotate?: boolean; enablePan?: boolean; enableZoom?: boolean } | null;
}

declare global {
    interface Window {
        __dfAutomation?: DfAutomationImpl;
    }
}

// World is Z-up (build plate = XY, Z = height). Directions the camera sits along.
const VIEW_DIRS: Record<ViewPreset, [number, number, number]> = {
    top: [0.001, 0.001, 1],
    bottom: [0.001, 0.001, -1],
    front: [0, -1, 0],
    back: [0, 1, 0],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    iso: [1, -1, 0.8],
};

function modelBounds(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const mesh of getAllModelMeshes()) {
        mesh.updateMatrixWorld();
        box.expandByObject(mesh);
    }
    // Extend down to the plate so supports (which run from the model to Z=0)
    // stay in frame when inspecting placement.
    if (!box.isEmpty() && box.min.z > 0) {
        box.expandByPoint(new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, 0));
    }
    return box;
}

export function AutomationSceneHooks(): null {
    const gl = useThree((s) => s.gl);
    const scene = useThree((s) => s.scene);
    const camera = useThree((s) => s.camera);
    const controls = useThree((s) => s.controls) as { target?: THREE.Vector3; update?: () => void } | null;

    // Rebuilt after every commit (no dep array) so hot-reloaded logic is picked
    // up by the stable window wrappers below — assigned in an effect, never
    // during render (which react-hooks/refs correctly forbids).
    const implRef = useRef<DfAutomationImpl | null>(null);
    useEffect(() => {
        implRef.current = {
            captureViewport: () => {
                try {
                    gl.render(scene, camera);
                    return gl.domElement.toDataURL('image/png');
                } catch {
                    return null;
                }
            },
            setView: (preset) => {
                const box = modelBounds();
                const target = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
                const radius = box.isEmpty() ? 40 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
                const d = VIEW_DIRS[preset] ?? VIEW_DIRS.iso;
                frameCamera(camera, controls, new THREE.Vector3(d[0], d[1], d[2]), target, radius);
            },
            fit: () => {
                const box = modelBounds();
                const target = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
                const radius = box.isEmpty() ? 40 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
                const dir = camera.position.clone().sub(controls?.target ?? target);
                if (dir.lengthSq() < 1e-6) dir.set(1, -1, 0.8);
                frameCamera(camera, controls, dir, target, radius);
            },
            getControlsState: () => {
                const c = controls as unknown as { enabled?: boolean; enableRotate?: boolean; enablePan?: boolean; enableZoom?: boolean } | null;
                if (!c) return null;
                return { enabled: c.enabled, enableRotate: c.enableRotate, enablePan: c.enablePan, enableZoom: c.enableZoom };
            },
        };
    });

    useEffect(() => {
        window.__dfAutomation = {
            captureViewport: () => implRef.current?.captureViewport() ?? null,
            setView: (p) => implRef.current?.setView(p),
            fit: () => implRef.current?.fit(),
            getControlsState: () => implRef.current?.getControlsState() ?? null,
        };
        return () => {
            if (window.__dfAutomation) delete window.__dfAutomation;
        };
    }, []);

    return null;
}

function frameCamera(
    camera: THREE.Camera,
    controls: { target?: THREE.Vector3; update?: () => void } | null,
    dir: THREE.Vector3,
    target: THREE.Vector3,
    radius: number,
): void {
    const persp = camera as THREE.PerspectiveCamera;
    const fov = (persp.isPerspectiveCamera ? persp.fov : 45) * (Math.PI / 180);
    const dist = (radius / Math.sin(fov / 2)) * 1.2 + radius * 1.5;
    camera.up.set(0, 0, 1);
    camera.position.copy(target).addScaledVector(dir.clone().normalize(), dist);
    camera.lookAt(target);
    if (controls?.target) {
        controls.target.copy(target);
        controls.update?.();
    }
    if (persp.isPerspectiveCamera) {
        persp.near = Math.max(0.1, dist - radius * 4);
        persp.far = dist + radius * 8;
        persp.updateProjectionMatrix();
    }
}
