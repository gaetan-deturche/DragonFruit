import {
    addMaterialProfile,
    getActiveMaterialProfile,
    getActivePrinterProfile,
    getMaterialProfilesForPrinter,
    getProfileStoreSnapshot,
    setActiveMaterialProfile,
    setActivePrinterProfile,
    updateMaterialProfile,
    type LocalMaterialSettingsValue,
    type MaterialAntiAliasingSettings,
    type MaterialProfile,
    type PrinterProfile,
} from '@/features/profiles/profileStore';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';
import { normalizeOutputFormat } from '@/features/profiles/outputFormatUtils';

/**
 * Print-profile control for the automation bridge (MCP): list / select the
 * printer and material profiles the Export tab slices with, read the settings
 * that actually reach the sliced file, and edit them.
 *
 * Two layers matter. A MaterialProfile carries generic fields (exposure, layer
 * height, lift…), but printers whose output plugin "replaces default material
 * settings" (e.g. Anycubic .pmx2) are driven by a per-output LOCAL settings map
 * (`localSettingsByOutput[format]`) with its own schema — that is where things
 * like "wait time before cure" or transition layers live, and its values win
 * over the generic ones. Both are exposed here.
 */

const MATERIAL_FIELDS = [
    'name', 'layerHeightMm', 'normalExposureSec', 'bottomExposureSec', 'bottomLayerCount',
    'liftDistanceMm', 'liftSpeedMmMin', 'retractSpeedMmMin', 'minimumAaAlphaPercent',
] as const;
type MaterialField = (typeof MATERIAL_FIELDS)[number];

function isOfficial(material: MaterialProfile): boolean {
    return typeof material.officialTemplateId === 'string' && material.officialTemplateId.trim().length > 0;
}

function printerSummary(p: PrinterProfile, activeId: string | undefined) {
    return {
        id: p.id,
        name: p.name,
        manufacturer: p.manufacturer,
        outputFormat: p.display.outputFormat,
        settingsMode: p.display.settingsMode,
        official: p.isOfficial === true,
        active: p.id === activeId,
    };
}

function localAdapterFor(printer: PrinterProfile) {
    const adapter = getProfileLocalMaterialSettingsAdapter(printer.display.outputFormat, printer.display.settingsMode);
    return adapter && adapter.fields.length > 0 ? adapter : null;
}

function localValuesFor(material: MaterialProfile, printer: PrinterProfile): Record<string, LocalMaterialSettingsValue> | undefined {
    const output = normalizeOutputFormat(printer.display.outputFormat);
    return material.localSettingsByOutput?.[output] ?? material.localSettingsByOutput?.[output.replace(/^\./, '')];
}

function describeMaterial(material: MaterialProfile, printer: PrinterProfile | null) {
    const base: Record<string, unknown> = {};
    for (const key of MATERIAL_FIELDS) base[key] = material[key];
    const aa = material.antiAliasingSettings;

    let outputSettings: unknown = null;
    if (printer) {
        const adapter = localAdapterFor(printer);
        if (adapter) {
            const values = localValuesFor(material, printer) ?? {};
            outputSettings = {
                format: normalizeOutputFormat(printer.display.outputFormat),
                replacesGenericFields: adapter.replacesDefaultMaterialSettings === true,
                fields: adapter.fields
                    .filter((f) => f.kind !== 'spacer')
                    .map((f) => {
                        const field = f as typeof f & { min?: number; max?: number; defaultValue?: LocalMaterialSettingsValue; label?: string };
                        const explicit = Object.prototype.hasOwnProperty.call(values, f.key);
                        return {
                            key: f.key,
                            label: field.label,
                            kind: f.kind,
                            min: field.min,
                            max: field.max,
                            value: explicit ? values[f.key] : field.defaultValue,
                            isDefault: !explicit,
                        };
                    }),
            };
        }
    }

    return {
        id: material.id,
        printerProfileId: material.printerProfileId,
        official: isOfficial(material),
        editable: !isOfficial(material),
        base,
        antiAliasing: { mode: aa.mode, level: aa.level, blurBrushRadiusPx: aa.blurBrushRadiusPx, aaOnSupports: aa.aaOnSupports },
        outputSettings,
    };
}

