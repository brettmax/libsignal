import { useState } from 'react';
import type { AppState, KeywordRule, KeywordRuleInput, MatchType, Recipient, RuleAction } from '@automator/shared';
import { RecipientPicker } from './RecipientPicker';
import { errorMessage } from '../api';

interface Props {
  initial: KeywordRule | null;
  state: AppState;
  onSubmit(input: KeywordRuleInput): Promise<void>;
  onCancel(): void;
}

const MATCH_TYPES: { value: MatchType; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'word', label: 'Whole word' },
  { value: 'exact', label: 'Exact message' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'regex', label: 'Regular expression' },
];

export const TEMPLATE_HELP =
  '{{body}} {{sender}} {{senderName}} {{match}} {{time}} {{date}} and regex groups {{1}}..{{9}}';

export function RuleForm({ initial, state, onSubmit, onCancel }: Props) {
  const init = initial?.action;
  const [name, setName] = useState(initial?.name ?? '');
  const [pattern, setPattern] = useState(initial?.pattern ?? '');
  const [matchType, setMatchType] = useState<MatchType>(initial?.matchType ?? 'contains');
  const [caseSensitive, setCaseSensitive] = useState(initial?.caseSensitive ?? false);
  const [scope, setScope] = useState<KeywordRule['scope']>(initial?.scope ?? 'all');
  const [fromFilter, setFromFilter] = useState(initial?.fromFilter.join(', ') ?? '');
  const [actionType, setActionType] = useState<RuleAction['type']>(init?.type ?? 'reply');
  const [text, setText] = useState(init && init.type !== 'script' ? init.text : '');
  const [sendTo, setSendTo] = useState<Recipient[]>(init?.type === 'send' ? [init.to] : []);
  const [command, setCommand] = useState(init?.type === 'script' ? init.command : '');
  const [cooldown, setCooldown] = useState(String(initial?.cooldownSeconds ?? 0));
  const [stopProcessing, setStopProcessing] = useState(initial?.stopProcessing ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  let regexError: string | null = null;
  if (matchType === 'regex' && pattern) {
    try {
      new RegExp(pattern, caseSensitive ? '' : 'i');
    } catch (err) {
      regexError = errorMessage(err);
    }
  }

  const commands = [...new Set(state.scripts.flatMap((s) => s.commands))].sort();

  const validate = (): KeywordRuleInput | string => {
    if (!name.trim()) return 'Give the rule a name.';
    if (!pattern) return 'Enter a pattern to match.';
    if (regexError) return `Invalid regular expression: ${regexError}`;
    let action: RuleAction;
    if (actionType === 'script') {
      if (!command.trim()) return 'Enter the script command to run.';
      action = { type: 'script', command: command.trim() };
    } else {
      if (!text.trim()) return 'Enter the message text.';
      if (actionType === 'send') {
        const to = sendTo[0];
        if (!to) return 'Choose who to send to.';
        action = { type: 'send', to, text };
      } else {
        action = { type: 'reply', text };
      }
    }
    const cd = cooldown.trim() === '' ? 0 : Number(cooldown);
    if (!Number.isInteger(cd) || cd < 0) return 'Cooldown must be a whole number of seconds, 0 or more.';
    return {
      name: name.trim(),
      enabled,
      pattern,
      matchType,
      caseSensitive,
      scope,
      fromFilter: fromFilter
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      action,
      cooldownSeconds: cd,
      stopProcessing,
    };
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

  return (
    <form
      className="panel form"
      aria-labelledby="rule-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id="rule-form-title">{initial ? `Edit “${initial.name}”` : 'New keyword rule'}</h3>
      <div className="field">
        <label htmlFor="rule-name">Name</label>
        <input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field-row">
        <div className="field grow">
          <label htmlFor="rule-pattern">Pattern</label>
          <input
            id="rule-pattern"
            className="mono"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            aria-invalid={regexError ? true : undefined}
            aria-describedby={regexError ? 'rule-pattern-error' : undefined}
            spellCheck={false}
          />
          {regexError && (
            <p id="rule-pattern-error" className="error-text small">
              {regexError}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="rule-match">Match type</label>
          <select id="rule-match" value={matchType} onChange={(e) => setMatchType(e.target.value as MatchType)}>
            {MATCH_TYPES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-scope">Listen in</label>
          <select id="rule-scope" value={scope} onChange={(e) => setScope(e.target.value as KeywordRule['scope'])}>
            <option value="all">All chats</option>
            <option value="direct">Direct chats only</option>
            <option value="groups">Groups only</option>
          </select>
        </div>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
        Case-sensitive
      </label>
      <div className="field">
        <label htmlFor="rule-from">Only from senders</label>
        <input
          id="rule-from"
          value={fromFilter}
          onChange={(e) => setFromFilter(e.target.value)}
          placeholder="+15551234567, +15557654321"
          aria-describedby="rule-from-hint"
        />
        <p id="rule-from-hint" className="hint">
          Comma-separated numbers or uuids. Leave blank to react to anyone.
        </p>
      </div>

      <fieldset>
        <legend>Action</legend>
        <div className="segmented" role="radiogroup" aria-label="Action type">
          {(
            [
              ['reply', 'Reply in chat'],
              ['send', 'Send to someone'],
              ['script', 'Script command'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="segment">
              <input type="radio" name="rule-action" value={value} checked={actionType === value} onChange={() => setActionType(value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        {actionType === 'send' && (
          <RecipientPicker
            id="rule-send-to"
            label="Send to"
            value={sendTo}
            onChange={setSendTo}
            contacts={state.contacts}
            groups={state.groups}
            multiple={false}
          />
        )}
        {actionType !== 'script' ? (
          <div className="field">
            <label htmlFor="rule-text">{actionType === 'reply' ? 'Reply text' : 'Message text'}</label>
            <textarea id="rule-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="rule-text-hint" />
            <p id="rule-text-hint" className="hint">
              Template placeholders: <code>{TEMPLATE_HELP}</code>
            </p>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="rule-command">Command name</label>
            <input
              id="rule-command"
              className="mono"
              list="rule-command-list"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              aria-describedby="rule-command-hint"
            />
            <datalist id="rule-command-list">
              {commands.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p id="rule-command-hint" className="hint">
              Handled by <code>bot.command(name, handler)</code> in a script.
              {commands.length ? ` Registered: ${commands.join(', ')}.` : ' No script has registered a command yet.'}
            </p>
          </div>
        )}
      </fieldset>

      <div className="field-row">
        <div className="field">
          <label htmlFor="rule-cooldown">Cooldown (seconds)</label>
          <input
            id="rule-cooldown"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
            aria-describedby="rule-cooldown-hint"
          />
          <p id="rule-cooldown-hint" className="hint">
            Minimum pause between triggers per conversation.
          </p>
        </div>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={stopProcessing} onChange={(e) => setStopProcessing(e.target.checked)} />
        Stop checking later rules when this one matches
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {error && (
        <p className="notice tone-bad" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create rule'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
