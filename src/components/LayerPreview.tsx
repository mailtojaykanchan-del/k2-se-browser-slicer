import { useEffect, useRef } from "react";
import { K2_SE_PROFILE } from "../../shared/profile";

export interface LayerPreviewSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LayerPreviewLayer {
  z: number;
  segmentCount: number;
  extrusionMm: number;
  segments: LayerPreviewSegment[];
}

interface LayerPreviewProps {
  layers: LayerPreviewLayer[];
  activeLayer: number;
}

export function LayerPreview({ layers, activeLayer }: LayerPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layer = layers[activeLayer];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const width = Math.max(320, parent?.clientWidth ?? 320);
    const height = Math.round(width * (K2_SE_PROFILE.buildVolume.y / K2_SE_PROFILE.buildVolume.x));
    const dpr = Math.min(window.devicePixelRatio, 2);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, width, height);

    const mapX = (x: number) => (x / K2_SE_PROFILE.buildVolume.x) * width;
    const mapY = (y: number) => height - (y / K2_SE_PROFILE.buildVolume.y) * height;

    ctx.strokeStyle = "#d7dde4";
    ctx.lineWidth = 1;
    for (let x = 0; x <= K2_SE_PROFILE.buildVolume.x; x += 20) {
      ctx.beginPath();
      ctx.moveTo(mapX(x), 0);
      ctx.lineTo(mapX(x), height);
      ctx.stroke();
    }
    for (let y = 0; y <= K2_SE_PROFILE.buildVolume.y; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, mapY(y));
      ctx.lineTo(width, mapY(y));
      ctx.stroke();
    }

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, width - 2, height - 2);

    if (!layer) return;

    ctx.strokeStyle = "#ef6c22";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const segment of layer.segments) {
      ctx.moveTo(mapX(segment.x1), mapY(segment.y1));
      ctx.lineTo(mapX(segment.x2), mapY(segment.y2));
    }
    ctx.stroke();
  }, [activeLayer, layer]);

  return (
    <div className="layerCanvasWrap">
      <canvas ref={canvasRef} aria-label="Layer toolpath preview" />
    </div>
  );
}
