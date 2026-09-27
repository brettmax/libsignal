import { useState } from 'react';
import type { AppState } from '@automator/shared';
import { api, type RuleTestResult } from '../api';
import { useAction } from '../useAction';

export function RuleTester({ state }: { state: AppState }) {
  const [body, setBody] = useState('');
  const [sender, setSender] = useState('');
  const [group, setGroup] = useState(false);
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const test = useAction();

  const [simFrom, setSimFrom] = useState('');
  const [simBody, setSimBody] = useState('');
  const [simGroup, setSimGroup] = useState('');
  const [simDone, setSimDone] = useState<string | null>(null);
  const sim = useAction();

  const ruleName = (id: string) => state.rules.find((r) => r.id === id)?.name ?? id;

  return (
    <div className="grid-2">
      <form
        className="panel form"
        aria-labelledby="tester-title"
        onSubmit={(e) => {
          e.preventDefault();
          void test.run(async () => setResult(await api.testRules(body, sender.trim() || undefined, group)));
        }}
      >
        <h3 id="tester-title">Test rules</h3>
        <p className="hint">Dry run: shows which rules would match and what they would send. Nothing is sent.</p>
        <div className="field">
          <label htmlFor="test-body">Message text</label>
          <textarea id="test-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="test-sender">Sender (optional)</label>
          <input id="test-sender" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="+15551234567" />
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
          Arrives in a group
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={test.busy || !body}>
            {test.busy ? 'Testing…' : 'Test'}
          </button>
        </div>
        <div aria-live="polite">
          {test.error && <p className="notice tone-bad">{test.error}</p>}
          {result &&
            (result.matches.length === 0 ? (
              <p className="notice">No rule matches.</p>
            ) : (
              <ul className="test-results">
                {result.matches.map((m) => (
                  <li key={m.ruleId}>
                    <strong>{ruleName(m.ruleId)}</strong>
                    {m.output === null ? (
                      <span className="muted"> — matches (script command, no text output)</span>
                    ) : (
                      <pre className="output">{m.output}</pre>
                    )}
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </form>

      <form
        className="panel form"
        aria-labelledby="sim-title"
        onSubmit={(e) => {
          e.preventDefault();
          setSimDone(null);
          void sim.run(async () => {
            await api.simulateIncoming({ from: simFrom.trim(), body: simBody, groupId: simGroup || undefined });
            setSimDone('Injected. Rules and scripts ran for real; replies are really sent. See the Log.');
          });
        }}
      >
        <h3 id="sim-title">Simulate incoming</h3>
        <p className="hint">Feeds a fake incoming message through the full pipeline (rules and scripts). Replies are really sent.</p>
        <div className="field">
          <label htmlFor="sim-from">From</label>
          <input id="sim-from" value={simFrom} onChange={(e) => setSimFrom(e.target.value)} placeholder="+15551234567" list="sim-from-list" />
          <datalist id="sim-from-list">
            {state.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.number ?? c.id}
              </option>
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="sim-group">Group (optional)</label>
          <select id="sim-group" value={simGroup} onChange={(e) => setSimGroup(e.target.value)}>
            <option value="">Direct message</option>
            {state.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name || 'Unnamed group'}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sim-body">Message text</label>
          <textarea id="sim-body" rows={2} value={simBody} onChange={(e) => setSimBody(e.target.value)} />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn" disabled={sim.busy || !simFrom.trim() || !simBody}>
            {sim.busy ? 'Injecting…' : 'Simulate incoming'}
          </button>
        </div>
        <div aria-live="polite">
          {sim.error && <p className="notice tone-bad">{sim.error}</p>}
          {simDone && <p className="notice tone-ok">{simDone}</p>}
        </div>
      </form>
    </div>
  );
}
