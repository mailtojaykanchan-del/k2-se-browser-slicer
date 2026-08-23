import { Bot, Box, BrainCircuit, LoaderCircle, Sparkles } from "lucide-react";
import { useState } from "react";

interface AiCadPanelProps {
  modelLoaded: boolean;
  busy: boolean;
  status: string;
  onLoadModel: () => void;
  onGenerate: (prompt: string) => void;
}

export function AiCadPanel({ modelLoaded, busy, status, onLoadModel, onGenerate }: AiCadPanelProps) {
  const [prompt, setPrompt] = useState("");

  return (
    <section className="aiCadPanel" aria-label="AI CAD">
      <div className="sectionTitle">
        <BrainCircuit size={17} />
        <h2>AI CAD</h2>
        <span>local</span>
      </div>

      <div className={`aiModelStatus ${modelLoaded ? "ready" : ""}`}>
        <Bot size={18} />
        <span>
          <strong>{modelLoaded ? "Gemma ready" : "Gemma 3 1B"}</strong>
          <small>{status}</small>
        </span>
      </div>

      <button className="aiLoadButton" type="button" disabled={modelLoaded || busy} onClick={onLoadModel}>
        {busy && !modelLoaded ? <LoaderCircle size={17} className="spin" /> : <BrainCircuit size={17} />}
        {modelLoaded ? "Model loaded" : "Load Gemma"}
      </button>

      <label className="aiPromptField">
        <span>Describe a printable part</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A 40 x 30 x 10 mm box"
          rows={5}
        />
      </label>

      <button className="aiGenerateButton" type="button" disabled={!modelLoaded || busy || prompt.trim().length < 3} onClick={() => onGenerate(prompt.trim())}>
        {busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
        {modelLoaded ? "Generate CAD" : "Load Gemma first"}
      </button>

      <div className="aiCapabilityRow">
        <Box size={15} />
        <span>Box</span>
        <span>Cylinder</span>
        <span>Sphere</span>
        <span>Cone</span>
        <span>Tube</span>
      </div>
    </section>
  );
}
