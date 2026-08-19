export function formatMm(value: number, digits = 1): string {
  return `${value.toFixed(digits)} mm`;
}

export function formatGrams(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)} g`;
}

export function formatMetersFromMm(value: number): string {
  return `${(value / 1000).toFixed(2)} m`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "n/a";
  const rounded = Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
