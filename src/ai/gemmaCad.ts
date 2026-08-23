import type { CadDefinition, CadPrimitiveKind, Vec3Snapshot } from "../scene/SlicerScene";
import { defaultCadDefinition } from "../components/CadPanel";

const RUNTIME_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm";
const MODEL_ID = "onnx-community/gemma-3-1b-it-ONNX";

export interface AiCadPart {
  definition: CadDefinition;
  position: Vec3Snapshot;
}

type TextGenerator = (prompt: string, options: Record<string, unknown>) => Promise<unknown>;
let generator: TextGenerator | null = null;

export function isGemmaLoaded(): boolean {
  return generator !== null;
}

export async function loadGemma(progress: (message: string) => void): Promise<void> {
  if (generator) return;
  progress("Loading Gemma runtime");
  const transformers = await import(/* @vite-ignore */ RUNTIME_URL) as {
    env: { allowLocalModels: boolean };
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<TextGenerator>;
  };
  transformers.env.allowLocalModels = false;
  generator = await transformers.pipeline("text-generation", MODEL_ID, {
    device: "webgpu",
    dtype: "q4",
    progress_callback: (event: { status?: string; file?: string; progress?: number }) => {
      const percent = Number.isFinite(event.progress) ? ` ${Math.round(event.progress!)}%` : "";
      progress(`${event.status ?? "Loading"}${event.file ? ` ${event.file}` : ""}${percent}`);
    },
  });
  progress("Gemma ready");
}

export async function generateCadPlan(prompt: string): Promise<{ parts: AiCadPart[]; engine: "gemma" | "parser" }> {
  if (!generator) return { parts: parsePromptLocally(prompt), engine: "parser" };

  const instruction = `You create simple 3D-printable CAD assemblies. Return JSON only with this schema:
{"parts":[{"kind":"box|cylinder|sphere|cone|tube","width":30,"depth":30,"height":20,"diameter":30,"topDiameter":0,"innerDiameter":18,"x":0,"y":0,"z":0}]}
Use millimeters. Use at most 8 parts. All dimensions must be positive, except cone topDiameter may be zero. For tubes innerDiameter must be smaller than diameter. Only use the listed primitive kinds. If the request requires a person, face, likeness, sculpture, or unsupported freeform mesh, return {"error":"This request needs a freeform 3D model generator and cannot be made from CAD primitives."}. Request: ${prompt}`;
  const result = await generator(instruction, { max_new_tokens: 420, do_sample: false, temperature: 0.1 });
  const text = extractGeneratedText(result);
  const json = extractJson(text);
  const modelError = (json as { error?: unknown })?.error;
  if (typeof modelError === "string") throw new Error(modelError);
  return { parts: normalizePlan(json), engine: "gemma" };
}

function extractGeneratedText(result: unknown): string {
  if (!Array.isArray(result) || !result.length) throw new Error("Gemma returned no CAD plan.");
  const value = result[0] as { generated_text?: unknown };
  if (typeof value.generated_text === "string") return value.generated_text;
  if (Array.isArray(value.generated_text)) {
    const last = value.generated_text.at(-1) as { content?: unknown } | undefined;
    if (typeof last?.content === "string") return last.content;
  }
  throw new Error("Gemma returned an unreadable CAD plan.");
}

function extractJson(text: string): unknown {
  const start = text.lastIndexOf("{\"parts\"");
  const fallbackStart = text.indexOf("{");
  const from = start >= 0 ? start : fallbackStart;
  const end = text.lastIndexOf("}");
  if (from < 0 || end <= from) throw new Error("Gemma did not return valid CAD JSON.");
  return JSON.parse(text.slice(from, end + 1));
}

function normalizePlan(input: unknown): AiCadPart[] {
  const rawParts = (input as { parts?: unknown })?.parts;
  if (!Array.isArray(rawParts) || rawParts.length === 0) throw new Error("The CAD plan contains no parts.");
  return rawParts.slice(0, 8).map((raw) => normalizePart(raw));
}

function normalizePart(raw: unknown): AiCadPart {
  const value = raw as Record<string, unknown>;
  const allowed: CadPrimitiveKind[] = ["box", "cylinder", "sphere", "cone", "tube"];
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
  const dimensions = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*(?:mm)?\s*[x×]\s*(\d+(?:\.\d+)?))?/g)][0];
  const mentionsSupportedShape = ["box", "cube", "cylinder", "sphere", "ball", "cone", "tube", "ring"].some((word) => lower.includes(word));
  if (!mentionsSupportedShape && !dimensions) {
    throw new Error("This CAD builder supports simple boxes, cylinders, spheres, cones, and tubes. It cannot recreate a person or likeness.");
  }
  const kind: CadPrimitiveKind = lower.includes("tube") || lower.includes("ring")
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
