import { K2_SE_PROFILE } from "../../shared/profile";
import type { PrintSettings } from "../../shared/settings";

const KIRI_ENGINE_URL = new URL(
  "./kiri/engine.js",
  document.baseURI,
).href;
const KIRI_WORKER_URL = new URL(
  "./kiri/worker.js",
  document.baseURI,
).href;

interface KiriEngine {
  export(): Promise<string>;
  parse(data: ArrayBuffer | string): Promise<KiriEngine>;
  prepare(): Promise<KiriEngine>;
  setDevice(device: Record<string, unknown>): KiriEngine;
  setListener(listener: (event: unknown) => void): KiriEngine;
  setMode(mode: "FDM"): KiriEngine;
  setProcess(process: Record<string, unknown>): KiriEngine;
  setController?(controller: Record<string, unknown>): KiriEngine;
  setRender?(enabled: boolean): KiriEngine;
  slice(): Promise<KiriEngine>;
}

type KiriEngineConstructor = new (options?: {
  workURL?: string;
  poolURL?: string;
}) => KiriEngine;

export interface BrowserSliceOutput {
  engineName: string;
  gcode: string;
}

let engineLoader: Promise<KiriEngineConstructor> | null = null;

function loadEngine(): Promise<KiriEngineConstructor> {
  if (engineLoader) return engineLoader;

  engineLoader = import(/* @vite-ignore */ KIRI_ENGINE_URL)
    .then((module: { Engine?: KiriEngineConstructor }) => {
      if (!module.Engine) {
        throw new Error("The bundled browser slicer did not expose its engine API.");
      }
      return module.Engine;
    })
    .catch((error) => {
      engineLoader = null;
      if (error instanceof Error && error.message.includes("engine API")) {
        throw error;
      }
      throw new Error("The bundled browser slicer could not start. Reload the page and try again.", {
        cause: error,
      });
    });

  return engineLoader;
}

function buildDevice(settings: PrintSettings): Record<string, unknown> {
  return {
    mode: "FDM",
    deviceName: K2_SE_PROFILE.printerName,
    bedWidth: K2_SE_PROFILE.buildVolume.x,
    bedDepth: K2_SE_PROFILE.buildVolume.y,
    maxHeight: K2_SE_PROFILE.buildVolume.z,
    bedRound: false,
    bedBelt: false,
    originCenter: false,
    extrudeAbs: true,
    gcodeFan: ["M106 S{fan_speed}"],
    gcodeLayer: [";LAYER:{layer}"],
    gcodePre: [
      "; K2 SE Browser Slicer - generic single-filament start",
      "M140 S{bed_temp}",
      "M104 S{temp}",
      "G28",
      "M190 S{bed_temp}",
      "M109 S{temp}",
      "G90",
      "M82",
      "G92 E0",
      "G1 Z0.28 F600",
      "G1 X5 Y5 F6000",
      "G1 X5 Y180 E15 F900",
      "G1 X8 Y180 F6000",
      "G1 X8 Y5 E30 F900",
      "G92 E0",
    ],
    gcodePost: [
      "; estimated printing time = {time}s",
      "; filament used [mm] = {material}",
      "; K2 SE Browser Slicer - generic end",
      "M107",
      "M104 S0",
      "M140 S0",
      "M83",
      "G91",
      "G1 E-2 F1800",
      "G1 Z10 F900",
      "G90",
      "G1 X0 Y210 F6000",
      "M84",
    ],
    gcodeTrack: [],
    gcodePause: [],
    gcodeDwell: [],
    gcodeChange: [],
    gcodeFExt: "gcode",
    gcodeSpace: true,
    gcodeStrip: false,
    extruders: [
      {
        extFilament: settings.filamentDiameter,
        extNozzle: settings.nozzleDiameter,
        extSelect: [],
        extDeselect: [],
        extOffsetX: 0,
        extOffsetY: 0,
      },
    ],
  };
}

function kiriInfill(pattern: PrintSettings["infillPattern"]): string {
  if (pattern === "rectilinear") return "linear";
  if (pattern === "honeycomb") return "hex";
  return pattern;
}

