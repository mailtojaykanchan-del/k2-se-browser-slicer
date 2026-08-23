import {
  Box,
  Boxes,
  CheckCircle2,
  CircleHelp,
  Combine,
  Copy,
  Crosshair,
  Download,
  ArrowRightLeft,
  FileUp,
  Grid3X3,
  LoaderCircle,
  Move3D,
  MousePointer2,
  Plus,
  Scan,
  Rotate3D,
  Ruler,
  Scale3D,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CadPanel, defaultCadDefinition } from "./components/CadPanel";
import { ConverterPanel } from "./components/ConverterPanel";
import { AiCadPanel } from "./components/AiCadPanel";
import { LayerPreview, type LayerPreviewLayer } from "./components/LayerPreview";
import { formatDuration, formatGrams, formatMetersFromMm, formatMm } from "./lib/format";
import {
  type CadDefinition,
  type CameraView,
  type ModelFileFormat,
  type ModelSnapshot,
  type TransformMode,
  SlicerScene,
} from "./scene/SlicerScene";
import { sliceInBrowser, type BrowserSliceProgress } from "./slicing/kiriEngine";
import { K2_SE_PROFILE } from "../shared/profile";
import { parseGcode } from "../shared/gcodeParser";
import { errorMessage, generateCadPlan, isGemmaLoaded, loadGemma } from "./ai/gemmaCad";
import {
  DEFAULT_PRINT_SETTINGS,
  type AdhesionMode,
  type InfillPattern,
  type PrintSettings,
  normalizePrintSettings,
  validatePrintSettings,
} from "../shared/settings";

interface SliceSummary {
  layerCount: number;
  filamentMm: number;
  filamentCm3: number;
  filamentG: number;
  estimatedSeconds: number;
  timeSource: "slicer-comment" | "motion-estimate";
  totalExtrusionSegments: number;
  sampled: boolean;
  layers: LayerPreviewLayer[];
}

interface SliceResult {
  downloadUrl: string;
  filename: string;
  engine: {
    name: string | null;
    version: string | null;
  };
  summary: SliceSummary;
  log: string;
}

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
type WorkspaceMode = "prepare" | "cad" | "ai" | "convert";

