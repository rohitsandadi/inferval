export function shortSha(sha?: string | null): string {
  if (!sha) return "—";
  return looksLikeSha(sha) && sha.length > 8 ? sha.slice(0, 8) : sha;
}

// Refs may be branch names; only hex strings are SHAs worth truncating.
export function looksLikeSha(ref?: string | null): boolean {
  return !!ref && /^[0-9a-f]{7,40}$/i.test(ref);
}

export function fmtDelta(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return `$${usd.toFixed(2)}`;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  });
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 45_000) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    tokens_per_s: "tokens/s",
    latency_ms_p95: "p95 latency",
    latency_ms_median: "median latency",
    peak_vram_mb: "peak VRAM",
    output_equivalence: "output equivalence",
  };
  return labels[metric] ?? metric;
}
