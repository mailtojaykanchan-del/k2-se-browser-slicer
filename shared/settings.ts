import { K2_SE_PROFILE } from "./profile.js";

export type AdhesionMode = "none" | "skirt" | "brim";
export type InfillPattern = "grid" | "gyroid" | "cubic" | "rectilinear" | "honeycomb";

export interface PrintSettings {
  layerHeight: number;
  walls: number;
  topLayers: number;
  bottomLayers: number;
  infillDensity: number;
  infillPattern: InfillPattern;
  supports: boolean;
  supportOverhang: number;
  adhesion: AdhesionMode;
  brimWidth: number;
  skirtLoops: number;
  nozzleTemp: number;
  firstLayerNozzleTemp: number;
  bedTemp: number;
  firstLayerBedTemp: number;
  nozzleDiameter: number;
  filamentDiameter: number;
  flowRatio: number;
  speeds: {
    firstLayer: number;
    outerWall: number;
    innerWall: number;
    infill: number;
    support: number;
    travel: number;
  };
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  layerHeight: 0.2,
  walls: 3,
  topLayers: 5,
  bottomLayers: 4,
  infillDensity: 15,
  infillPattern: "gyroid",
  supports: false,
  supportOverhang: 55,
  adhesion: "skirt",
  brimWidth: 5,
  skirtLoops: 2,
  nozzleTemp: 210,
  firstLayerNozzleTemp: 215,
  bedTemp: 60,
  firstLayerBedTemp: 60,
  nozzleDiameter: K2_SE_PROFILE.nozzleDiameter,
  filamentDiameter: K2_SE_PROFILE.filamentDiameter,
  flowRatio: 1,
  speeds: {
    firstLayer: 40,
    outerWall: 90,
    innerWall: 150,
    infill: 180,
    support: 120,
    travel: 300,
  },
};

const INFILL_PATTERNS: InfillPattern[] = ["grid", "gyroid", "cubic", "rectilinear", "honeycomb"];
const ADHESION_MODES: AdhesionMode[] = ["none", "skirt", "brim"];

function finiteNumber(value: unknown, fallback: number): number {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizePrintSettings(raw: unknown): PrintSettings {
  const input = raw && typeof raw === "object" ? (raw as Partial<PrintSettings>) : {};
  const speeds = (input.speeds && typeof input.speeds === "object" ? input.speeds : {}) as Partial<
    PrintSettings["speeds"]
  >;

  return {
    layerHeight: clamp(finiteNumber(input.layerHeight, DEFAULT_PRINT_SETTINGS.layerHeight), 0.05, 0.8),
    walls: Math.round(clamp(finiteNumber(input.walls, DEFAULT_PRINT_SETTINGS.walls), 1, 10)),
    topLayers: Math.round(clamp(finiteNumber(input.topLayers, DEFAULT_PRINT_SETTINGS.topLayers), 0, 20)),
    bottomLayers: Math.round(clamp(finiteNumber(input.bottomLayers, DEFAULT_PRINT_SETTINGS.bottomLayers), 0, 20)),
    infillDensity: clamp(finiteNumber(input.infillDensity, DEFAULT_PRINT_SETTINGS.infillDensity), 0, 100),
    infillPattern: INFILL_PATTERNS.includes(input.infillPattern as InfillPattern)
      ? (input.infillPattern as InfillPattern)
      : DEFAULT_PRINT_SETTINGS.infillPattern,
    supports: Boolean(input.supports),
    supportOverhang: clamp(finiteNumber(input.supportOverhang, DEFAULT_PRINT_SETTINGS.supportOverhang), 0, 90),
    adhesion: ADHESION_MODES.includes(input.adhesion as AdhesionMode)
      ? (input.adhesion as AdhesionMode)
      : DEFAULT_PRINT_SETTINGS.adhesion,
    brimWidth: clamp(finiteNumber(input.brimWidth, DEFAULT_PRINT_SETTINGS.brimWidth), 0, 20),
    skirtLoops: Math.round(clamp(finiteNumber(input.skirtLoops, DEFAULT_PRINT_SETTINGS.skirtLoops), 0, 10)),
    nozzleTemp: clamp(finiteNumber(input.nozzleTemp, DEFAULT_PRINT_SETTINGS.nozzleTemp), 150, K2_SE_PROFILE.maxNozzleTemp),
    firstLayerNozzleTemp: clamp(
      finiteNumber(input.firstLayerNozzleTemp, DEFAULT_PRINT_SETTINGS.firstLayerNozzleTemp),
      150,
      K2_SE_PROFILE.maxNozzleTemp,
    ),
    bedTemp: clamp(finiteNumber(input.bedTemp, DEFAULT_PRINT_SETTINGS.bedTemp), 0, K2_SE_PROFILE.maxBedTemp),
    firstLayerBedTemp: clamp(
      finiteNumber(input.firstLayerBedTemp, DEFAULT_PRINT_SETTINGS.firstLayerBedTemp),
      0,
      K2_SE_PROFILE.maxBedTemp,
    ),
    nozzleDiameter: clamp(finiteNumber(input.nozzleDiameter, DEFAULT_PRINT_SETTINGS.nozzleDiameter), 0.2, 1.2),
    filamentDiameter: clamp(finiteNumber(input.filamentDiameter, DEFAULT_PRINT_SETTINGS.filamentDiameter), 1, 3),
    flowRatio: clamp(finiteNumber(input.flowRatio, DEFAULT_PRINT_SETTINGS.flowRatio), 0.5, 1.5),
    speeds: {
      firstLayer: clamp(finiteNumber(speeds.firstLayer, DEFAULT_PRINT_SETTINGS.speeds.firstLayer), 5, 150),
      outerWall: clamp(finiteNumber(speeds.outerWall, DEFAULT_PRINT_SETTINGS.speeds.outerWall), 10, K2_SE_PROFILE.maxPrintSpeed),
      innerWall: clamp(finiteNumber(speeds.innerWall, DEFAULT_PRINT_SETTINGS.speeds.innerWall), 10, K2_SE_PROFILE.maxPrintSpeed),
      infill: clamp(finiteNumber(speeds.infill, DEFAULT_PRINT_SETTINGS.speeds.infill), 10, K2_SE_PROFILE.maxPrintSpeed),
      support: clamp(finiteNumber(speeds.support, DEFAULT_PRINT_SETTINGS.speeds.support), 10, K2_SE_PROFILE.maxPrintSpeed),
      travel: clamp(finiteNumber(speeds.travel, DEFAULT_PRINT_SETTINGS.speeds.travel), 20, 600),
    },
  };
}

export function validatePrintSettings(settings: PrintSettings): string[] {
  const errors: string[] = [];

  if (settings.layerHeight > settings.nozzleDiameter * 0.8) {
    errors.push("Layer height should stay at or below 80% of nozzle diameter.");
  }
  if (settings.layerHeight < settings.nozzleDiameter * 0.2) {
    errors.push("Layer height is very small for the selected nozzle.");
  }
  if (settings.firstLayerNozzleTemp < settings.nozzleTemp) {
    errors.push("First-layer nozzle temperature should not be lower than the main PLA temperature.");
  }
  if (settings.firstLayerBedTemp < settings.bedTemp) {
    errors.push("First-layer bed temperature should not be lower than the main bed temperature.");
  }
  if (settings.adhesion === "brim" && settings.brimWidth <= 0) {
    errors.push("Brim mode needs a brim width above 0 mm.");
  }
  if (settings.adhesion === "skirt" && settings.skirtLoops <= 0) {
    errors.push("Skirt mode needs at least one skirt loop.");
  }

  return errors;
}
