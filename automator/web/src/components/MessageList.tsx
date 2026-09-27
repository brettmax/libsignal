import type { Contact, Group, SignalMessage } from '@automator/shared';
import { displayRecipient, displaySender } from '../displayRecipient';
import { formatDateTime } from '../format';

interface Props {
  messages: SignalMessage[];
  contacts: Contact[];
  groups: Group[];
  empty?: string;
}

/** Compact list of messages for the dashboard and send panel. */
export function MessageList({ messages, contacts, groups, empty = 'No messages yet.' }: Props) {
  if (messages.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="message-list">
      {messages.map((m) => {
        const peer = displayRecipient(m.peer, contacts, groups);
        const failed = m.direction === 'outgoing' && m.ok === false;
        return (
          <li key={m.id} className={`message ${m.direction}${failed ? ' failed' : ''}`}>
            <div className="message-meta">
              <span className={`badge dir-${m.direction}`}>{m.direction === 'incoming' ? 'In' : 'Out'}</span>
              <span className="message-peer">
                {m.direction === 'incoming'
                  ? m.peer.kind === 'group'
                    ? `${displaySender(m.sender, m.senderName, contacts)} in ${peer}`
                    : peer
                  : `to ${peer}`}
              </span>
              {m.origin && m.origin !== 'manual' && <span className="badge">{m.origin}</span>}
              {failed && <span className="badge tone-bad">failed</span>}
              <time className="message-time" dateTime={new Date(m.timestamp).toISOString()}>
                {formatDateTime(m.timestamp)}
              </time>
            </div>
            <p className="message-body">{m.body}</p>
            {failed && m.error && <p className="error-text small">{m.error}</p>}
          </li>
        );
      })}
    </ul>
  );
}
