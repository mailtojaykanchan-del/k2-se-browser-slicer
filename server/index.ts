import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import { K2_SE_PROFILE } from "../shared/profile.js";
import { normalizePrintSettings, validatePrintSettings } from "../shared/settings.js";
import { detectEngine, runEngine } from "./engine.js";
import { parseGcode } from "../shared/gcodeParser.js";
import { createPrusaConfig } from "./prusaProfile.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 150 * 1024 * 1024,
  },
});

interface StoredJob {
  id: string;
  gcodePath: string;
  filename: string;
  createdAt: number;
}

const jobs = new Map<string, StoredJob>();
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/printer-profile", (_request, response) => {
  response.json(K2_SE_PROFILE);
});

app.get("/api/engine", (_request, response) => {
  response.json(detectEngine());
});

app.post("/api/slice", upload.single("plate"), async (request, response, next) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Upload a transformed STL plate before slicing." });
      return;
    }

    const rawSettings = request.body.settings ? JSON.parse(request.body.settings) : {};
    const settings = normalizePrintSettings(rawSettings);
    const settingErrors = validatePrintSettings(settings);
    if (settingErrors.length > 0) {
      response.status(422).json({ error: "Print settings need attention.", details: settingErrors });
      return;
    }

    const engine = detectEngine();
    if (!engine.available || !engine.path) {
      response.status(503).json({
        error: "No real slicer engine is configured.",
        details: engine.message,
        searched: engine.searched,
      });
      return;
    }

    const jobId = crypto.randomUUID();
    const jobDir = path.join(os.tmpdir(), "k2-se-browser-slicer", jobId);
    const inputPath = path.join(jobDir, "plate.stl");
    const configPath = path.join(jobDir, "k2-se-prusa.ini");
    const outputPath = path.join(jobDir, "k2-se-print.gcode");

    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(inputPath, request.file.buffer);
    await fs.writeFile(configPath, createPrusaConfig(settings), "utf8");

    const args = [
      "--load",
      configPath,
      "--export-gcode",
      "--dont-arrange",
      "--output",
      outputPath,
      inputPath,
    ];

    const run = await runEngine(engine.path, args);
    if (!existsSync(outputPath)) {
      throw new Error(`The slicer completed but did not write ${outputPath}.\n${run.stderr || run.stdout}`);
    }

    const gcode = await fs.readFile(outputPath, "utf8");
    const summary = parseGcode(gcode, settings);
    const filename = `k2-se-${new Date().toISOString().replace(/[:.]/g, "-")}.gcode`;
    jobs.set(jobId, { id: jobId, gcodePath: outputPath, filename, createdAt: Date.now() });

    response.json({
      jobId,
      downloadUrl: `/api/download/${jobId}`,
      filename,
      engine: {
        name: engine.name,
        version: engine.version,
      },
      summary,
      log: [run.stdout, run.stderr].join("\n").trim().slice(-4000),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/download/:jobId", async (request, response) => {
  const job = jobs.get(request.params.jobId);
  if (!job) {
    response.status(404).json({ error: "G-code job not found or expired." });
    return;
  }

  response.download(job.gcodePath, job.filename);
});

const distPath = path.resolve("dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((request, response, next) => {
    if (request.method === "GET" && !request.path.startsWith("/api")) {
      response.sendFile(path.join(distPath, "index.html"));
      return;
    }
    next();
  });
}

setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      jobs.delete(jobId);
      void fs.rm(path.dirname(job.gcodePath), { recursive: true, force: true });
    }
  }
}, 30 * 60 * 1000).unref();

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  response.status(500).json({ error: message });
});

app.listen(PORT, HOST, () => {
  console.log(`K2 SE slicer API listening on http://${HOST}:${PORT}`);
});