function buildProcess(settings: PrintSettings): Record<string, unknown> {
  const brim = settings.adhesion === "brim";
  const skirt = settings.adhesion === "skirt";

  return {
    sliceHeight: settings.layerHeight,
    firstSliceHeight: Math.max(settings.layerHeight, 0.18),
    sliceShells: settings.walls,
    sliceShellOrder: "in-out",
    sliceLayerStart: "last",
    sliceFillAngle: 45,
    sliceFillOverlap: 0.3,
    sliceFillSparse: settings.infillDensity / 100,
    sliceFillType: kiriInfill(settings.infillPattern),
    sliceFillRate: settings.speeds.infill,
    sliceSolidRate: Math.min(settings.speeds.infill, settings.speeds.innerWall),
    sliceBottomLayers: settings.bottomLayers,
    sliceTopLayers: settings.topLayers,
    sliceSupportEnable: settings.supports,
    sliceSupportAngle: settings.supportOverhang,
    sliceSupportDensity: 0.2,
    sliceSupportOffset: settings.nozzleDiameter,
    sliceSupportGap: 1,
    sliceSupportSize: 6,
    sliceSupportArea: 1,
    sliceSupportExtra: 0,
    sliceSupportNozzle: 0,
    sliceSupportRate: settings.speeds.support,
    sliceSkirtCount: skirt ? settings.skirtLoops : 0,
    sliceSkirtOffset: 6,
    firstLayerBrim: brim ? settings.brimWidth : 0,
    outputBrimCount: brim ? Math.max(1, Math.ceil(settings.brimWidth / settings.nozzleDiameter)) : 0,
    outputBrimOffset: 0,
    firstLayerRate: settings.speeds.firstLayer,
    firstLayerFillRate: settings.speeds.firstLayer,
    firstLayerPrintMult: settings.flowRatio,
    firstLayerLineMult: 1,
    firstLayerNozzleTemp: settings.firstLayerNozzleTemp,
    firstLayerBedTemp: settings.firstLayerBedTemp,
    firstLayerFanSpeed: 0,
    outputTemp: settings.nozzleTemp,
    outputBedTemp: settings.bedTemp,
    outputFeedrate: settings.speeds.innerWall,
    outputFinishrate: settings.speeds.outerWall,
    outputSeekrate: settings.speeds.travel,
    outputShellMult: settings.flowRatio,
    outputFillMult: settings.flowRatio,
    outputSparseMult: settings.flowRatio,
    outputFanLayer: 2,
    outputFanSpeed: 255,
    outputRetractDist: 0.8,
    outputRetractSpeed: 40,
    outputRetractDwell: 0,
    outputRetractWipe: 0,
    outputShortPoly: 50,
    outputMinSpeed: 10,
    outputCoastDist: 0,
    outputLayerRetract: false,
    outputRaft: false,
    detectThinWalls: true,
    zHopDistance: 0.2,
    arcTolerance: 0,
    ranges: [],
  };
}

function progressMessage(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const message = event as Record<string, unknown>;
  if ("export" in message) return "Writing G-code in browser";
  if ("prepare" in message) return "Building print toolpaths";
  if ("slice" in message) return "Slicing model in browser";
  if ("parsed" in message || "loaded" in message) return "Preparing model geometry";
  return null;
}

export async function sliceInBrowser(
  plate: Blob,
  settings: PrintSettings,
  onProgress: (message: string) => void,
): Promise<BrowserSliceOutput> {
  onProgress("Loading browser slicer");
  const Engine = await loadEngine();
  const engine = new Engine({ workURL: KIRI_WORKER_URL });

  engine.setRender?.(false);
  engine.setListener((event) => {
    const message = progressMessage(event);
    if (message) onProgress(message);
  });

  onProgress("Preparing model geometry");
  await engine.parse(await plate.arrayBuffer());
  engine.setMode("FDM");
  engine.setController?.({ threaded: false });
  engine.setDevice(buildDevice(settings));
  engine.setProcess(buildProcess(settings));

  onProgress("Slicing model in browser");
  await engine.slice();
  onProgress("Building print toolpaths");
  await engine.prepare();
  onProgress("Writing G-code in browser");
  const gcode = await engine.export();

  if (typeof gcode !== "string" || !gcode.includes("G")) {
    throw new Error("The browser engine did not produce valid G-code.");
  }

  return {
    engineName: "Kiri:Moto browser engine",
    gcode,
  };
}