function plateSignature(models: ModelSnapshot[]): string {
  return JSON.stringify(
    models
      .map(({ id, dimensions, position, rotation, scale, cad, connected }) => ({ id, dimensions, position, rotation, scale, cad, connected }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SlicerScene | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const converterInputRef = useRef<HTMLInputElement | null>(null);
  const conversionRef = useRef<{ source: "stl" | "3mf"; output: ModelFileFormat } | null>(null);
  const [models, setModels] = useState<ModelSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("prepare");
  const [cadDraft, setCadDraft] = useState<CadDefinition>(() => defaultCadDefinition("box"));
  const [mode, setMode] = useState<TransformMode>("translate");
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_PRINT_SETTINGS);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [sliceProgress, setSliceProgress] = useState<BrowserSliceProgress | null>(null);
  const [sliceStartedAt, setSliceStartedAt] = useState<number | null>(null);
  const [sliceElapsed, setSliceElapsed] = useState(0);
  const [sliceResult, setSliceResult] = useState<SliceResult | null>(null);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [conversionNotice, setConversionNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiModelLoaded, setAiModelLoaded] = useState(isGemmaLoaded());
  const [aiStatus, setAiStatus] = useState("Runs on this device; no API key");
  const [activeLayer, setActiveLayer] = useState(0);
  const downloadUrlRef = useRef<string | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const plateSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canvasRef.current || sceneRef.current) return;
    const scene = new SlicerScene(
      canvasRef.current,
      (nextModels, nextSelectedId) => {
        const nextSignature = plateSignature(nextModels);
        if (plateSignatureRef.current !== null && plateSignatureRef.current !== nextSignature) {
          invalidateSliceResult();
        }
        plateSignatureRef.current = nextSignature;
        setModels(nextModels);
        setSelectedId(nextSelectedId);
      },
      setSliceError,
    );
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => () => {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
  }, []);

  useEffect(() => {
    if (!sliceResult) return;
    resultRef.current?.focus({ preventScroll: false });
  }, [sliceResult]);

  useEffect(() => {
    const selectedCad = models.find((model) => model.id === selectedId)?.cad;
    if (selectedCad) setCadDraft({ ...selectedCad });
  }, [selectedId]);

  useEffect(() => {
    if (sliceStartedAt === null) {
      setSliceElapsed(0);
      return;
    }

    const updateElapsed = () => setSliceElapsed(Math.floor((Date.now() - sliceStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [sliceStartedAt]);

  const selectedModel = models.find((model) => model.id === selectedId) ?? null;
  const cadError = useMemo(() => {
    const values = [cadDraft.width, cadDraft.depth, cadDraft.height, cadDraft.diameter, cadDraft.topDiameter, cadDraft.innerDiameter];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return "Enter valid non-negative dimensions.";
    if (cadDraft.kind === "box" && (cadDraft.width <= 0 || cadDraft.depth <= 0 || cadDraft.height <= 0)) {
      return "Width, depth, and height must be greater than zero.";
    }
    if (cadDraft.kind !== "box" && cadDraft.diameter <= 0) {
      return "Diameter must be greater than zero.";
    }
    if (cadDraft.kind !== "sphere" && cadDraft.kind !== "box" && cadDraft.height <= 0) {
      return "Height must be greater than zero.";
    }
    if (cadDraft.kind === "tube" && cadDraft.innerDiameter <= 0) {
      return "Inner diameter must be greater than zero.";
    }
    if (cadDraft.kind === "tube" && cadDraft.innerDiameter >= cadDraft.diameter) {
      return "Inner diameter must be smaller than outer diameter.";
    }
    return null;
  }, [cadDraft]);
  const settingsErrors = useMemo(() => validatePrintSettings(settings), [settings]);
  const boundaryErrors = models.flatMap((model) =>
    model.warnings
      .filter((warning) => warning.includes("Outside") || warning.includes("Exceeds") || warning.includes("Below"))
      .map((warning) => `${model.name}: ${warning}`),
  );
  const isSlicing = sliceStartedAt !== null;
  const canSlice = models.length > 0 && settingsErrors.length === 0 && boundaryErrors.length === 0 && !busyMessage && !isSlicing;

  const roughEstimate = useMemo(() => {
    const maxZ = Math.max(0, ...models.map((model) => model.dimensions.z));
    const totalFootprint = models.reduce((sum, model) => sum + model.dimensions.x * model.dimensions.y, 0);
    const layers = Math.ceil(maxZ / settings.layerHeight);
    const sparseVolume = totalFootprint * Math.max(maxZ, 1) * (0.08 + settings.infillDensity / 100);
    const filamentArea = Math.PI * (settings.filamentDiameter / 2) ** 2;
    const filamentMm = sparseVolume / filamentArea;
    const seconds = (sparseVolume / 18) * (180 / Math.max(settings.speeds.infill, 1));
    return {
      layers: Number.isFinite(layers) ? layers : 0,
      filamentMm: Math.max(0, filamentMm),
      seconds: Math.max(0, seconds),
    };
  }, [models, settings]);

  const slicePercent = Math.round(sliceProgress?.percent ?? 0);
  const progressIdleSeconds = sliceProgress ? Math.floor((Date.now() - sliceProgress.updatedAt) / 1000) : 0;
  const elapsedLabel = sliceElapsed < 60 ? `${sliceElapsed}s` : formatDuration(sliceElapsed);
  const slowProgressLabel = progressIdleSeconds >= 30
    ? ` | This step has been working for ${progressIdleSeconds}s`
    : "";

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length || !sceneRef.current) return;
    invalidateSliceResult();
    setSliceError(null);

    for (const file of [...fileList]) {
      try {
        setBusyMessage(`Loading model: ${file.name}`);
        await sceneRef.current.loadFile(file);
        setSliceError(null);
      } catch (error) {
        setSliceError(error instanceof Error ? error.message : "Could not load model.");
      } finally {
        setBusyMessage(null);
      }
    }
  }

  function invalidateSliceResult() {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setSliceResult(null);
    setActiveLayer(0);
  }

  function updateMode(nextMode: TransformMode) {
    setMode(nextMode);
    sceneRef.current?.setMode(nextMode);
  }

  function changeWorkspaceMode(nextMode: WorkspaceMode) {
    setWorkspaceMode(nextMode);
    if (nextMode === "cad" || nextMode === "ai") sceneRef.current?.setCameraView("iso");
  }

  async function loadLocalGemma() {
    if (aiBusy || aiModelLoaded) return;
    setAiBusy(true);
    try {
      await loadGemma(setAiStatus);
      setAiModelLoaded(true);
      setAiStatus("Ready on this device");
    } catch (error) {
      setAiStatus(`Gemma unavailable: ${errorMessage(error)}`);
    } finally {
      setAiBusy(false);
    }
  }

  async function generateAiCad(prompt: string) {
    if (!sceneRef.current || aiBusy) return;
    if (!aiModelLoaded) {
      setAiStatus("Load Gemma before generating CAD");
      return;
    }
    setAiBusy(true);
    setSliceError(null);
    try {
      const plan = await generateCadPlan(prompt);
      invalidateSliceResult();
      for (const part of plan.parts) {
        sceneRef.current.createCadPrimitive(part.definition);
        sceneRef.current.updateSelectedTransform({ position: part.position });
      }
      sceneRef.current.setCameraView("iso");
      setAiStatus(plan.engine === "gemma"
        ? `Gemma created ${plan.parts.length} part${plan.parts.length === 1 ? "" : "s"}`
        : `Created ${plan.parts.length} part with the local fallback`);
    } catch (error) {
      setAiStatus(error instanceof Error ? error.message : "Could not generate this CAD model");
    } finally {
      setAiBusy(false);
    }
  }

  function addCadPart() {
    if (!sceneRef.current || cadError) return;
    invalidateSliceResult();
    sceneRef.current.createCadPrimitive(cadDraft);
  }

  function applyCadPart() {
    if (!sceneRef.current || !selectedModel?.cad || cadError) return;
    invalidateSliceResult();
    sceneRef.current.updateSelectedCadPrimitive(cadDraft);
  }

  function downloadSelectedStl() {
    const blob = sceneRef.current?.exportSelectedAsStlBlob();
    if (!blob || !selectedModel) return;
    downloadBlob(blob, selectedModel.name, "stl");
  }

  function downloadBlob(blob: Blob, sourceName: string, extension: ModelFileFormat) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const baseName = sourceName.replace(/\.(stl|3mf)$/i, "").replace(/[^a-z0-9_-]+/gi, "-") || "converted-model";
    anchor.download = `${baseName}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function startConversion(source: "cad" | "stl" | "3mf", output: ModelFileFormat) {
    setSliceError(null);
    setConversionNotice(null);
    if (source === "cad") {
      try {
        const blob = output === "stl"
          ? sceneRef.current?.exportSelectedAsStlBlob()
          : sceneRef.current?.exportSelectedAs3mfBlob();
        if (!blob || (!selectedModel?.cad && !selectedModel?.connected)) {
          setConversionNotice("Select a CAD part before converting it.");
          return;
        }
        downloadBlob(blob, selectedModel.name, output);
        setConversionNotice(`CAD converted to ${output.toUpperCase()}.`);
      } catch (error) {
        setConversionNotice(error instanceof Error ? error.message : "Could not convert this CAD part.");
      }
      return;
    }

    conversionRef.current = { source, output };
    if (converterInputRef.current) {
      converterInputRef.current.accept = `.${source}`;
      converterInputRef.current.click();
    }
  }

  async function handleConversionFile(file: File | undefined) {
    const conversion = conversionRef.current;
    conversionRef.current = null;
    if (!file || !conversion || !sceneRef.current) return;
    const extension = file.name.toLowerCase().split(".").pop();
    if (extension !== conversion.source) {
      setConversionNotice(`Choose a ${conversion.source.toUpperCase()} file.`);
      return;
    }

    try {
      setBusyMessage(`Converting ${file.name}`);
      setConversionNotice(null);
      const blob = await sceneRef.current.convertFile(file, conversion.output);
      downloadBlob(blob, file.name, conversion.output);
      setConversionNotice(`${file.name} converted to ${conversion.output.toUpperCase()}.`);
    } catch (error) {
      setConversionNotice(error instanceof Error ? error.message : "Could not convert this file.");
    } finally {
      setBusyMessage(null);
    }
  }

  function setCameraView(view: CameraView) {
    sceneRef.current?.setCameraView(view);
  }

  function patchSettings(patch: Partial<PrintSettings>) {
    invalidateSliceResult();
    setSettings((current) => normalizePrintSettings({ ...current, ...patch }));
  }

  function patchSpeeds(patch: Partial<PrintSettings["speeds"]>) {
    invalidateSliceResult();
    setSettings((current) => normalizePrintSettings({ ...current, speeds: { ...current.speeds, ...patch } }));
  }

  function updateTransform(
    group: "position" | "rotationDeg" | "scale",
    axis: "x" | "y" | "z",
    value: number,
  ) {
    invalidateSliceResult();
    sceneRef.current?.updateSelectedTransform({ [group]: { [axis]: value } });
  }

  async function slicePlate() {
    if (!sceneRef.current || !canSlice) return;
    const startedAt = Date.now();
    setSliceStartedAt(startedAt);
    setSliceProgress({
      stage: "loading",
      message: "Loading browser slicer",
      percent: 1,
      updatedAt: startedAt,
    });
    setSliceError(null);
    setSliceResult(null);
    setActiveLayer(0);

    try {
      const plateBlob = sceneRef.current.exportPlateAsStlBlob();
      const output = await sliceInBrowser(plateBlob, settings, setSliceProgress);
      setSliceProgress({
        stage: "gcode",
        message: "Checking generated G-code",
        percent: 99,
        updatedAt: Date.now(),
      });
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const summary = parseGcode(output.gcode, settings);
      const filename = `k2-se-${new Date().toISOString().replace(/[:.]/g, "-")}.gcode`;

      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      const downloadUrl = URL.createObjectURL(new Blob([output.gcode], { type: "text/x-gcode" }));
      downloadUrlRef.current = downloadUrl;

      const payload: SliceResult = {
        downloadUrl,
        filename,
        engine: { name: output.engineName, version: null },
        summary,
        log: "",
      };
      setSliceResult(payload);
      setActiveLayer(Math.max(0, Math.min(payload.summary.layers.length - 1, 0)));
    } catch (error) {
      setSliceError(error instanceof Error ? error.message : "Slicing failed.");
    } finally {
      setSliceStartedAt(null);
      setSliceProgress(null);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div className="brandBlock">
          <div className="brandMark">
            <Scissors size={20} />
          </div>
          <div>
            <h1>K2 SE Browser Slicer</h1>
            <p>Single-filament PLA profile for {K2_SE_PROFILE.buildVolume.x} x {K2_SE_PROFILE.buildVolume.y} x {K2_SE_PROFILE.buildVolume.z} mm</p>
          </div>
        </div>

        <div className="topActions">
          <div className="workspaceModeSwitch" role="tablist" aria-label="Workspace mode">
            <button type="button" role="tab" aria-selected={workspaceMode === "prepare"} className={workspaceMode === "prepare" ? "selected" : ""} onClick={() => changeWorkspaceMode("prepare")}>
              <Scissors size={16} />
              Prepare
            </button>
            <button type="button" role="tab" aria-selected={workspaceMode === "cad"} className={workspaceMode === "cad" ? "selected" : ""} onClick={() => changeWorkspaceMode("cad")}>
              <Box size={16} />
              CAD
            </button>
            <button type="button" role="tab" aria-selected={workspaceMode === "ai"} className={workspaceMode === "ai" ? "selected" : ""} onClick={() => changeWorkspaceMode("ai")}>
              <Sparkles size={16} />
              AI CAD
            </button>
            <button type="button" role="tab" aria-selected={workspaceMode === "convert"} className={workspaceMode === "convert" ? "selected" : ""} onClick={() => changeWorkspaceMode("convert")}>
              <ArrowRightLeft size={16} />
              Convert
            </button>
          </div>
          <span className={`enginePill ${sliceResult ? "ok" : "warn"}`} role="status" aria-live="polite">
            {isSlicing
              ? `Slicing ${slicePercent}%`
              : sliceResult
                ? "Slice complete"
                : models.length > 0
                  ? "Ready to slice"
                  : "No model loaded"}
          </span>
          <button className="primaryButton" type="button" onClick={() => fileInputRef.current?.click()}>
            <FileUp size={18} />
            Upload STL / 3MF
          </button>
          <input
            ref={fileInputRef}
            className="hiddenInput"
            type="file"
            accept=".stl,.3mf,model/stl"
            multiple
            onChange={(event) => void handleFiles(event.target.files)}
          />
          <input
            ref={converterInputRef}
            className="hiddenInput"
            type="file"
            onChange={(event) => {
              void handleConversionFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <section className="workspace">
        <aside className="panel modelPanel">
          {workspaceMode === "cad" ? (
            <CadPanel
              definition={cadDraft}
              selectedIsCad={Boolean(selectedModel?.cad || selectedModel?.connected)}
              selectedCanResize={Boolean(selectedModel?.cad)}
              canConnect={Boolean(selectedModel) && models.length > 1}
              error={cadError}
              onChange={setCadDraft}
              onAdd={addCadPart}
              onApply={applyCadPart}
              onDownload={downloadSelectedStl}
              onConnect={() => sceneRef.current?.connectTouchingModels()}
              onView={setCameraView}
            />
          ) : workspaceMode === "convert" ? (
            <ConverterPanel
              selectedCadName={selectedModel?.cad || selectedModel?.connected ? selectedModel.name : null}
              converting={busyMessage?.startsWith("Converting ") ?? false}
              notice={conversionNotice}
              onConvert={startConversion}
            />
          ) : workspaceMode === "ai" ? (
            <AiCadPanel
              modelLoaded={aiModelLoaded}
              busy={aiBusy}
              status={aiStatus}
              onLoadModel={() => void loadLocalGemma()}
              onGenerate={(prompt) => void generateAiCad(prompt)}
            />
          ) : (
            <DropZone onFiles={handleFiles} busy={busyMessage?.startsWith("Loading model:") ? busyMessage : null} />
          )}

          <section className="panelSection">
            <div className="sectionTitle">
              <Boxes size={16} />
              <h2>Models</h2>
              <span>{models.length}</span>
            </div>
            <div className="modelList">
              {models.length === 0 ? (
                <div className="emptyState">
                  {workspaceMode === "cad"
                    ? "Add a CAD primitive to start a new part."
                    : workspaceMode === "ai"
                      ? "No AI-generated parts yet."
                      : "Upload an STL first. 3MF files are accepted when their geometry can be read in the browser."}
                </div>
              ) : (
                models.map((model) => (
                  <button
                    key={model.id}
                    className={`modelRow ${model.selected ? "active" : ""} ${model.valid ? "" : "invalid"}`}
                    type="button"
                    onClick={() => sceneRef.current?.selectModel(model.id)}
                  >
                    <span className="colorSwatch" style={{ background: model.color }} />
                    <span>
                      <strong>{model.name}</strong>
                      <small>
                        {formatMm(model.dimensions.x)} x {formatMm(model.dimensions.y)} x {formatMm(model.dimensions.z)}
                      </small>
                      <small>{model.cad ? `CAD ${model.cad.kind} | ` : model.connected ? "Connected CAD | " : ""}{numberFormatter.format(model.triangleCount)} triangles</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="panelSection">
            <div className="sectionTitle">
              <Ruler size={16} />
              <h2>Object</h2>
            </div>
            {selectedModel ? (
              <div className="transformGrid">
                <Metric label="Size X" value={formatMm(selectedModel.dimensions.x)} />
                <Metric label="Size Y" value={formatMm(selectedModel.dimensions.y)} />
                <Metric label="Size Z" value={formatMm(selectedModel.dimensions.z)} />
                <Metric label="Triangles" value={numberFormatter.format(selectedModel.triangleCount)} />
                <NumberField label="Move X" value={selectedModel.position.x} step={1} onChange={(value) => updateTransform("position", "x", value)} />
                <NumberField label="Move Y" value={selectedModel.position.y} step={1} onChange={(value) => updateTransform("position", "y", value)} />
                <NumberField label="Move Z" value={selectedModel.position.z} step={1} onChange={(value) => updateTransform("position", "z", value)} />
                <NumberField label="Rot X" value={selectedModel.rotation.x} step={5} onChange={(value) => updateTransform("rotationDeg", "x", value)} />
                <NumberField label="Rot Y" value={selectedModel.rotation.y} step={5} onChange={(value) => updateTransform("rotationDeg", "y", value)} />
                <NumberField label="Rot Z" value={selectedModel.rotation.z} step={5} onChange={(value) => updateTransform("rotationDeg", "z", value)} />
                <NumberField label="Scale X" value={selectedModel.scale.x} step={0.05} onChange={(value) => updateTransform("scale", "x", value)} />
                <NumberField label="Scale Y" value={selectedModel.scale.y} step={0.05} onChange={(value) => updateTransform("scale", "y", value)} />
                <NumberField label="Scale Z" value={selectedModel.scale.z} step={0.05} onChange={(value) => updateTransform("scale", "z", value)} />
              </div>
            ) : (
              <div className="emptyState">Select a model to edit dimensions and transforms.</div>
            )}
          </section>
        </aside>

        <section className="viewerPanel">
          <div className="viewerToolbar" aria-label="Model tools">
            <IconButton active={mode === "translate"} label="Move" onClick={() => updateMode("translate")}>
              <Move3D size={18} />
            </IconButton>
            <IconButton active={mode === "rotate"} label="Rotate" onClick={() => updateMode("rotate")}>
              <Rotate3D size={18} />
            </IconButton>
            <IconButton active={mode === "scale"} label="Scale" onClick={() => updateMode("scale")}>
              <Scale3D size={18} />
            </IconButton>
            <span className="toolbarDivider" />
            <IconButton label="Center" disabled={!selectedModel} onClick={() => sceneRef.current?.centerSelected()}>
              <Crosshair size={18} />
            </IconButton>
            <IconButton label="Fit view" disabled={!selectedModel} onClick={() => sceneRef.current?.focusSelected()}>
              <Scan size={18} />
            </IconButton>
            <IconButton label="Lay flat" disabled={!selectedModel} onClick={() => sceneRef.current?.layFlatSelected()}>
              <Box size={18} />
            </IconButton>
            <IconButton label="Reset" disabled={!selectedModel} onClick={() => sceneRef.current?.resetSelected()}>
              <Undo2 size={18} />
            </IconButton>
            <IconButton label="Duplicate" disabled={!selectedModel} onClick={() => sceneRef.current?.duplicateSelected()}>
              <Copy size={18} />
            </IconButton>
            <IconButton
              label="Connect touching objects"
              disabled={!selectedModel || models.length < 2}
              onClick={() => sceneRef.current?.connectTouchingModels()}
            >
              <Combine size={18} />
            </IconButton>
            <IconButton label="Delete" disabled={!selectedModel} onClick={() => sceneRef.current?.deleteSelected()}>
              <Trash2 size={18} />
            </IconButton>
            <IconButton label="Auto arrange" disabled={models.length === 0} onClick={() => sceneRef.current?.autoArrange()}>
              <Grid3X3 size={18} />
            </IconButton>
          </div>

          <div className="canvasFrame">
            <canvas ref={canvasRef} />
            {sliceError && <div className="viewerError" role="alert">{sliceError}</div>}
            {models.length === 0 && workspaceMode !== "ai" && workspaceMode !== "convert" && (
              <button className="canvasEmpty" type="button" onClick={workspaceMode === "cad" ? addCadPart : () => fileInputRef.current?.click()}>
                {workspaceMode === "cad" ? <Plus size={24} /> : <MousePointer2 size={24} />}
                <span>{workspaceMode === "cad" ? "Add a CAD part to the K2 SE plate" : "Upload STL / 3MF to place a model on the K2 SE plate"}</span>
              </button>
            )}
            {busyMessage ? (
              <div className="busyOverlay">
                <LoaderCircle size={22} />
                {busyMessage}
              </div>
            ) : isSlicing && sliceProgress ? (
              <div className="busyOverlay sliceBusyOverlay" role="status" aria-live="polite">
                <LoaderCircle size={22} />
                <span>
                  <strong>{sliceProgress.message}</strong>
                  <small>{slicePercent}% | {elapsedLabel} elapsed{slowProgressLabel}</small>
                  <progress value={sliceProgress.percent} max={100} aria-label="Slicing progress" />
                </span>
              </div>
            ) : null}
          </div>

          <div className="statusStrip">
            <Metric label="Plate" value={`${K2_SE_PROFILE.buildVolume.x} x ${K2_SE_PROFILE.buildVolume.y} mm`} />
            <Metric label="Height" value={`${K2_SE_PROFILE.buildVolume.z} mm`} />
            <Metric label="Workspace" value={workspaceMode === "cad" ? "CAD" : workspaceMode === "ai" ? "AI CAD" : workspaceMode === "convert" ? "Convert" : "Prepare"} />
            <Metric label="Profile" value="PLA, single filament" />
          </div>
        </section>

        <aside className="panel settingsPanel">
          <section className="panelSection">
            <div className="sectionTitle">
              <Sparkles size={16} />
              <h2>PLA Settings</h2>
            </div>

            <details open>
              <summary>Quality</summary>
              <div className="fieldGrid">
                <NumberField label="Layer height" value={settings.layerHeight} step={0.02} min={0.05} max={0.35} onChange={(layerHeight) => patchSettings({ layerHeight })} />
                <NumberField label="Walls" value={settings.walls} step={1} min={1} max={8} onChange={(walls) => patchSettings({ walls })} />
                <NumberField label="Top layers" value={settings.topLayers} step={1} min={0} max={12} onChange={(topLayers) => patchSettings({ topLayers })} />
                <NumberField label="Bottom layers" value={settings.bottomLayers} step={1} min={0} max={12} onChange={(bottomLayers) => patchSettings({ bottomLayers })} />
              </div>
            </details>

            <details open>
              <summary>Infill and supports</summary>
              <div className="fieldGrid">
                <NumberField label="Infill" value={settings.infillDensity} suffix="%" step={5} min={0} max={100} onChange={(infillDensity) => patchSettings({ infillDensity })} />
                <label className="field">
                  <span>Pattern</span>
                  <select value={settings.infillPattern} onChange={(event) => patchSettings({ infillPattern: event.target.value as InfillPattern })}>
                    <option value="gyroid">Gyroid</option>
                    <option value="grid">Grid</option>
                    <option value="cubic">Cubic</option>
                    <option value="rectilinear">Rectilinear</option>
                    <option value="honeycomb">Honeycomb</option>
                  </select>
                </label>
                <label className="toggleField">
                  <input type="checkbox" checked={settings.supports} onChange={(event) => patchSettings({ supports: event.target.checked })} />
                  <span>Supports</span>
                </label>
                <NumberField label="Overhang" value={settings.supportOverhang} suffix="deg" step={5} min={0} max={90} onChange={(supportOverhang) => patchSettings({ supportOverhang })} />
              </div>
            </details>

            <details>
              <summary>Adhesion</summary>
              <div className="segmented">
                {(["none", "skirt", "brim"] as AdhesionMode[]).map((adhesion) => (
                  <button
                    key={adhesion}
                    type="button"
                    className={settings.adhesion === adhesion ? "selected" : ""}
                    onClick={() => patchSettings({ adhesion })}
                  >
                    {adhesion}
                  </button>
                ))}
              </div>
              <div className="fieldGrid">
                <NumberField label="Brim width" value={settings.brimWidth} suffix="mm" step={1} min={0} max={20} onChange={(brimWidth) => patchSettings({ brimWidth })} />
                <NumberField label="Skirt loops" value={settings.skirtLoops} step={1} min={0} max={10} onChange={(skirtLoops) => patchSettings({ skirtLoops })} />
              </div>
            </details>

            <details open>
              <summary>Temperatures</summary>
              <div className="fieldGrid">
                <NumberField label="Nozzle" value={settings.nozzleTemp} suffix="C" step={5} min={150} max={300} onChange={(nozzleTemp) => patchSettings({ nozzleTemp })} />
                <NumberField label="First nozzle" value={settings.firstLayerNozzleTemp} suffix="C" step={5} min={150} max={300} onChange={(firstLayerNozzleTemp) => patchSettings({ firstLayerNozzleTemp })} />
                <NumberField label="Bed" value={settings.bedTemp} suffix="C" step={5} min={0} max={100} onChange={(bedTemp) => patchSettings({ bedTemp })} />
                <NumberField label="First bed" value={settings.firstLayerBedTemp} suffix="C" step={5} min={0} max={100} onChange={(firstLayerBedTemp) => patchSettings({ firstLayerBedTemp })} />
              </div>
            </details>

            <details>
              <summary>Speeds</summary>
              <div className="fieldGrid">
                <NumberField label="First layer" value={settings.speeds.firstLayer} suffix="mm/s" step={5} min={5} max={150} onChange={(firstLayer) => patchSpeeds({ firstLayer })} />
                <NumberField label="Outer wall" value={settings.speeds.outerWall} suffix="mm/s" step={5} min={10} max={500} onChange={(outerWall) => patchSpeeds({ outerWall })} />
                <NumberField label="Inner wall" value={settings.speeds.innerWall} suffix="mm/s" step={5} min={10} max={500} onChange={(innerWall) => patchSpeeds({ innerWall })} />
                <NumberField label="Infill" value={settings.speeds.infill} suffix="mm/s" step={5} min={10} max={500} onChange={(infill) => patchSpeeds({ infill })} />
                <NumberField label="Support" value={settings.speeds.support} suffix="mm/s" step={5} min={10} max={500} onChange={(support) => patchSpeeds({ support })} />
                <NumberField label="Travel" value={settings.speeds.travel} suffix="mm/s" step={10} min={20} max={600} onChange={(travel) => patchSpeeds({ travel })} />
              </div>
            </details>

            <details>
              <summary>Filament and nozzle</summary>
              <div className="fieldGrid">
                <NumberField label="Filament dia." value={settings.filamentDiameter} suffix="mm" step={0.01} min={1} max={3} onChange={(filamentDiameter) => patchSettings({ filamentDiameter })} />
                <NumberField label="Nozzle dia." value={settings.nozzleDiameter} suffix="mm" step={0.05} min={0.2} max={1.2} onChange={(nozzleDiameter) => patchSettings({ nozzleDiameter })} />
                <NumberField label="Flow" value={settings.flowRatio} step={0.01} min={0.5} max={1.5} onChange={(flowRatio) => patchSettings({ flowRatio })} />
              </div>
            </details>
          </section>

          <section className="panelSection">
            <div className="sectionTitle">
              <CircleHelp size={16} />
              <h2>Validation</h2>
            </div>
            <ValidationList items={[...settingsErrors, ...boundaryErrors, ...models.flatMap((model) => model.warnings.filter((warning) => warning.includes("Floating") || warning.includes("High mesh detail")).map((warning) => `${model.name}: ${warning}`))]} />
          </section>

          <section className="panelSection slicePanel">
            <div
              className={`sliceStateBanner ${isSlicing ? "running" : sliceResult ? "complete" : "pending"}`}
              role="status"
              aria-live="polite"
            >
              {isSlicing ? (
                <LoaderCircle className="spinIcon" size={22} />
              ) : sliceResult ? (
                <CheckCircle2 size={22} />
              ) : (
                <CircleHelp size={22} />
              )}
              <span>
                <strong>
                  {isSlicing
                    ? `Slicing ${slicePercent}%`
                    : sliceResult
                      ? "Slice complete"
                      : "Not sliced yet"}
                </strong>
                <small>
                  {isSlicing && sliceProgress
                    ? `${sliceProgress.message} | ${elapsedLabel} elapsed${slowProgressLabel}`
                    : sliceResult
                      ? `${numberFormatter.format(sliceResult.summary.layerCount)} layers generated. G-code is ready.`
                      : models.length > 0
                        ? "The current plate still needs to be sliced."
                        : "Upload a model before slicing."}
                </small>
                {isSlicing && sliceProgress && (
                  <progress className="sliceProgress" value={sliceProgress.percent} max={100} aria-label="Slicing progress" />
                )}
              </span>
            </div>
            <button className="sliceButton" type="button" disabled={!canSlice} onClick={() => void slicePlate()}>
              {isSlicing ? <LoaderCircle className="spinIcon" size={18} /> : <Scissors size={18} />}
              {isSlicing ? `Slicing ${slicePercent}%` : sliceResult ? "Slice again" : "Slice"}
            </button>
            <p className="inlineNotice">Slicing runs privately in this browser. No slicer installation or model upload is required.</p>
            {sliceError && <p className="errorNotice">{sliceError}</p>}

            <div className="estimateGrid">
              <Metric label="Pre-slice layers" value={roughEstimate.layers ? numberFormatter.format(roughEstimate.layers) : "n/a"} />
              <Metric label="Pre-slice filament" value={roughEstimate.filamentMm ? formatMetersFromMm(roughEstimate.filamentMm) : "n/a"} />
              <Metric label="Pre-slice time" value={roughEstimate.seconds ? formatDuration(roughEstimate.seconds) : "n/a"} />
            </div>

            {sliceResult && (
              <div ref={resultRef} className="resultBox" role="region" aria-label="Slice complete" tabIndex={-1}>
                <div className="resultHeader">
                  <span className="resultTitle">
                    <CheckCircle2 size={20} />
                    <strong>G-code ready</strong>
                  </span>
                  <a className="downloadButton" href={sliceResult.downloadUrl} download={sliceResult.filename}>
                    <Download size={16} />
                    Download G-code
                  </a>
                </div>
                <div className="estimateGrid">
                  <Metric label="Layers" value={numberFormatter.format(sliceResult.summary.layerCount)} />
                  <Metric label="Filament" value={formatMetersFromMm(sliceResult.summary.filamentMm)} />
                  <Metric label="PLA" value={formatGrams(sliceResult.summary.filamentG)} />
                  <Metric label="Time" value={formatDuration(sliceResult.summary.estimatedSeconds)} />
                </div>
                {sliceResult.summary.layers.length > 0 && (
                  <div className="layerPreviewBlock">
                    <div className="layerHeader">
                      <span>Layer {activeLayer + 1} / {sliceResult.summary.layers.length}</span>
                      <span>Z {sliceResult.summary.layers[activeLayer]?.z.toFixed(2)} mm</span>
                    </div>
                    <input
                      className="layerSlider"
                      type="range"
                      min={0}
                      max={Math.max(0, sliceResult.summary.layers.length - 1)}
                      value={activeLayer}
                      onChange={(event) => setActiveLayer(Number(event.target.value))}
                    />
                    <LayerPreview layers={sliceResult.summary.layers} activeLayer={activeLayer} />
                    {sliceResult.summary.sampled && <p className="inlineNotice">Toolpaths were downsampled for browser responsiveness.</p>}
                  </div>
                )}
              </div>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}

interface DropZoneProps {
  busy: string | null;
  onFiles: (files: FileList | null) => void | Promise<void>;
}

function DropZone({ busy, onFiles }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);

  return (
    <button
      className={`dropZone ${dragging ? "dragging" : ""}`}
      type="button"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void onFiles(event.dataTransfer.files);
      }}
      onClick={() => document.querySelector<HTMLInputElement>('input[type="file"]')?.click()}
    >
      <FileUp size={28} />
      <strong>{busy ?? "Upload STL first"}</strong>
      <span>STL primary, 3MF when geometry is readable</span>
    </button>
  );
}

interface IconButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function IconButton({ label, active, disabled, onClick, children }: IconButtonProps) {
  return (
    <button className={`iconButton ${active ? "active" : ""}`} type="button" disabled={disabled} onClick={onClick} title={label} aria-label={label}>
      {children}
    </button>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  suffix?: string;
  onChange: (value: number) => void;
}

function NumberField({ label, value, step, min, max, suffix, onChange }: NumberFieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="numberShell">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          max={max}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ValidationList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <div className="validBox">Ready for the K2 SE build volume.</div>;
  }

  return (
    <ul className="validationList">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default App;
