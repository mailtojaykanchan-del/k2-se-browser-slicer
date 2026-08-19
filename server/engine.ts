import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

export interface EngineInfo {
  available: boolean;
  name: string | null;
  path: string | null;
  version: string | null;
  searched: string[];
  message: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const macCandidates = [
  "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer",
  "/Applications/SuperSlicer.app/Contents/MacOS/SuperSlicer",
];

function candidateList(): string[] {
  const explicit = [process.env.PRUSASLICER_BIN, process.env.SUPERSLICER_BIN, process.env.SLICER_BIN]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));

  return [
    ...explicit,
    "prusa-slicer",
    "PrusaSlicer",
    "superslicer",
    "SuperSlicer",
    ...macCandidates,
  ];
}

function probe(binaryPath: string): { ok: boolean; version: string | null } {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 7000,
    });

    if (result.error || result.status !== 0) {
      return { ok: false, version: null };
    }

    const version = [result.stdout, result.stderr].join("\n").trim().split("\n").find(Boolean) ?? "available";
    return { ok: true, version };
  } catch {
    return { ok: false, version: null };
  }
}

export function detectEngine(): EngineInfo {
  const searched = candidateList();

  for (const binaryPath of searched) {
    const result = probe(binaryPath);
    if (result.ok) {
      const lowered = binaryPath.toLowerCase();
      return {
        available: true,
        name: lowered.includes("super") ? "SuperSlicer" : "PrusaSlicer",
        path: binaryPath,
        version: result.version,
        searched,
        message: "A PrusaSlicer-compatible engine is available.",
      };
    }
  }

  return {
    available: false,
    name: null,
    path: null,
    version: null,
    searched,
    message:
      "No slicer engine was found. Install PrusaSlicer or SuperSlicer, then set PRUSASLICER_BIN to the CLI binary path.",
  };
}

export function runEngine(binaryPath: string, args: string[], timeoutMs = 15 * 60 * 1000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Slicing timed out before the engine returned G-code."));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`Slicer exited with code ${code ?? "unknown"}.\n${stderr || stdout}`));
    });
  });
}
