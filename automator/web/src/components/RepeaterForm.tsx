import { useState } from 'react';
import type { Contact, Group, Recipient, Repeater, RepeaterInput } from '@automator/shared';
import { RecipientPicker } from './RecipientPicker';
import { INTERVAL_UNITS, fromSeconds, toSeconds, type IntervalUnit } from '../interval';
import { errorMessage } from '../api';

interface Props {
  initial: Repeater | null;
  contacts: Contact[];
  groups: Group[];
  onSubmit(input: RepeaterInput): Promise<void>;
  onCancel(): void;
}

export function RepeaterForm({ initial, contacts, groups, onSubmit, onCancel }: Props) {
  const startInterval = fromSeconds(initial?.intervalSeconds ?? 3600);
  const [name, setName] = useState(initial?.name ?? '');
  const [recipients, setRecipients] = useState<Recipient[]>(initial?.recipients ?? []);
  const [messages, setMessages] = useState<string[]>(initial?.messages.length ? initial.messages : ['']);
  const [intervalValue, setIntervalValue] = useState(String(startInterval.value));
  const [unit, setUnit] = useState<IntervalUnit>(startInterval.unit);
  const [jitter, setJitter] = useState(String(initial?.jitterSeconds ?? 0));
  const [maxRuns, setMaxRuns] = useState(initial?.maxRuns == null ? '' : String(initial.maxRuns));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const validate = (): RepeaterInput | string => {
    if (!name.trim()) return 'Give the repeater a name.';
    if (recipients.length === 0) return 'Choose at least one recipient.';
    const msgs = messages.map((m) => m.trim()).filter(Boolean);
    if (msgs.length === 0) return 'Write at least one message.';
    const iv = Number(intervalValue);
    if (!Number.isFinite(iv) || iv <= 0) return 'The interval must be a positive number.';
    const intervalSeconds = toSeconds(iv, unit);
    if (intervalSeconds < 1) return 'The interval must be at least 1 second.';
    const j = jitter.trim() === '' ? 0 : Number(jitter);
    if (!Number.isInteger(j) || j < 0) return 'Jitter must be a whole number of seconds, 0 or more.';
    let mr: number | null = null;
    if (maxRuns.trim() !== '') {
      mr = Number(maxRuns);
      if (!Number.isInteger(mr) || mr < 1) return 'Max runs must be a whole number of 1 or more, or blank for forever.';
    }
    return { name: name.trim(), enabled, recipients, messages: msgs, intervalSeconds, jitterSeconds: j, maxRuns: mr };
  };

  const submit = async () => {
    const input = validate();
    if (typeof input === 'string') return setError(input);
    setError(null);
    setSaving(true);
    try {
      await onSubmit(input);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const setMessage = (i: number, text: string) => setMessages((ms) => ms.map((m, j) => (j === i ? text : m)));

  return (
    <form
      className="panel form"
      aria-labelledby="repeater-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id="repeater-form-title">{initial ? `Edit “${initial.name}”` : 'New repeater'}</h3>
      <div className="field">
        <label htmlFor="rep-name">Name</label>
        <input id="rep-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>

      <RecipientPicker id="rep-to" label="Recipients" value={recipients} onChange={setRecipients} contacts={contacts} groups={groups} />

      <fieldset className="messages-editor">
        <legend>Messages</legend>
        <p className="hint">Sent in rotation: the first run sends message 1, the next run message 2, and so on.</p>
        <ol>
          {messages.map((m, i) => (
            <li key={i} className="message-line">
              <label htmlFor={`rep-msg-${i}`} className="sr-only">
                Message {i + 1}
              </label>
              <textarea id={`rep-msg-${i}`} rows={2} value={m} onChange={(e) => setMessage(i, e.target.value)} />
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => setMessages((ms) => ms.filter((_, j) => j !== i))}
                disabled={messages.length <= 1}
                aria-label={`Remove message ${i + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-small" onClick={() => setMessages((ms) => [...ms, ''])}>
          Add message
        </button>
      </fieldset>

      <div className="field-row">
        <div className="field">
          <label htmlFor="rep-interval">Pause between sends</label>
          <div className="input-with-button">
            <input
              id="rep-interval"
              type="number"
              min={1}
              step="any"
              inputMode="decimal"
              value={intervalValue}
              onChange={(e) => setIntervalValue(e.target.value)}
            />
            <label htmlFor="rep-unit" className="sr-only">
              Interval unit
            </label>
            <select id="rep-unit" value={unit} onChange={(e) => setUnit(e.target.value as IntervalUnit)}>
              {INTERVAL_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="rep-jitter">Random extra (seconds)</label>
          <input
            id="rep-jitter"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={jitter}
            onChange={(e) => setJitter(e.target.value)}
            aria-describedby="rep-jitter-hint"
          />
          <p id="rep-jitter-hint" className="hint">
            Adds 0 to this many seconds to each pause.
          </p>
        </div>
        <div className="field">
          <label htmlFor="rep-max">Max runs</label>
          <input
            id="rep-max"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="forever"
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
            aria-describedby="rep-max-hint"
          />
          <p id="rep-max-hint" className="hint">
            Blank = repeat forever.
          </p>
        </div>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled (start the countdown now)
      </label>

      {error && (
        <p className="notice tone-bad" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create repeater'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
