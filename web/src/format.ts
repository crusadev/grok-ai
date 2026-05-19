/** Format a millisecond duration as a compact human string. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** A live elapsed timer value (seconds, one decimal). */
export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Clock time HH:MM:SS from an ISO timestamp. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB');
}

/** Short, human-friendly hostname for a source URL (drops `www.`). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
