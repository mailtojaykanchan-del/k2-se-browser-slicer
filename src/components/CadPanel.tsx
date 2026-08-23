import {
  ArrowRight,
  Box,
  Circle,
  CircleDot,
  Cone,
  Cylinder,
  Download,
  FileCog,
  Plus,
  RefreshCw,
  Shapes,
} from "lucide-react";
import type { CadDefinition, CadPrimitiveKind, CameraView } from "../scene/SlicerScene";

const SHAPES: Array<{ kind: CadPrimitiveKind; label: string; icon: React.ReactNode }> = [
  { kind: "box", label: "Box", icon: <Box size={20} /> },
  { kind: "cylinder", label: "Cylinder", icon: <Cylinder size={20} /> },
  { kind: "sphere", label: "Sphere", icon: <Circle size={20} /> },
  { kind: "cone", label: "Cone", icon: <Cone size={20} /> },
  { kind: "tube", label: "Tube", icon: <CircleDot size={20} /> },
];

export function defaultCadDefinition(kind: CadPrimitiveKind): CadDefinition {
  const common = {
    kind,
    width: 30,
    depth: 30,
    height: 20,
    diameter: 30,
    topDiameter: 0,
    innerDiameter: 18,
  };

  if (kind === "cylinder") return { ...common, height: 25 };
  if (kind === "sphere") return { ...common, height: 30 };
  if (kind === "cone") return { ...common, diameter: 35, height: 30 };
  if (kind === "tube") return { ...common, diameter: 36, innerDiameter: 22 };
  return common;
}

interface CadPanelProps {
  definition: CadDefinition;
  selectedIsCad: boolean;
  error: string | null;
  onChange: (definition: CadDefinition) => void;
  onAdd: () => void;
  onApply: () => void;
  onDownload: () => void;
  onView: (view: CameraView) => void;
  onConvert: (source: "cad" | "stl" | "3mf", output: "stl" | "3mf") => void;
  converting: boolean;
  conversionNotice: string | null;
}

export function CadPanel({
  definition,
  selectedIsCad,
  error,
  onChange,
  onAdd,
  onApply,
  onDownload,
  onView,
  onConvert,
  converting,
  conversionNotice,
}: CadPanelProps) {
  const patch = (next: Partial<CadDefinition>) => onChange({ ...definition, ...next });

  return (
    <section className="cadPanel" aria-label="CAD tools">
      <div className="sectionTitle">
        <Shapes size={16} />
        <h2>CAD Shapes</h2>
        <span>mm</span>
      </div>

      <div className="cadShapeGrid" role="list" aria-label="Primitive shape">
        {SHAPES.map((shape) => (
          <button
            key={shape.kind}
            className={definition.kind === shape.kind ? "selected" : ""}
            type="button"
            onClick={() => onChange(defaultCadDefinition(shape.kind))}
            aria-pressed={definition.kind === shape.kind}
          >
            {shape.icon}
            <span>{shape.label}</span>
          </button>
        ))}
      </div>

      <div className="cadDimensionGrid">
        {definition.kind === "box" && (
          <>
            <CadNumberField label="Width" value={definition.width} max={440} onChange={(width) => patch({ width })} />
            <CadNumberField label="Depth" value={definition.depth} max={430} onChange={(depth) => patch({ depth })} />
            <CadNumberField label="Height" value={definition.height} max={490} onChange={(height) => patch({ height })} />
          </>
        )}
        {(definition.kind === "cylinder" || definition.kind === "sphere" || definition.kind === "cone" || definition.kind === "tube") && (
          <CadNumberField label={definition.kind === "tube" ? "Outer dia." : "Diameter"} value={definition.diameter} max={440} onChange={(diameter) => patch({ diameter })} />
        )}
        {definition.kind === "cone" && (
          <CadNumberField label="Top dia." value={definition.topDiameter} min={0} max={440} onChange={(topDiameter) => patch({ topDiameter })} />
        )}
        {definition.kind === "tube" && (
          <CadNumberField label="Inner dia." value={definition.innerDiameter} max={439} onChange={(innerDiameter) => patch({ innerDiameter })} />
        )}
        {definition.kind !== "sphere" && definition.kind !== "box" && (
          <CadNumberField label="Height" value={definition.height} max={490} onChange={(height) => patch({ height })} />
        )}
      </div>

      {error && <p className="cadError" role="alert">{error}</p>}

      <div className="cadActions">
        <button className="cadPrimaryAction" type="button" disabled={Boolean(error)} onClick={onAdd}>
          <Plus size={17} />
          Add part
        </button>
        <button type="button" disabled={!selectedIsCad || Boolean(error)} onClick={onApply}>
          <RefreshCw size={17} />
          Apply size
        </button>
        <button type="button" disabled={!selectedIsCad} onClick={onDownload}>
          <Download size={17} />
          STL
        </button>
      </div>

      <div className="cadViews" role="group" aria-label="Camera view">
        {(["iso", "top", "front", "right"] as CameraView[]).map((view) => (
          <button key={view} type="button" onClick={() => onView(view)}>{view}</button>
        ))}
      </div>

      <div className="cadConverter">
        <div className="sectionTitle">
          <FileCog size={16} />
          <h2>File Converter</h2>
          <span>local</span>
        </div>
        <div className="converterGrid">
          <ConvertButton source="CAD" output="STL" disabled={!selectedIsCad || converting} onClick={() => onConvert("cad", "stl")} />
          <ConvertButton source="CAD" output="3MF" disabled={!selectedIsCad || converting} onClick={() => onConvert("cad", "3mf")} />
          <ConvertButton source="3MF" output="STL" disabled={converting} onClick={() => onConvert("3mf", "stl")} />
          <ConvertButton source="STL" output="3MF" disabled={converting} onClick={() => onConvert("stl", "3mf")} />
        </div>
        {conversionNotice && <p className="conversionNotice" role="status">{conversionNotice}</p>}
      </div>
    </section>
  );
}

function ConvertButton({ source, output, disabled, onClick }: { source: string; output: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={`Convert ${source} to ${output}`}>
      <strong>{source}</strong>
      <ArrowRight size={14} />
      <strong>{output}</strong>
    </button>
  );
}

interface CadNumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
}

function CadNumberField({ label, value, min = 0.5, max, onChange }: CadNumberFieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="numberShell">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={1}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <em>mm</em>
      </div>
    </label>
  );
}
