import { K2_SE_PROFILE } from "../../shared/profile";
import type { PrintSettings } from "../../shared/settings";

const KIRI_ASSET_VERSION = "20260819-1";

function versionedAssetUrl(path: string): string {
  const url = new URL(path, document.baseURI);
  url.searchParams.set("v", KIRI_ASSET_VERSION);
  return url.href;
}

const KIRI_ENGINE_URL = versionedAssetUrl("./kiri/engine.js");
const KIRI_WORKER_URL = versionedAssetUrl("./kiri/worker.js");

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

export type BrowserSliceStage = "loading" | "geometry" | "slicing" | "toolpaths" | "gcode";

export interface BrowserSliceProgress {
  stage: BrowserSliceStage;
  message: string;
  percent: number;
  updatedAt: number;
}

const SLICE_STALL_TIMEOUT_MS = 2 * 60 * 1000;
const PROGRESS_NOTIFY_INTERVAL_MS = 2 * 1000;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function progressFromEvent(event: unknown): Omit<BrowserSliceProgress, "updatedAt"> | null {
  const message = asRecord(event);
  if (!message) return null;

  if ("slice" in message) {
    const payload = asRecord(message.slice);
    const stageProgress = fraction(payload?.progress ?? payload?.update);
    if (stageProgress === null) return null;
    return {
      stage: "slicing",
      message: "Slicing model layers",
      percent: 12 + stageProgress * 60,
    };
  }

  if ("prepare" in message) {
    const payload = asRecord(message.prepare);
    const stageProgress = fraction(payload?.update);
    if (stageProgress === null) return null;
    return {
      stage: "toolpaths",
      message: "Building walls, infill, and supports",
      percent: 74 + stageProgress * 18,
    };
  }

  if ("export" in message) {
    return { stage: "gcode", message: "Writing G-code", percent: 95 };
  }

  if ("parsed" in message || "loaded" in message) {
    return { stage: "geometry", message: "Preparing model geometry", percent: 9 };
  }

  return null;
}

export async function sliceInBrowser(
  plate: Blob,
  settings: PrintSettings,
  onProgress: (progress: BrowserSliceProgress) => void,
): Promise<BrowserSliceOutput> {
  let active = true;
  let lastActivityAt = Date.now();
  let lastNotificationAt = 0;
  let lastProgress: Omit<BrowserSliceProgress, "updatedAt"> | null = null;

  const report = (progress: Omit<BrowserSliceProgress, "updatedAt">, force = false) => {
    if (!active) return;
    const now = Date.now();
    lastActivityAt = now;
    const changed = !lastProgress
      || lastProgress.stage !== progress.stage
      || lastProgress.message !== progress.message
      || Math.abs(lastProgress.percent - progress.percent) >= 0.5;

    if (force || changed || now - lastNotificationAt >= PROGRESS_NOTIFY_INTERVAL_MS) {
      lastProgress = progress;
      lastNotificationAt = now;
      onProgress({ ...progress, updatedAt: now });
    }
  };

  const runSlice = async (): Promise<BrowserSliceOutput> => {
    report({ stage: "loading", message: "Loading browser slicer", percent: 2 }, true);
    const Engine = await loadEngine();
    const engine = new Engine({ workURL: KIRI_WORKER_URL });

    engine.setRender?.(false);
    engine.setListener((event) => {
      const progress = progressFromEvent(event);
      if (progress) report(progress);
    });

    report({ stage: "geometry", message: "Preparing model geometry", percent: 6 }, true);
    await engine.parse(await plate.arrayBuffer());
    report({ stage: "geometry", message: "Model geometry ready", percent: 10 }, true);
    engine.setMode("FDM");
    engine.setController?.({ threaded: false });
    engine.setDevice(buildDevice(settings));
    engine.setProcess(buildProcess(settings));

    report({ stage: "slicing", message: "Slicing model layers", percent: 12 }, true);
    await engine.slice();
    report({ stage: "toolpaths", message: "Building walls, infill, and supports", percent: 74 }, true);
    await engine.prepare();
    report({ stage: "gcode", message: "Writing G-code", percent: 95 }, true);
    const gcode = await engine.export();

    if (typeof gcode !== "string" || !gcode.includes("G")) {
      throw new Error("The browser engine did not produce valid G-code.");
    }

    report({ stage: "gcode", message: "G-code generated", percent: 98 }, true);
    return {
      engineName: "Kiri:Moto browser engine",
      gcode,
    };
  };

  let watchdog: number | undefined;
  const stalled = new Promise<never>((_, reject) => {
    watchdog = window.setInterval(() => {
      if (Date.now() - lastActivityAt < SLICE_STALL_TIMEOUT_MS) return;
      reject(new Error(
        "The slicer stopped reporting progress for 2 minutes, so no G-code was created. Reload the page and try a repaired or less detailed STL.",
      ));
    }, 5_000);
  });

  try {
    return await Promise.race([runSlice(), stalled]);
  } finally {
    active = false;
    if (watchdog !== undefined) window.clearInterval(watchdog);
  }
}
