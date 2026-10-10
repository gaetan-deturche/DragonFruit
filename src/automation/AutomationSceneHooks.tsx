import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { getAllModelMeshes, getModelMesh } from '@/supports/autoSupport/meshStore';

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

/**
 * Optional framing target. Without it the camera frames the whole plate (all
 * models down to Z=0), which makes small parts and fine detail unreadable in a
 * capture. `modelId` frames one model; `center` + `radiusMm` frames an arbitrary
 * region (e.g. one island or one support) for close inspection.
 */
export interface ViewFocus {
    modelId?: string;
    center?: { x: number; y: number; z: number };
    radiusMm?: number;
}

interface DfAutomationImpl {
    captureViewport: () => string | null;
    setView: (preset: ViewPreset, focus?: ViewFocus) => void;
    fit: (focus?: ViewFocus) => void;
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

/** Target point + framing radius for a focus request (whole plate when none). */
function focusSphere(focus?: ViewFocus): { target: THREE.Vector3; radius: number } {
    if (focus?.center) {
        const c = focus.center;
        return { target: new THREE.Vector3(c.x, c.y, c.z), radius: Math.max(focus.radiusMm ?? 5, 0.5) };
    }
    let box: THREE.Box3;
    if (focus?.modelId) {
        const mesh = getModelMesh(focus.modelId);
        if (!mesh) throw new Error(`no model with id ${focus.modelId}`);
        mesh.updateMatrixWorld();
        box = new THREE.Box3().setFromObject(mesh);
        // Include the support zone under the model, but not the whole plate.
        if (box.min.z > 0) box.min.z = Math.max(0, box.min.z - Math.min(box.min.z, 10));
    } else {
        box = modelBounds();
    }
    const target = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? 80 : box.getSize(new THREE.Vector3()).length() / 2;
    return { target, radius: Math.max(focus?.radiusMm ?? size, 0.5) };
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
            setView: (preset, focus) => {
                const { target, radius } = focusSphere(focus);
                const d = VIEW_DIRS[preset] ?? VIEW_DIRS.iso;
                frameCamera(camera, controls, new THREE.Vector3(d[0], d[1], d[2]), target, radius);
            },
            fit: (focus) => {
                const { target, radius } = focusSphere(focus);
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
            setView: (p, f) => implRef.current?.setView(p, f),
            fit: (f) => implRef.current?.fit(f),
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
    // Distance at which a sphere of `radius` just fills the narrower view axis,
    // plus a small margin — the old `+ radius * 1.5` left most of the frame empty.
    const persp2 = camera as THREE.PerspectiveCamera;
    const aspect = persp2.isPerspectiveCamera && persp2.aspect > 0 ? persp2.aspect : 1;
    const halfFov = aspect < 1 ? Math.atan(Math.tan(fov / 2) * aspect) : fov / 2;
    const dist = (radius / Math.sin(halfFov)) * 1.08;
    camera.up.set(0, 0, 1);
    camera.position.copy(target).addScaledVector(dir.clone().normalize(), dist);
    camera.lookAt(target);
    if (controls?.target) {
        controls.target.copy(target);
        controls.update?.();
    }
    if (persp.isPerspectiveCamera) {
        persp.near = Math.max(0.05, dist - radius * 4);
        persp.far = dist + radius * 8;
        persp.updateProjectionMatrix();
    }
    const ortho = camera as THREE.OrthographicCamera;
    if (ortho.isOrthographicCamera) {
        // Moving an orthographic camera closer does not magnify — zoom does.
        const halfW = Math.abs(ortho.right - ortho.left) / 2;
        const halfH = Math.abs(ortho.top - ortho.bottom) / 2;
        ortho.zoom = Math.max(0.01, Math.min(halfW, halfH) / (radius * 1.08));
        ortho.updateProjectionMatrix();
    }
}
