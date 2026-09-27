import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { RepeatersView } from '../components/Repeaters';
import { appState, NOW, repeater } from './fixtures';

describe('RepeatersView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const state = appState({
    repeaters: [
      repeater(),
      repeater({
        id: 'r2',
        name: 'Group reminder',
        enabled: false,
        recipients: [{ kind: 'group', id: 'Z3JvdXAx' }],
        messages: ['Standup!'],
        intervalSeconds: 5400,
        maxRuns: null,
        runCount: 7,
        nextRunAt: null,
      }),
    ],
  });

  it('renders each repeater with recipients, runs, interval and a live countdown', () => {
    render(<RepeatersView state={state} patch={() => {}} />);
    const list = screen.getByRole('list', { name: 'Repeaters' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);

    const first = items[0]!;
    expect(within(first).getByRole('heading', { name: 'Morning ping' })).toBeTruthy();
    expect(first.textContent).toContain('Alice');
    expect(first.textContent).toContain('3 / 10');
    expect(first.textContent).toContain('1h');
    expect(within(first).getByRole('timer').textContent).toBe('1h 02m 05s');
    // Rotation: runCount 3 of 2 messages -> index 1.
    expect(first.textContent).toContain('Rise and shine');
    expect((within(first).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    for (const name of ['Run now', 'Edit', 'Delete']) expect(within(first).getByRole('button', { name })).toBeTruthy();

    const second = items[1]!;
    expect(second.textContent).toContain('Family');
    expect(second.textContent).toContain('7 / ∞');
    expect(second.textContent).toContain('1h 30m');
    expect(second.textContent).toContain('Paused');
    expect((within(second).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(within(first).getByRole('timer').textContent).toBe('1h 02m 03s');
  });

  it('shows an empty state without repeaters', () => {
    render(<RepeatersView state={appState()} patch={() => {}} />);
    expect(screen.getByText('No repeaters yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New repeater' })).toBeTruthy();
  });
});
