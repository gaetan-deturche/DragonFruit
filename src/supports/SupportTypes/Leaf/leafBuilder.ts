import * as THREE from 'three';
import type { Leaf, Knot, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getSettings } from '../../Settings';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';
import { v4 as uuidv4 } from 'uuid';

export interface LeafBuildInput {
    tipPos: Vec3;
    surfaceNormal: Vec3;
    modelId: string;
    parentKnot: Knot;
    hostDiameterMm: number;
    mesh?: THREE.Mesh;
    /** Contact (tip) diameter; defaults to the global tip setting. Auto-support
     *  passes the model's required minimum so leaves hold their share of peel. */
    contactDiameterMm?: number;
}

export interface LeafBuildResult {
    leaf: Leaf;
    supportData: SupportData;
}

// Pooled scratch vectors — reused across calls to avoid per-frame GC pressure.
const _tip = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _knot = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _start = new THREE.Vector3();
const _coneVec = new THREE.Vector3();

function computeLeafConeAxisAndLength(
    tipPos: Vec3,
    surfaceNormal: Vec3,
    knotPos: Vec3,
    baseProfile: SupportTipProfile,
    mesh?: THREE.Mesh,
): { axis: Vec3; lengthMm: number; diskThicknessMm: number } {
    const cone = recomputeContactConeForMovedDisk(
        {
            id: 'preview-leaf-cone',
            pos: tipPos,
            normal: surfaceNormal,
            surfaceNormal,
            profile: baseProfile,
        },
        tipPos,
        surfaceNormal,
        knotPos,
        mesh,
    );

    return {
        axis: cone.normal,
        lengthMm: cone.profile.lengthMm,
        diskThicknessMm: cone.diskLengthOverride ?? 0,
    };
}

export function buildLeafData(input: LeafBuildInput): LeafBuildResult {
    const { tipPos, surfaceNormal, modelId, parentKnot, hostDiameterMm, mesh } = input;

    const settings = getSettings();
    const settingsCodeHex = encodeSupportSettingsHex(settings);

    const baseProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: Math.max(settings.tip.contactDiameterMm, input.contactDiameterMm ?? 0),
        bodyDiameterMm: hostDiameterMm,
        lengthMm: settings.tip.lengthMm,
        // Auto-support (contact size given) sinks tips ≥ 0.2 mm, like trunk tips.
        penetrationMm: input.contactDiameterMm !== undefined
            ? Math.max(settings.tip.penetrationMm, 0.2)
            : settings.tip.penetrationMm,
        diskThicknessMm: 0.1,
        maxStandoffMm: 1.5,
        standoffAngleThreshold: Math.PI / 4,
    };

    const { axis, lengthMm } = computeLeafConeAxisAndLength(
        tipPos,
        surfaceNormal,
        parentKnot.pos,
        baseProfile,
        mesh,
    );

    const profile: SupportTipProfile = {
        ...baseProfile,
        lengthMm,
        bodyDiameterMm: hostDiameterMm,
    };

    const contactCone: ContactCone = {
        ...recomputeContactConeForMovedDisk(
            {
                id: 'leaf-cone',
                pos: tipPos,
                normal: axis,
                surfaceNormal,
                profile,
            },
            tipPos,
            surfaceNormal,
            parentKnot.pos,
            mesh,
        ),
        id: uuidv4(),
    };

    const leafId = uuidv4();
    const leaf: Leaf = {
        id: leafId,
        modelId,
        settingsCodeHex,
        parentKnotId: parentKnot.id,
        contactCone,
    };

    const supportData: SupportData = {
        id: leafId,
        segments: [],
        knot: parentKnot,
        contactCone,
    };

    return { leaf, supportData };
}
