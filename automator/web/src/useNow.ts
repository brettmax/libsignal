import { useEffect, useState } from 'react';

/** Current time, re-rendering every `intervalMs` (aligned to the next whole second). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(
      () => {
        setNow(Date.now());
        interval = setInterval(() => setNow(Date.now()), intervalMs);
      },
      intervalMs - (Date.now() % intervalMs),
    );
    return () => {
      clearTimeout(align);
      clearInterval(interval);
    };
  }, [intervalMs]);
  return now;
}
