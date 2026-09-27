import type { AppState, Repeater } from '@automator/shared';

export const NOW = new Date('2026-09-27T12:00:00Z').getTime();

export function repeater(over: Partial<Repeater> = {}): Repeater {
  return {
    id: 'r1',
    name: 'Morning ping',
    enabled: true,
    recipients: [{ kind: 'contact', id: '+15550001111' }],
    messages: ['Good morning!', 'Rise and shine'],
    intervalSeconds: 3600,
    jitterSeconds: 0,
    maxRuns: 10,
    runCount: 3,
    nextRunAt: NOW + 3_725_000,
    lastRunAt: NOW - 60_000,
    createdAt: NOW - 86_400_000,
    ...over,
  };
}

export function appState(over: Partial<AppState> = {}): AppState {
  return {
    status: { kind: 'mock', state: 'connected', account: '+15559990000', detail: null },
    contacts: [{ id: '+15550001111', number: '+15550001111', name: 'Alice' }],
    groups: [{ id: 'Z3JvdXAx', name: 'Family', memberCount: 4 }],
    repeaters: [],
    rules: [],
    scripts: [],
    messages: [],
    logs: [],
    ...over,
  };
}
