import { describe, expect, it } from 'vitest';
import { formatDuration, formatSeconds } from '../format';
import { fromSeconds, toSeconds } from '../interval';

describe('formatDuration', () => {
  it('formats hours with padded minutes and seconds', () => {
    expect(formatDuration((3600 + 2 * 60 + 5) * 1000)).toBe('1h 02m 05s');
  });
  it('formats days, minutes and seconds', () => {
    expect(formatDuration((2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000)).toBe('2d 03h 04m 05s');
    expect(formatDuration(249_000)).toBe('4m 09s');
    expect(formatDuration(7000)).toBe('7s');
  });
  it('rounds partial seconds up and clamps non-positive to 0s', () => {
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(59_001)).toBe('1m 00s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5000)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatSeconds', () => {
  it('drops zero parts', () => {
    expect(formatSeconds(5400)).toBe('1h 30m');
    expect(formatSeconds(45)).toBe('45s');
    expect(formatSeconds(172800)).toBe('2d');
    expect(formatSeconds(0)).toBe('0s');
  });
});

describe('interval unit conversion', () => {
  it('converts to seconds', () => {
    expect(toSeconds(5, 'seconds')).toBe(5);
    expect(toSeconds(2, 'minutes')).toBe(120);
    expect(toSeconds(1.5, 'hours')).toBe(5400);
    expect(toSeconds(1, 'days')).toBe(86400);
  });
  it('picks the largest exact unit', () => {
    expect(fromSeconds(86400 * 3)).toEqual({ value: 3, unit: 'days' });
    expect(fromSeconds(7200)).toEqual({ value: 2, unit: 'hours' });
    expect(fromSeconds(5400)).toEqual({ value: 90, unit: 'minutes' });
    expect(fromSeconds(90)).toEqual({ value: 90, unit: 'seconds' });
    expect(fromSeconds(30)).toEqual({ value: 30, unit: 'seconds' });
  });
  it('round-trips', () => {
    for (const s of [1, 59, 60, 61, 3600, 3661, 86400, 90000]) {
      const { value, unit } = fromSeconds(s);
      expect(toSeconds(value, unit)).toBe(s);
    }
  });
});
