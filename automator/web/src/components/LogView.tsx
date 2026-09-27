import { useMemo, useState } from 'react';
import type { AppState, LogEntry } from '@automator/shared';
import { displayRecipient, displaySender } from '../displayRecipient';
import { formatDateTime } from '../format';

const LEVELS: LogEntry['level'][] = ['debug', 'info', 'warn', 'error'];

export function LogView({ state }: { state: AppState }) {
  const [direction, setDirection] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [text, setText] = useState('');
  const [minLevel, setMinLevel] = useState<LogEntry['level']>('info');
  const [logText, setLogText] = useState('');

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return state.messages
      .filter((m) => direction === 'all' || m.direction === direction)
      .map((m) => ({
        m,
        peer: displayRecipient(m.peer, state.contacts, state.groups),
        sender: m.direction === 'incoming' ? displaySender(m.sender, m.senderName, state.contacts) : '',
      }))
      .filter(({ m, peer, sender }) =>
        !q ? true : [m.body, peer, sender, m.sender ?? '', m.origin ?? '', m.error ?? ''].some((s) => s.toLowerCase().includes(q)),
      );
  }, [state.messages, state.contacts, state.groups, direction, text]);

  const logs = useMemo(() => {
    const min = LEVELS.indexOf(minLevel);
    const q = logText.trim().toLowerCase();
    return state.logs.filter(
      (l) => LEVELS.indexOf(l.level) >= min && (!q || l.message.toLowerCase().includes(q) || l.source.toLowerCase().includes(q)),
    );
  }, [state.logs, minLevel, logText]);

  return (
    <div className="view">
      <h2 className="view-title">Log</h2>

      <section className="panel" aria-labelledby="log-messages">
        <div className="panel-head">
          <h3 id="log-messages">Messages</h3>
          <span className="muted small">
            {rows.length} of {state.messages.length}
          </span>
        </div>
        <div className="filters">
          <div className="field">
            <label htmlFor="msg-dir">Direction</label>
            <select id="msg-dir" value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
              <option value="all">All</option>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="msg-q">Search</label>
            <input id="msg-q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Text, contact, origin…" />
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Dir</th>
                <th scope="col">Conversation</th>
                <th scope="col">Sender</th>
                <th scope="col">Message</th>
                <th scope="col">Origin</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No messages.
                  </td>
                </tr>
              ) : (
                rows.map(({ m, peer, sender }) => (
                  <tr key={m.id}>
                    <td className="nowrap">
                      <time dateTime={new Date(m.timestamp).toISOString()}>{formatDateTime(m.timestamp)}</time>
                    </td>
                    <td>
                      <span className={`badge dir-${m.direction}`}>{m.direction === 'incoming' ? 'In' : 'Out'}</span>
                    </td>
                    <td>
                      {m.peer.kind === 'group' && <span className="sr-only">Group </span>}
                      {peer}
                    </td>
                    <td>{sender}</td>
                    <td className="cell-body">{m.body}</td>
                    <td>
                      {m.origin ?? ''}
                      {m.originRef && <span className="muted small"> {m.originRef}</span>}
                    </td>
                    <td>
                      {m.direction === 'outgoing' &&
                        (m.ok === false ? (
                          <span className="badge tone-bad" title={m.error}>
                            error
                          </span>
                        ) : (
                          <span className="badge tone-ok">ok</span>
                        ))}
                      {m.ok === false && m.error && <div className="error-text small">{m.error}</div>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="log-system">
        <div className="panel-head">
          <h3 id="log-system">System log</h3>
          <span className="muted small">
            {logs.length} of {state.logs.length}
          </span>
        </div>
        <div className="filters">
          <div className="field">
            <label htmlFor="log-level">Minimum level</label>
            <select id="log-level" value={minLevel} onChange={(e) => setMinLevel(e.target.value as LogEntry['level'])}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="log-q">Search</label>
            <input id="log-q" type="search" value={logText} onChange={(e) => setLogText(e.target.value)} placeholder="Message or source…" />
          </div>
        </div>
        {logs.length === 0 ? (
          <p className="muted">No log entries.</p>
        ) : (
          <ul className="log-list">
            {logs.map((l, i) => (
              <li key={`${l.timestamp}-${i}`} className={`log-entry level-${l.level}`}>
                <time dateTime={new Date(l.timestamp).toISOString()}>{formatDateTime(l.timestamp)}</time>
                <span className={`badge level-${l.level}`}>{l.level}</span>
                <span className="log-source mono">{l.source}</span>
                <span className="log-message">{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
