const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Countdown-style duration: "1h 02m 05s", "2d 03h 04m 05s", "4m 09s", "7s".
 * Rounds up to whole seconds so a countdown never shows 0s while time remains.
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Compact human duration without zero parts, for intervals: "1h 30m", "45s", "2d". */
export function formatSeconds(seconds: number): string {
  let rest = Math.max(0, Math.round(seconds));
  if (rest === 0) return '0s';
  const parts: string[] = [];
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(' ');
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Time only for today, date + time otherwise. */
export function formatDateTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return formatTime(ms);
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatTime(ms)}`;
}
