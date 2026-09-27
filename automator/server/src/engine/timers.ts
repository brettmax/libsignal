/** Largest delay setTimeout accepts without overflowing (about 24.8 days). */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * setTimeout that supports delays longer than 2^31-1 ms by chaining
 * shorter timeouts. Only one underlying timer is pending at any time.
 * Returns a cancel function.
 */
export function setLongTimeout(fn: () => void, delayMs: number): () => void {
  let remaining = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const arm = (): void => {
    const chunk = Math.min(remaining, MAX_TIMEOUT_MS);
    handle = setTimeout(() => {
      handle = null;
      if (cancelled) return;
      remaining -= chunk;
      if (remaining > 0) arm();
      else fn();
    }, chunk);
  };
  arm();
  return () => {
    cancelled = true;
    if (handle) clearTimeout(handle);
    handle = null;
  };
}