export function describeProfiles() {
    const state = getProfileStoreSnapshot();
    const printer = getActivePrinterProfile(state);
    const material = getActiveMaterialProfile(state);
    return {
        printers: state.printerProfiles.map((p) => printerSummary(p, printer?.id)),
        activePrinter: printer ? printerSummary(printer, printer.id) : null,
        materials: printer
            ? getMaterialProfilesForPrinter(printer.id, state).map((m) => ({
                id: m.id, name: m.name, official: isOfficial(m), active: m.id === material?.id,
            }))
            : [],
        activeMaterial: material ? describeMaterial(material, printer) : null,
    };
}

export function selectPrinterProfile(id: string) {
    if (!getProfileStoreSnapshot().printerProfiles.some((p) => p.id === id)) throw new Error(`no printer profile with id ${id}`);
    setActivePrinterProfile(id);
    return describeProfiles();
}

export function selectMaterialProfile(id: string) {
    if (!getProfileStoreSnapshot().materialProfiles.some((m) => m.id === id)) throw new Error(`no material profile with id ${id}`);
    setActiveMaterialProfile(id);
    return describeProfiles();
}

/** Copy a material (official ones are read-only) into an editable custom profile and make it active. */
export function duplicateMaterialProfile(id: string | undefined, name?: string) {
    const state = getProfileStoreSnapshot();
    const source = id
        ? state.materialProfiles.find((m) => m.id === id)
        : getActiveMaterialProfile(state);
    if (!source) throw new Error(id ? `no material profile with id ${id}` : 'no active material profile');
    const { id: _id, printerProfileId, officialTemplateId: _t, officialTemplateVersion: _v, ...rest } = source;
    void _id; void _t; void _v;
    const newId = addMaterialProfile(printerProfileId, { ...rest, name: name?.trim() || `${source.name} (custom)` });
    setActiveMaterialProfile(newId);
    return describeProfiles();
}

export interface MaterialProfilePatch {
    /** Generic MaterialProfile fields (name, exposure, layer height, lift…). */
    base?: Partial<Pick<MaterialProfile, MaterialField>>;
    /** Output-format settings by field key (see describeProfiles().activeMaterial.outputSettings.fields). */
    output?: Record<string, LocalMaterialSettingsValue>;
    /** Anti-aliasing settings (mode 'Off' | 'Blur' | '3DAA', level '4x', blurBrushRadiusPx…). */
    antiAliasing?: Partial<MaterialAntiAliasingSettings>;
}

export function updateMaterialProfileSettings(id: string | undefined, patch: MaterialProfilePatch) {
    const state = getProfileStoreSnapshot();
    const material = id ? state.materialProfiles.find((m) => m.id === id) : getActiveMaterialProfile(state);
    if (!material) throw new Error(id ? `no material profile with id ${id}` : 'no active material profile');
    if (isOfficial(material)) {
        throw new Error(`"${material.name}" is an official (read-only) profile — duplicate it first (df_duplicate_material).`);
    }
    const printer = state.printerProfiles.find((p) => p.id === material.printerProfileId) ?? null;

    const updates: Partial<Omit<MaterialProfile, 'id'>> = {};
    for (const [key, value] of Object.entries(patch.base ?? {})) {
        if (!(MATERIAL_FIELDS as readonly string[]).includes(key)) throw new Error(`unknown material field "${key}" (allowed: ${MATERIAL_FIELDS.join(', ')})`);
        (updates as Record<string, unknown>)[key] = value;
    }

    if (patch.output && Object.keys(patch.output).length > 0) {
        if (!printer) throw new Error('material has no printer profile');
        const adapter = localAdapterFor(printer);
        if (!adapter) throw new Error(`printer output ${printer.display.outputFormat} has no output-specific settings`);
        const known = new Set(adapter.fields.map((f) => f.key));
        const unknown = Object.keys(patch.output).filter((k) => !known.has(k));
        if (unknown.length) throw new Error(`unknown output setting(s) ${unknown.join(', ')} (allowed: ${[...known].join(', ')})`);
        const output = normalizeOutputFormat(printer.display.outputFormat);
        updates.localSettingsByOutput = {
            ...(material.localSettingsByOutput ?? {}),
            [output]: { ...(localValuesFor(material, printer) ?? {}), ...patch.output },
        };
    }

    if (patch.antiAliasing) {
        updates.antiAliasingSettings = { ...material.antiAliasingSettings, ...patch.antiAliasing };
    }

    updateMaterialProfile(material.id, updates);
    const after = getProfileStoreSnapshot().materialProfiles.find((m) => m.id === material.id)!;
    return describeMaterial(after, printer);
}
