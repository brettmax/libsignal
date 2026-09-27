import { useState } from 'react';
import type { AppState, Recipient, SignalMessage } from '@automator/shared';
import { api, ApiRequestError, errorMessage } from '../api';
import type { StatePatch } from '../useLiveState';
import { RecipientPicker } from './RecipientPicker';
import { MessageList } from './MessageList';
import { recipientKey } from '../displayRecipient';
import { formatTime } from '../format';
import { useAction } from '../useAction';

interface Props {
  state: AppState;
  patch(fn: StatePatch): void;
}

type Result = { kind: 'sent'; message: SignalMessage; requested: string } | { kind: 'cancelled'; text: string } | { kind: 'error'; text: string };

export function SendPanel({ state, patch }: Props) {
  const [to, setTo] = useState<Recipient[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const refresh = useAction();

  const recipient = to[0];
  const canSend = !!recipient && body.trim().length > 0 && !sending;

  const send = async () => {
    if (!recipient || !body.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const message = await api.send({ to: recipient, body });
      patch((s) =>
        s.messages.some((m) => m.id === message.id) ? s : { ...s, messages: [message, ...s.messages].slice(0, 500) },
      );
      setResult({ kind: 'sent', message, requested: body });
      if (message.ok !== false) setBody('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setResult({ kind: 'cancelled', text: err.message });
      } else {
        setResult({ kind: 'error', text: errorMessage(err) });
      }
    } finally {
      setSending(false);
    }
  };

  const conversation = recipient
    ? state.messages.filter((m) => recipientKey(m.peer) === recipientKey(recipient)).slice(0, 10)
    : [];

  return (
    <div className="view">
      <h2 className="view-title">Send a message</h2>
      <form
        className="panel form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <RecipientPicker
          id="send-to"
          label="Recipient"
          value={to}
          onChange={setTo}
          contacts={state.contacts}
          groups={state.groups}
          multiple={false}
        />
        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={refresh.busy}
            onClick={() =>
              refresh.run(async () => {
                const res = await api.refreshContacts();
                patch((s) => ({ ...s, contacts: res.contacts, groups: res.groups }));
              })
            }
          >
            {refresh.busy ? 'Refreshing contacts…' : 'Refresh contacts'}
          </button>
          {refresh.error && <span className="error-text small">{refresh.error}</span>}
        </div>
        <div className="field">
          <label htmlFor="send-body">Message</label>
          <textarea
            id="send-body"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            aria-describedby="send-hint"
          />
          <p id="send-hint" className="hint">
            Ctrl+Enter to send. Outgoing script hooks may rewrite or cancel the message.
          </p>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!canSend}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        <div aria-live="polite" className="result-slot">
          {result?.kind === 'sent' &&
            (result.message.ok === false ? (
              <p className="notice tone-bad">Transport rejected the message: {result.message.error ?? 'unknown error'}</p>
            ) : (
              <p className="notice tone-ok">
                Sent at {formatTime(result.message.timestamp)}
                {result.message.body !== result.requested ? ` as “${result.message.body}”` : ''}.
              </p>
            ))}
          {result?.kind === 'cancelled' && (
            <p className="notice tone-warn">Cancelled by a script's outgoing hook ({result.text}). Nothing was sent.</p>
          )}
          {result?.kind === 'error' && <p className="notice tone-bad">Send failed: {result.text}</p>}
        </div>
      </form>

      {recipient && (
        <section className="panel" aria-labelledby="send-conv">
          <h3 id="send-conv">Recent in this conversation</h3>
          <MessageList messages={conversation} contacts={state.contacts} groups={state.groups} empty="No logged messages with this recipient." />
        </section>
      )}
    </div>
  );
}
