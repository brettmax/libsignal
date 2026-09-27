import { useState } from 'react';
import type { AppState, Repeater, RepeaterInput } from '@automator/shared';
import { api } from '../api';
import type { StatePatch } from '../useLiveState';
import { Countdown } from './Countdown';
import { RepeaterForm } from './RepeaterForm';
import { displayRecipient } from '../displayRecipient';
import { formatDateTime, formatSeconds } from '../format';
import { useAction } from '../useAction';

interface Props {
  state: AppState;
  patch(fn: StatePatch): void;
}

const upsert = (list: Repeater[], r: Repeater) =>
  list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r];

export function formatRuns(r: Pick<Repeater, 'runCount' | 'maxRuns'>): string {
  return `${r.runCount} / ${r.maxRuns ?? '∞'}`;
}

export function RepeatersView({ state, patch }: Props) {
  const [editing, setEditing] = useState<Repeater | 'new' | null>(null);
  const action = useAction();

  const save = async (input: RepeaterInput) => {
    const saved = editing && editing !== 'new' ? await api.updateRepeater(editing.id, input) : await api.createRepeater(input);
    patch((s) => ({ ...s, repeaters: upsert(s.repeaters, saved) }));
    setEditing(null);
  };

  const update = (r: Repeater, change: Partial<RepeaterInput>) =>
    action.run(async () => {
      const saved = await api.updateRepeater(r.id, change);
      patch((s) => ({ ...s, repeaters: upsert(s.repeaters, saved) }));
    });

  const runNow = (r: Repeater) =>
    action.run(async () => {
      const saved = await api.runRepeater(r.id);
      patch((s) => ({ ...s, repeaters: upsert(s.repeaters, saved) }));
    });

  const remove = (r: Repeater) => {
    if (!window.confirm(`Delete repeater “${r.name}”? This cannot be undone.`)) return;
    void action.run(async () => {
      await api.deleteRepeater(r.id);
      patch((s) => ({ ...s, repeaters: s.repeaters.filter((x) => x.id !== r.id) }));
      if (editing !== 'new' && editing?.id === r.id) setEditing(null);
    });
  };

  return (
    <div className="view">
      <div className="view-head">
        <h2 className="view-title">Repeaters</h2>
        {editing === null && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            New repeater
          </button>
        )}
      </div>
      <p className="muted view-intro">
        Send a message (or a rotation of messages) over and over, with a countdown pause between sends.
      </p>

      {editing !== null && (
        <RepeaterForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          contacts={state.contacts}
          groups={state.groups}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {action.error && (
        <p className="notice tone-bad" role="alert">
          {action.error}
        </p>
      )}

      {state.repeaters.length === 0 ? (
        <div className="panel empty-state">
          <p>No repeaters yet.</p>
        </div>
      ) : (
        <ul className="card-list" aria-label="Repeaters">
          {state.repeaters.map((r) => {
            const finished = r.maxRuns !== null && r.runCount >= r.maxRuns;
            return (
              <li key={r.id} className={`card panel${r.enabled ? '' : ' is-disabled'}`}>
                <div className="card-head">
                  <h3 className="card-title">{r.name}</h3>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={action.busy}
                      onChange={(e) => void update(r, { enabled: e.target.checked })}
                    />
                    <span className="switch-track" aria-hidden="true" />
                    <span className="switch-label">
                      Enabled<span className="sr-only"> ({r.name})</span>
                    </span>
                  </label>
                </div>
                <dl className="facts">
                  <div>
                    <dt>Next send</dt>
                    <dd>
                      <Countdown target={r.enabled ? r.nextRunAt : null} idleLabel={finished ? 'Finished' : 'Paused'} dueLabel="sending…" />
                    </dd>
                  </div>
                  <div>
                    <dt>Every</dt>
                    <dd>
                      {formatSeconds(r.intervalSeconds)}
                      {r.jitterSeconds > 0 && <span className="muted"> + up to {formatSeconds(r.jitterSeconds)}</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Runs</dt>
                    <dd className="num">{formatRuns(r)}</dd>
                  </div>
                  <div>
                    <dt>Last sent</dt>
                    <dd>{r.lastRunAt ? formatDateTime(r.lastRunAt) : 'never'}</dd>
                  </div>
                </dl>
                <p className="card-line">
                  <span className="muted">To </span>
                  {r.recipients.length
                    ? r.recipients.map((x) => displayRecipient(x, state.contacts, state.groups)).join(', ')
                    : 'nobody'}
                </p>
                <p className="card-line quote">
                  {r.messages[r.runCount % Math.max(1, r.messages.length)] ?? ''}
                  {r.messages.length > 1 && <span className="muted small"> (next of {r.messages.length} in rotation)</span>}
                </p>
                <div className="card-actions">
                  <button type="button" className="btn" disabled={action.busy} onClick={() => void runNow(r)}>
                    Run now
                  </button>
                  <button type="button" className="btn" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => remove(r)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
