import { useState } from 'react';
import type { AppState, KeywordRule, KeywordRuleInput } from '@automator/shared';
import { api } from '../api';
import type { StatePatch } from '../useLiveState';
import { RuleForm } from './RuleForm';
import { RuleTester } from './RuleTester';
import { displayRecipient } from '../displayRecipient';
import { formatDateTime, formatSeconds } from '../format';
import { useAction } from '../useAction';

interface Props {
  state: AppState;
  patch(fn: StatePatch): void;
}

const MATCH_LABEL: Record<KeywordRule['matchType'], string> = {
  contains: 'contains',
  exact: 'is exactly',
  startsWith: 'starts with',
  regex: 'matches regex',
  word: 'has word',
};

const SCOPE_LABEL: Record<KeywordRule['scope'], string> = {
  all: 'all chats',
  direct: 'direct chats',
  groups: 'groups',
};

const upsert = (list: KeywordRule[], r: KeywordRule) =>
  list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r];

export function KeywordsView({ state, patch }: Props) {
  const [editing, setEditing] = useState<KeywordRule | 'new' | null>(null);
  const action = useAction();
  const rules = state.rules;

  const save = async (input: KeywordRuleInput) => {
    const saved = editing && editing !== 'new' ? await api.updateRule(editing.id, input) : await api.createRule(input);
    patch((s) => ({ ...s, rules: upsert(s.rules, saved) }));
    setEditing(null);
  };

  const toggle = (r: KeywordRule, enabled: boolean) =>
    action.run(async () => {
      const saved = await api.updateRule(r.id, { enabled });
      patch((s) => ({ ...s, rules: upsert(s.rules, saved) }));
    });

  const move = (index: number, delta: -1 | 1) =>
    action.run(async () => {
      const ids = rules.map((r) => r.id);
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
      const reordered = await api.reorderRules(ids);
      patch((s) => ({ ...s, rules: reordered }));
    });

  const remove = (r: KeywordRule) => {
    if (!window.confirm(`Delete keyword rule “${r.name}”?`)) return;
    void action.run(async () => {
      await api.deleteRule(r.id);
      patch((s) => ({ ...s, rules: s.rules.filter((x) => x.id !== r.id) }));
      if (editing !== 'new' && editing?.id === r.id) setEditing(null);
    });
  };

  const actionSummary = (r: KeywordRule) => {
    switch (r.action.type) {
      case 'reply':
        return `Reply “${r.action.text}”`;
      case 'send':
        return `Send “${r.action.text}” to ${displayRecipient(r.action.to, state.contacts, state.groups)}`;
      case 'script':
        return `Run script command “${r.action.command}”`;
    }
  };

  return (
    <div className="view">
      <div className="view-head">
        <h2 className="view-title">Keyword catchers</h2>
        {editing === null && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            New rule
          </button>
        )}
      </div>
      <p className="muted view-intro">Rules are checked top to bottom against every incoming message.</p>

      {editing !== null && (
        <RuleForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          state={state}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {action.error && (
        <p className="notice tone-bad" role="alert">
          {action.error}
        </p>
      )}

      {rules.length === 0 ? (
        <div className="panel empty-state">
          <p>No keyword rules yet.</p>
        </div>
      ) : (
        <ol className="card-list" aria-label="Keyword rules in evaluation order">
          {rules.map((r, i) => (
            <li key={r.id} className={`card panel${r.enabled ? '' : ' is-disabled'}`}>
              <div className="card-head">
                <h3 className="card-title">
                  <span className="order-num" aria-hidden="true">
                    {i + 1}.
                  </span>{' '}
                  {r.name}
                </h3>
                <label className="switch">
                  <input type="checkbox" checked={r.enabled} disabled={action.busy} onChange={(e) => void toggle(r, e.target.checked)} />
                  <span className="switch-track" aria-hidden="true" />
                  <span className="switch-label">
                    Enabled<span className="sr-only"> ({r.name})</span>
                  </span>
                </label>
              </div>
              <p className="card-line">
                <span className="muted">When message {MATCH_LABEL[r.matchType]} </span>
                <code>{r.pattern}</code>
                <span className="muted">
                  {' '}
                  in {SCOPE_LABEL[r.scope]}
                  {r.caseSensitive ? ', case-sensitive' : ''}
                  {r.fromFilter.length ? `, from ${r.fromFilter.join(', ')}` : ''}
                </span>
              </p>
              <p className="card-line">{actionSummary(r)}</p>
              <dl className="facts">
                <div>
                  <dt>Triggered</dt>
                  <dd className="num">{r.triggerCount}×</dd>
                </div>
                <div>
                  <dt>Last</dt>
                  <dd>{r.lastTriggeredAt ? formatDateTime(r.lastTriggeredAt) : 'never'}</dd>
                </div>
                <div>
                  <dt>Cooldown</dt>
                  <dd>{r.cooldownSeconds ? formatSeconds(r.cooldownSeconds) : 'none'}</dd>
                </div>
                <div>
                  <dt>Then</dt>
                  <dd>{r.stopProcessing ? 'stop' : 'continue'}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <button type="button" className="btn" disabled={i === 0 || action.busy} onClick={() => void move(i, -1)} aria-label={`Move ${r.name} up`}>
                  ↑ Up
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={i === rules.length - 1 || action.busy}
                  onClick={() => void move(i, 1)}
                  aria-label={`Move ${r.name} down`}
                >
                  ↓ Down
                </button>
                <button type="button" className="btn" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => remove(r)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <RuleTester state={state} />
    </div>
  );
}
