import { PLA_DENSITY_G_CM3 } from "./profile.js";
import type { PrintSettings } from "./settings.js";

export interface LayerSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ParsedLayer {
  z: number;
  segmentCount: number;
  extrusionMm: number;
  segments: LayerSegment[];
}

export interface GcodeSummary {
  layerCount: number;
  filamentMm: number;
  filamentCm3: number;
  filamentG: number;
  estimatedSeconds: number;
  timeSource: "slicer-comment" | "motion-estimate";
  totalExtrusionSegments: number;
  sampled: boolean;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } | null;
  layers: ParsedLayer[];
}

const MAX_TOTAL_SEGMENTS = 120_000;
const MAX_SEGMENTS_PER_LAYER = 2500;

function parseParams(line: string): Record<string, number> {
  const params: Record<string, number> = {};
  const matches = line.matchAll(/([A-Z])\s*(-?\d+(?:\.\d+)?)/gi);
  for (const match of matches) {
    params[match[1].toUpperCase()] = Number(match[2]);
  }
  return params;
}

function parseDuration(text: string): number | null {
  let seconds = 0;
  const day = text.match(/(\d+(?:\.\d+)?)\s*d/i);
  const hour = text.match(/(\d+(?:\.\d+)?)\s*h/i);
  const minute = text.match(/(\d+(?:\.\d+)?)\s*m/i);
  const second = text.match(/(\d+(?:\.\d+)?)\s*s/i);

  if (day) seconds += Number(day[1]) * 86400;
  if (hour) seconds += Number(hour[1]) * 3600;
  if (minute) seconds += Number(minute[1]) * 60;
  if (second) seconds += Number(second[1]);

  return seconds > 0 ? seconds : null;
}

function ensureLayer(layers: Map<string, ParsedLayer>, z: number): ParsedLayer {
  const key = z.toFixed(3);
  const existing = layers.get(key);
  if (existing) return existing;

  const layer: ParsedLayer = {
    z: Number(key),
    segmentCount: 0,
    extrusionMm: 0,
    segments: [],
  };
  layers.set(key, layer);
  return layer;
}

export function parseGcode(gcode: string, settings: PrintSettings): GcodeSummary {
  const lines = gcode.split(/\r?\n/);
  const layers = new Map<string, ParsedLayer>();
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let f = 1800;
  let relativeE = false;
  let relativeXyz = false;
  let filamentMm = 0;
  let estimatedSecondsFromMotion = 0;
  let estimatedSecondsFromComment: number | null = null;
  let totalExtrusionSegments = 0;
  let sampled = false;
  let bounds: GcodeSummary["bounds"] = null;

  const updateBounds = (nx: number, ny: number, nz: number) => {
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return;
    if (!bounds) {
      bounds = { minX: nx, minY: ny, maxX: nx, maxY: ny, minZ: nz, maxZ: nz };
      return;
    }
    bounds.minX = Math.min(bounds.minX, nx);
    bounds.minY = Math.min(bounds.minY, ny);
    bounds.maxX = Math.max(bounds.maxX, nx);
    bounds.maxY = Math.max(bounds.maxY, ny);
    bounds.minZ = Math.min(bounds.minZ, nz);
    bounds.maxZ = Math.max(bounds.maxZ, nz);
  };

  for (const rawLine of lines) {
    const [commandPart, comment = ""] = rawLine.split(";", 2);
    const commentText = comment.trim();

    if (/estimated printing time/i.test(commentText)) {
      const parsed = parseDuration(commentText);
      if (parsed) estimatedSecondsFromComment = parsed;
    }

    const filamentMmComment = commentText.match(/filament used \[mm\]\s*=\s*(\d+(?:\.\d+)?)/i);
    if (filamentMmComment) {
      filamentMm = Number(filamentMmComment[1]);
    }

    const command = commandPart.trim().toUpperCase();
    if (!command) continue;

    if (command.startsWith("M82")) {
      relativeE = false;
      continue;
    }
    if (command.startsWith("M83")) {
      relativeE = true;
      continue;
    }
    if (command.startsWith("G90")) {
      relativeXyz = false;
      continue;
    }
    if (command.startsWith("G91")) {
      relativeXyz = true;
      continue;
    }
    if (command.startsWith("G92")) {
      const params = parseParams(command);
      if (params.E !== undefined) e = params.E;
      if (params.X !== undefined) x = params.X;
      if (params.Y !== undefined) y = params.Y;
      if (params.Z !== undefined) z = params.Z;
      continue;
    }
    if (!command.startsWith("G0") && !command.startsWith("G1")) continue;

    const params = parseParams(command);
    const nx = params.X === undefined ? x : relativeXyz ? x + params.X : params.X;
    const ny = params.Y === undefined ? y : relativeXyz ? y + params.Y : params.Y;
    const nz = params.Z === undefined ? z : relativeXyz ? z + params.Z : params.Z;
    const nf = params.F === undefined ? f : params.F;

    let deltaE = 0;
    let ne = e;
    if (params.E !== undefined) {
      if (relativeE) {
        deltaE = params.E;
        ne = e + params.E;
      } else {
        deltaE = params.E - e;
        ne = params.E;
      }
    }

    const distance = Math.hypot(nx - x, ny - y, nz - z);
    if (nf > 0 && distance > 0) {
      estimatedSecondsFromMotion += distance / (nf / 60);
    }

    updateBounds(nx, ny, nz);

    if (deltaE > 0.0001 && Math.hypot(nx - x, ny - y) > 0.001) {
      filamentMm += deltaE;
      const layer = ensureLayer(layers, nz);
      layer.segmentCount += 1;
      layer.extrusionMm += deltaE;
      totalExtrusionSegments += 1;

      if (totalExtrusionSegments <= MAX_TOTAL_SEGMENTS && layer.segments.length < MAX_SEGMENTS_PER_LAYER) {
        layer.segments.push({
          x1: Number(x.toFixed(3)),
          y1: Number(y.toFixed(3)),
          x2: Number(nx.toFixed(3)),
          y2: Number(ny.toFixed(3)),
        });
      } else {
        sampled = true;
      }
    }

    x = nx;
    y = ny;
    z = nz;
    e = ne;
    f = nf;
  }

  const filamentRadius = settings.filamentDiameter / 2;
  const filamentCm3 = (Math.PI * filamentRadius * filamentRadius * filamentMm) / 1000;
  const filamentG = filamentCm3 * PLA_DENSITY_G_CM3;
  const sortedLayers = [...layers.values()].sort((a, b) => a.z - b.z);

  return {
    layerCount: sortedLayers.length,
    filamentMm,
    filamentCm3,
    filamentG,
    estimatedSeconds: estimatedSecondsFromComment ?? estimatedSecondsFromMotion,
    timeSource: estimatedSecondsFromComment ? "slicer-comment" : "motion-estimate",
    totalExtrusionSegments,
    sampled,
    bounds,
    layers: sortedLayers,
  };
}
