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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      progress?.(`AI design attempt ${attempt} of 3`);
      try {
        const response = await window.puter.ai.chat(buildCadPrompt(prompt, attempt), { model: "gpt-5-nano" });
        const text = typeof response === "string" ? response : response.message?.content;
        if (typeof text !== "string") throw new Error("The AI returned no text plan.");
        return { parts: normalizePlan(extractJson(text)), engine: "cloud" };
      } catch (error) {
        lastError = error;
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

function buildCadPrompt(request: string, attempt: number): string {
  return `You are a CAD planner. Convert the request into a simple printable assembly made only from these primitives: box, cylinder, sphere, cone, tube, basketball, airlessBall.
Return JSON only, with no markdown, using exactly this schema:
{"parts":[{"kind":"box","width":30,"depth":30,"height":20,"diameter":30,"topDiameter":0,"innerDiameter":18,"x":0,"y":0,"z":0}]}
Use millimeters and 1 to 12 parts. Keep every dimension between 0.8 and 220. For tubes, innerDiameter must be smaller than diameter. Parts should overlap when they are intended to form one object. The K2 SE plate is 220 x 215 x 245 mm. Approximate complex objects with recognizable primitive assemblies. This is validation attempt ${attempt}; carefully return valid JSON. User request: ${request}`;
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
