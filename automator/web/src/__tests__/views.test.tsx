import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@automator/shared';
import { Dashboard } from '../components/Dashboard';
import { SendPanel } from '../components/SendPanel';
import { KeywordsView } from '../components/Keywords';
import { ScriptsView } from '../components/Scripts';
import { LogView } from '../components/LogView';
import { appState, NOW, repeater } from './fixtures';

const state: AppState = appState({
  repeaters: [repeater()],
  rules: [
    {
      id: 'k1',
      name: 'Ping',
      enabled: true,
      pattern: 'ping',
      matchType: 'word',
      caseSensitive: false,
      scope: 'all',
      fromFilter: [],
      action: { type: 'reply', text: 'pong {{senderName}}' },
      cooldownSeconds: 0,
      stopProcessing: false,
      triggerCount: 4,
      lastTriggeredAt: NOW,
      createdAt: NOW,
    },
    {
      id: 'k2',
      name: 'Forward',
      enabled: false,
      pattern: '^help (.+)$',
      matchType: 'regex',
      caseSensitive: true,
      scope: 'groups',
      fromFilter: ['+1555'],
      action: { type: 'send', to: { kind: 'group', id: 'Z3JvdXAx' }, text: '{{1}}' },
      cooldownSeconds: 60,
      stopProcessing: true,
      triggerCount: 0,
      lastTriggeredAt: null,
      createdAt: NOW,
    },
  ],
  scripts: [
    { name: 'echo.js', enabled: true, loaded: true, error: null, commands: ['echo'], updatedAt: NOW },
    { name: 'broken.js', enabled: true, loaded: false, error: 'SyntaxError', commands: [], updatedAt: NOW },
  ],
  messages: [
    { id: 'a', direction: 'incoming', timestamp: NOW, peer: { kind: 'group', id: 'Z3JvdXAx' }, sender: '+15550001111', body: 'ping' },
    {
      id: 'b',
      direction: 'outgoing',
      timestamp: NOW,
      peer: { kind: 'contact', id: '+15550001111' },
      body: 'pong',
      origin: 'keyword',
      originRef: 'k1',
      ok: false,
      error: 'rate limited',
    },
  ],
  logs: [
    { timestamp: NOW, level: 'debug', source: 'transport', message: 'noise' },
    { timestamp: NOW, level: 'error', source: 'script:broken.js', message: 'kaput' },
  ],
});

describe('views render with a populated state', () => {
  afterEach(cleanup);

  it('dashboard', () => {
    render(<Dashboard state={state} />);
    expect(screen.getByText('Morning ping')).toBeTruthy();
  });

  it('send panel', () => {
    render(<SendPanel state={state} patch={() => {}} />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Contact or group'), { target: { value: 'contact:+15550001111' } });
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('keywords with form and tester', () => {
    render(<KeywordsView state={state} patch={() => {}} />);
    expect(screen.getByRole('button', { name: 'Move Ping up' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Send “\{\{1\}\}” to Family/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    expect((screen.getByLabelText('Pattern') as HTMLInputElement).value).toBe('^help (.+)$');
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Simulate incoming' })).toBeTruthy();
  });

  it('scripts', () => {
    render(<ScriptsView state={state} patch={() => {}} />);
    expect(screen.getByText('loaded')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('Scripting API cheat sheet')).toBeTruthy();
  });

  it('log with filters', () => {
    render(<LogView state={state} />);
    expect(screen.getByText('rate limited')).toBeTruthy();
    expect(screen.queryByText('noise')).toBeNull();
    fireEvent.change(screen.getByLabelText('Minimum level'), { target: { value: 'debug' } });
    expect(screen.getByText('noise')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'incoming' } });
    expect(screen.queryByText('rate limited')).toBeNull();
  });
});

