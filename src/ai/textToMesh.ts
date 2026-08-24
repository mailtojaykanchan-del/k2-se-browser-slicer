const API_ORIGIN = "https://three.ws";

interface GenerationState {
  status?: "done" | "pending" | "error";
  glbUrl?: string;
  poll?: string;
  job?: string;
  error?: string;
  message?: string;
  retry_after?: number;
}

interface PuterNetworkClient {
  net?: {
    fetch: (url: string, options?: RequestInit) => Promise<Response>;
  };
}

export interface GeneratedMesh {
  sourceUrl: string;
  buffer: ArrayBuffer;
}

export function needsTextToMesh(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const organic = /\b(detailed|realistic|figurine|sculpture|statue|animal|person|human|dog|cat|chicken|bird|horse|dragon|character|face|head|body)\b/.test(lower);
  const parametric = /\b(name\s*plate|box|cube|cylinder|sphere|cone|tube|ring|basket\s*ball|airless ball)\b/.test(lower);
  return organic && !parametric;
}

export async function generateTextMesh(prompt: string, progress: (message: string) => void): Promise<GeneratedMesh> {
  progress("Starting real text-to-3D generation");
  let state = await requestGeneration(prompt);
  const deadline = Date.now() + 6 * 60_000;

  while (state.status === "pending" && Date.now() < deadline) {
    progress("Generating detailed mesh; this can take several minutes");
    await delay(Math.max(4, state.retry_after ?? 5) * 1000);
    const pollPath = state.poll ?? (state.job ? `/api/3d/studio?job=${encodeURIComponent(state.job)}` : null);
    if (!pollPath) throw new Error("The 3D service returned no job handle.");
    state = await requestJson(new URL(pollPath, API_ORIGIN).toString(), { method: "GET" });
  }

  if (state.status === "done" && state.glbUrl) {
    progress("Downloading and checking the generated mesh");
    const response = await proxyFetch(state.glbUrl, { method: "GET" });
    if (!response.ok) throw new Error(`The generated mesh could not be downloaded (${response.status}).`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error("The 3D service returned an empty mesh.");
    if (buffer.byteLength > 150 * 1024 * 1024) throw new Error("The generated mesh exceeds the 150 MB browser limit.");
    return { sourceUrl: state.glbUrl, buffer };
  }
  if (Date.now() >= deadline) throw new Error("3D generation timed out after six minutes.");
  throw new Error(state.error ?? state.message ?? "The 3D generator could not create this mesh.");
}

async function requestGeneration(prompt: string): Promise<GenerationState> {
  try {
    return await requestJson(`${API_ORIGIN}/api/3d/studio`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, tier: "standard" }),
    });
  } catch (error) {
    await delay(1500);
    return requestJson(`${API_ORIGIN}/api/3d/studio`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, tier: "standard" }),
    }).catch(() => { throw error; });
  }
}

async function requestJson(url: string, init: RequestInit): Promise<GenerationState> {
  const response = await proxyFetch(url, init);
  const data = await response.json().catch(() => ({})) as GenerationState;
  if (!response.ok) {
    if (response.status === 429) throw new Error("The free 3D generation limit was reached. Try again later.");
    throw new Error(data.error ?? data.message ?? `3D service error ${response.status}.`);
  }
  return data;
}

function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  const puter = window.puter as (typeof window.puter & PuterNetworkClient) | undefined;
  if (!puter?.net?.fetch) {
    throw new Error("Puter networking is unavailable. Reload the page and try again.");
  }
  return puter.net.fetch(url, init);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}
