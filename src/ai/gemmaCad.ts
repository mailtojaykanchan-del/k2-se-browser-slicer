import type { CadDefinition, CadPrimitiveKind, Vec3Snapshot } from "../scene/SlicerScene";
import { defaultCadDefinition } from "../components/CadPanel";

export interface AiCadPart {
  definition: CadDefinition;
  position: Vec3Snapshot;
}

interface PuterChatResponse {
  message?: { content?: unknown };
}

interface PuterClient {
  ai: { chat: (prompt: string, options?: Record<string, unknown>) => Promise<PuterChatResponse | string> };
}

declare global {
  interface Window { puter?: PuterClient }
}

export async function generateCadPlan(
  prompt: string,
  progress?: (message: string) => void,
): Promise<{ parts: AiCadPart[]; engine: "cloud" | "parser" }> {
  if (window.puter?.ai) {
    let lastError: unknown;
    let feedback = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      progress?.(`AI design attempt ${attempt} of 3`);
      try {
        const response = await window.puter.ai.chat(buildCadPrompt(prompt, attempt, feedback), { model: "gpt-5-nano" });
        const text = typeof response === "string" ? response : response.message?.content;
        if (typeof text !== "string") throw new Error("The AI returned no text plan.");
        const parts = normalizeAssembly(normalizePlan(extractJson(text)));
        validateAssembly(parts);
        return { parts, engine: "cloud" };
      } catch (error) {
        lastError = error;
        feedback = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      progress?.("Cloud AI failed; trying the built-in designer");
      return { parts: parsePromptLocally(prompt), engine: "parser" };
    } catch {
      const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
      throw new Error(`AI could not produce valid printable CAD after 3 attempts: ${detail}`);
    }
  }

  progress?.("Cloud AI unavailable; using the built-in designer");
  return { parts: parsePromptLocally(prompt), engine: "parser" };
}

function buildCadPrompt(request: string, attempt: number, feedback: string): string {
  return `You are a CAD planner. Convert the request into a simple printable assembly made only from these primitives: box, cylinder, sphere, cone, tube, basketball, airlessBall.
Return JSON only, with no markdown, using exactly this schema:
{"parts":[{"kind":"box","width":30,"depth":30,"height":20,"diameter":30,"topDiameter":0,"innerDiameter":18,"x":0,"y":0,"z":0}]}
Coordinates x and y are the center of each part. Coordinate z is the bottom of each part, not its center. Use millimeters and 1 to 12 parts. Make an ordinary unspecified object about 60 to 90 mm across, never larger than 100 mm unless the user gives dimensions. Keep every primitive dimension between 0.8 and 100. For tubes, innerDiameter must be smaller than diameter. Every part in a multi-part design MUST touch or overlap another part, and all parts together MUST form one connected assembly. Center the assembly near x=0 and y=0, place its lowest point at z=0, and keep it upright. Approximate complex objects with recognizable proportions and connected primitive assemblies. This is validation attempt ${attempt}.${feedback ? ` The previous attempt failed validation: ${feedback}. Correct that problem.` : ""} Return valid JSON only. User request: ${request}`;
}

function extractJson(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI response did not contain JSON.");
  return JSON.parse(fenced.slice(start, end + 1));
}

function normalizePlan(input: unknown): AiCadPart[] {
  const rawParts = (input as { parts?: unknown })?.parts;
  if (!Array.isArray(rawParts) || rawParts.length === 0) throw new Error("The AI plan contains no parts.");
  return rawParts.slice(0, 12).map(normalizePart);
}

function normalizeAssembly(parts: AiCadPart[]): AiCadPart[] {
  const initial = parts.map(partBounds);
  const minX = Math.min(...initial.map(box => box.minX));
  const maxX = Math.max(...initial.map(box => box.maxX));
  const minY = Math.min(...initial.map(box => box.minY));
  const maxY = Math.max(...initial.map(box => box.maxY));
  const minZ = Math.min(...initial.map(box => box.minZ));
  const maxZ = Math.max(...initial.map(box => box.maxZ));
  const largestSpan = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const scale = largestSpan > 100 ? 100 / largestSpan : largestSpan < 20 ? 20 / Math.max(largestSpan, 0.1) : 1;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return parts.map(part => ({
    definition: {
      ...part.definition,
      width: part.definition.width * scale,
      depth: part.definition.depth * scale,
      height: part.definition.height * scale,
      diameter: part.definition.diameter * scale,
      topDiameter: part.definition.topDiameter * scale,
      innerDiameter: part.definition.innerDiameter * scale,
    },
    position: {
      x: (part.position.x - centerX) * scale,
      y: (part.position.y - centerY) * scale,
      z: (part.position.z - minZ) * scale,
    },
  }));
}

function validateAssembly(parts: AiCadPart[]): void {
  const bounds = parts.map(partBounds);
  for (const box of bounds) {
    if (box.minX < -110 || box.maxX > 110 || box.minY < -107.5 || box.maxY > 107.5 || box.minZ < 0 || box.maxZ > 245) {
      throw new Error("The assembly exceeds the K2 SE build volume.");
    }
  }
  if (parts.length < 2) return;
  const reached = new Set<number>([0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < bounds.length; index += 1) {
      if (reached.has(index)) continue;
      if ([...reached].some(other => boxesTouch(bounds[index], bounds[other], 1.25))) {
        reached.add(index);
        changed = true;
      }
    }
  }
  if (reached.size !== parts.length) throw new Error("The parts do not form one connected assembly.");
}

interface PartBounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

function partBounds(part: AiCadPart): PartBounds {
  const { definition, position } = part;
  const round = ["cylinder", "sphere", "cone", "tube", "basketball", "airlessBall"].includes(definition.kind);
  const width = round ? definition.diameter : definition.width;
  const depth = round ? definition.diameter : definition.depth;
  const height = ["sphere", "basketball", "airlessBall"].includes(definition.kind) ? definition.diameter : definition.height;
  return {
    minX: position.x - width / 2,
    maxX: position.x + width / 2,
    minY: position.y - depth / 2,
    maxY: position.y + depth / 2,
    minZ: position.z,
    maxZ: position.z + height,
  };
}

function boxesTouch(a: PartBounds, b: PartBounds, tolerance: number): boolean {
  return a.minX <= b.maxX + tolerance && a.maxX + tolerance >= b.minX
    && a.minY <= b.maxY + tolerance && a.maxY + tolerance >= b.minY
    && a.minZ <= b.maxZ + tolerance && a.maxZ + tolerance >= b.minZ;
}

function normalizePart(raw: unknown): AiCadPart {
  const value = raw as Record<string, unknown>;
  const allowed: CadPrimitiveKind[] = ["box", "cylinder", "sphere", "cone", "tube", "basketball", "airlessBall"];
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
  const isAirlessBall = lower.includes("airless") && lower.includes("ball");
  const dimensions = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?))?/g)][0];
  const mentionsSupportedShape = isBasketball || isAirlessBall || ["box", "cube", "cylinder", "sphere", "ball", "cone", "tube", "ring"].some((word) => lower.includes(word));
  if (!mentionsSupportedShape && !dimensions) {
    throw new Error("This CAD builder supports simple boxes, cylinders, spheres, cones, and tubes. It cannot recreate a person or likeness.");
  }
  const kind: CadPrimitiveKind = isAirlessBall
    ? "airlessBall"
    : isBasketball
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
