import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AppState, ServerEvent } from '@automator/shared';

export const MESSAGE_CAP = 500;
export const LOG_CAP = 200;

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * Pure reducer: applies one ServerEvent to the current state.
 * Before the first snapshot there is nothing to patch, so non-snapshot events are ignored.
 */
export function applyEvent(state: AppState | null, event: ServerEvent): AppState | null {
  if (event.type === 'snapshot') return event.state;
  if (!state) return state;
  switch (event.type) {
    case 'status':
      return { ...state, status: event.status };
    case 'message': {
      const idx = state.messages.findIndex((m) => m.id === event.message.id);
      if (idx >= 0) {
        const messages = state.messages.slice();
        messages[idx] = event.message;
        return { ...state, messages };
      }
      return { ...state, messages: [event.message, ...state.messages].slice(0, MESSAGE_CAP) };
    }
    case 'log':
      return { ...state, logs: [event.entry, ...state.logs].slice(0, LOG_CAP) };
    case 'repeaters':
      return { ...state, repeaters: event.repeaters };
    case 'rules':
      return { ...state, rules: event.rules };
    case 'scripts':
      return { ...state, scripts: event.scripts };
    case 'contacts':
      return { ...state, contacts: event.contacts, groups: event.groups };
    default:
      return state;
  }
}

/** Local optimistic patch applied on top of the live state (e.g. with a REST response). */
export type StatePatch = (state: AppState) => AppState;

type Action = { kind: 'event'; event: ServerEvent } | { kind: 'patch'; patch: StatePatch };

function reducer(state: AppState | null, action: Action): AppState | null {
  if (action.kind === 'event') return applyEvent(state, action.event);
  return state ? action.patch(state) : state;
}

/** Reconnect delay for the given (0-based) retry number: 1s, 2s, 4s ... capped at 30s. */
export function backoffDelay(retry: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, retry));
}

export function defaultWsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export interface LiveState {
  state: AppState | null;
  connection: ConnectionState;
  /** When the next reconnect attempt happens (ms epoch), while closed. */
  retryAt: number | null;
  /** Reconnect immediately. */
  reconnect(): void;
  /** Apply a local change (optimistic update from a REST response). */
  patch(fn: StatePatch): void;
}

export function useLiveState(url?: string): LiveState {
  const [state, dispatch] = useReducer(reducer, null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    const target = url ?? defaultWsUrl();
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let disposed = false;

    const connect = () => {
      clearTimeout(timer);
      if (disposed) return;
      setConnection('connecting');
      setRetryAt(null);
      const socket = new WebSocket(target);
      ws = socket;
      socket.onopen = () => {
        retries = 0;
        setConnection('open');
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        try {
          dispatch({ kind: 'event', event: JSON.parse(ev.data) as ServerEvent });
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (disposed || ws !== socket) return;
        const delay = backoffDelay(retries++);
        setConnection('closed');
        setRetryAt(Date.now() + delay);
        timer = setTimeout(connect, delay);
      };
    };

    reconnectRef.current = () => {
      retries = 0;
      const old = ws;
      ws = null;
      old?.close();
      connect();
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [url]);

  const reconnect = useCallback(() => reconnectRef.current(), []);
  const patch = useCallback((fn: StatePatch) => dispatch({ kind: 'patch', patch: fn }), []);

  return { state, connection, retryAt, reconnect, patch };
}
