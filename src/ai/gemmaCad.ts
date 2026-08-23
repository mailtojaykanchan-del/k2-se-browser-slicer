import type { CadDefinition, CadPrimitiveKind, Vec3Snapshot } from "../scene/SlicerScene";
import { defaultCadDefinition } from "../components/CadPanel";

export interface AiCadPart {
  definition: CadDefinition;
  position: Vec3Snapshot;
}

export async function generateCadPlan(prompt: string): Promise<{ parts: AiCadPart[]; engine: "parser" }> {
  return { parts: parsePromptLocally(prompt), engine: "parser" };
}

function normalizePart(raw: unknown): AiCadPart {
  const value = raw as Record<string, unknown>;
  const allowed: CadPrimitiveKind[] = ["box", "cylinder", "sphere", "cone", "tube", "basketball"];
  const kind = allowed.includes(value.kind as CadPrimitiveKind) ? value.kind as CadPrimitiveKind : "box";
  const defaults = defaultCadDefinition(kind);
  const number = (key: string, fallback: number, min = 0.5) => {
    const candidate = Number(value[key]);
    return Number.isFinite(candidate) ? Math.max(min, Math.min(490, candidate)) : fallback;
  };
  const diameter = number("diameter", defaults.diameter);
  const innerDiameter = Math.min(number("innerDiameter", defaults.innerDiameter), diameter - 0.25);
  return {
    definition: {
      kind,
      width: number("width", defaults.width),
      depth: number("depth", defaults.depth),
      height: number("height", defaults.height),
      diameter,
      topDiameter: number("topDiameter", defaults.topDiameter, 0),
      innerDiameter,
    },
    position: {
      x: clampPosition(value.x, -100, 100),
      y: clampPosition(value.y, -95, 95),
      z: clampPosition(value.z, 0, 245),
    },
  };
}

function clampPosition(value: unknown, min: number, max: number): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : 0;
}

function parsePromptLocally(prompt: string): AiCadPart[] {
  const lower = prompt.toLowerCase();
  const isBasketball = /basket\s*ball/.test(lower);
  const dimensions = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?))?/g)][0];
  const mentionsSupportedShape = isBasketball || ["box", "cube", "cylinder", "sphere", "ball", "cone", "tube", "ring"].some((word) => lower.includes(word));
  if (!mentionsSupportedShape && !dimensions) {
    throw new Error("This CAD builder supports simple boxes, cylinders, spheres, cones, and tubes. It cannot recreate a person or likeness.");
  }
  const kind: CadPrimitiveKind = isBasketball
    ? "basketball"
    : lower.includes("tube") || lower.includes("ring")
    ? "tube"
    : lower.includes("sphere") || lower.includes("ball")
      ? "sphere"
      : lower.includes("cylinder")
        ? "cylinder"
        : lower.includes("cone")
          ? "cone"
          : "box";
  const defaults = defaultCadDefinition(kind);
  const named = (name: string) => Number(lower.match(new RegExp(`${name}[^\\d]*(\\d+(?:\\.\\d+)?)`))?.[1]);
  if (kind === "box" && dimensions) {
    defaults.width = Number(dimensions[1]);
    defaults.depth = Number(dimensions[2]);
    defaults.height = Number(dimensions[3] ?? dimensions[2]);
  } else {
    const diameter = named("(?:outer )?diameter") || Number(dimensions?.[1]);
    const height = named("height") || Number(dimensions?.[2]);
    if (diameter) defaults.diameter = diameter;
    if (height) defaults.height = height;
    if (kind === "tube") {
      const inner = named("inner diameter") || named("hole");
      if (inner) defaults.innerDiameter = inner;
    }
  }
  return [normalizePart({ ...defaults, x: 0, y: 0, z: 0 })];
}
