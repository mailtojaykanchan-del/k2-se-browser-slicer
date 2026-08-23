import { ArrowRight, FileCog } from "lucide-react";

type ConversionSource = "cad" | "stl" | "3mf";
type ConversionOutput = "stl" | "3mf";

interface ConverterPanelProps {
  selectedCadName: string | null;
  converting: boolean;
  notice: string | null;
  onConvert: (source: ConversionSource, output: ConversionOutput) => void;
}

const CONVERSIONS: Array<{ source: ConversionSource; output: ConversionOutput }> = [
  { source: "cad", output: "stl" },
  { source: "cad", output: "3mf" },
  { source: "3mf", output: "stl" },
  { source: "stl", output: "3mf" },
];

export function ConverterPanel({ selectedCadName, converting, notice, onConvert }: ConverterPanelProps) {
  return (
    <section className="converterPanel" aria-label="File converter">
      <div className="sectionTitle">
        <FileCog size={17} />
        <h2>File Converter</h2>
        <span>local</span>
      </div>

      {selectedCadName && <div className="converterSelection">{selectedCadName}</div>}

      <div className="converterGrid">
        {CONVERSIONS.map(({ source, output }) => {
          const disabled = converting || (source === "cad" && !selectedCadName);
          const sourceLabel = source.toUpperCase();
          const outputLabel = output.toUpperCase();
          return (
            <button
              key={`${source}-${output}`}
              type="button"
              disabled={disabled}
              onClick={() => onConvert(source, output)}
              aria-label={`Convert ${sourceLabel} to ${outputLabel}`}
            >
              <strong>{sourceLabel}</strong>
              <ArrowRight size={17} />
              <strong>{outputLabel}</strong>
            </button>
          );
        })}
      </div>

      {notice && <p className="conversionNotice" role="status">{notice}</p>}
    </section>
  );
}
