export type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export const UNIT_SECONDS: Record<IntervalUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

export const INTERVAL_UNITS: IntervalUnit[] = ['seconds', 'minutes', 'hours', 'days'];

/** Converts a value in the given unit to whole seconds. */
export function toSeconds(value: number, unit: IntervalUnit): number {
  return Math.round(value * UNIT_SECONDS[unit]);
}

/** Picks the largest unit that represents the seconds exactly (e.g. 7200 -> 2 hours, 90 -> 90 seconds). */
export function fromSeconds(seconds: number): { value: number; unit: IntervalUnit } {
  const s = Math.max(0, Math.round(seconds));
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    const size = UNIT_SECONDS[unit];
    if (s >= size && s % size === 0) return { value: s / size, unit };
  }
  return { value: s, unit: 'seconds' };
}
