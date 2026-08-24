import { Bot, Box, BrainCircuit, LoaderCircle, Sparkles } from "lucide-react";
import { useState } from "react";

interface AiCadPanelProps {
  busy: boolean;
  status: string;
  statusKind: "ready" | "working" | "success" | "error";
  onGenerate: (prompt: string) => void;
}

export function AiCadPanel({ busy, status, statusKind, onGenerate }: AiCadPanelProps) {
  const [prompt, setPrompt] = useState("");

  return (
    <section className="aiCadPanel" aria-label="AI CAD">
      <div className="sectionTitle">
        <BrainCircuit size={17} />
        <h2>AI CAD</h2>
        <span>local</span>
      </div>

      <div className={`aiModelStatus ${statusKind}`} role={statusKind === "error" ? "alert" : "status"}>
        {busy ? <LoaderCircle size={18} className="spinIcon" /> : <Bot size={18} />}
        <span>
          <strong>{statusKind === "working" ? "Generating real 3D model" : statusKind === "success" ? "New AI model ready" : statusKind === "error" ? "Generation failed" : "AI CAD ready"}</strong>
          <small>{status}</small>
        </span>
      </div>

      <label className="aiPromptField">
        <span>Describe a printable part</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A 40 x 30 x 10 mm box"
          rows={5}
        />
      </label>

      <button className="aiGenerateButton" type="button" disabled={busy || prompt.trim().length < 3} onClick={() => onGenerate(prompt.trim())}>
        {busy ? <LoaderCircle size={18} className="spinIcon" /> : <Sparkles size={18} />}
        {busy ? "Generating..." : "Generate CAD"}
      </button>

      <div className="aiCapabilityRow">
        <Box size={15} />
        <span>Box</span>
        <span>Cylinder</span>
        <span>Sphere</span>
        <span>Cone</span>
        <span>Tube</span>
        <span>Basketball</span>
        <span>Airless ball</span>
        <span>Nameplate</span>
      </div>
      <small className="aiCloudNotice">Detailed objects use three.ws text-to-3D through Puter and may take several minutes. Generated GLB files are public, and both services process request data. Puter may request sign-in; no developer API key is required.</small>
    </section>
  );
}
