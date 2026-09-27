import type { AppState } from '@automator/shared';
import { Countdown } from './Countdown';
import { MessageList } from './MessageList';
import { displayRecipient } from '../displayRecipient';
import { formatSeconds } from '../format';

export function Dashboard({ state }: { state: AppState }) {
  const incoming = state.messages.filter((m) => m.direction === 'incoming').length;
  const outgoing = state.messages.length - incoming;
  const failed = state.messages.filter((m) => m.ok === false).length;
  const active = state.repeaters
    .filter((r) => r.enabled && r.nextRunAt !== null)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
  const scriptErrors = state.scripts.filter((s) => s.error).length;

  const stats = [
    { label: 'Messages logged', value: state.messages.length, sub: `${incoming} in · ${outgoing} out${failed ? ` · ${failed} failed` : ''}` },
    { label: 'Active repeaters', value: active.length, sub: `of ${state.repeaters.length}` },
    { label: 'Keyword rules', value: state.rules.filter((r) => r.enabled).length, sub: `enabled of ${state.rules.length}` },
    {
      label: 'Scripts loaded',
      value: state.scripts.filter((s) => s.loaded).length,
      sub: `of ${state.scripts.length}${scriptErrors ? ` · ${scriptErrors} with errors` : ''}`,
    },
    { label: 'Contacts', value: state.contacts.length, sub: `${state.groups.length} groups` },
  ];

  return (
    <div className="view">
      <h2 className="view-title">Dashboard</h2>
      <ul className="stats" aria-label="Summary">
        {stats.map((s) => (
          <li key={s.label} className="stat panel">
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
            <span className="stat-sub muted">{s.sub}</span>
          </li>
        ))}
      </ul>

      <div className="grid-2">
        <section className="panel" aria-labelledby="dash-repeaters">
          <div className="panel-head">
            <h3 id="dash-repeaters">Next sends</h3>
            <a href="#/repeaters" className="small">
              Manage repeaters
            </a>
          </div>
          {active.length === 0 ? (
            <p className="muted">No active repeaters.</p>
          ) : (
            <ul className="countdown-list">
              {active.map((r) => (
                <li key={r.id}>
                  <div className="cd-main">
                    <span className="cd-name">{r.name}</span>
                    <span className="muted small">
                      to {r.recipients.map((x) => displayRecipient(x, state.contacts, state.groups)).join(', ') || 'nobody'} · every{' '}
                      {formatSeconds(r.intervalSeconds)}
                    </span>
                  </div>
                  <Countdown target={r.nextRunAt} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="dash-messages">
          <div className="panel-head">
            <h3 id="dash-messages">Recent messages</h3>
            <a href="#/log" className="small">
              Full log
            </a>
          </div>
          <MessageList messages={state.messages.slice(0, 8)} contacts={state.contacts} groups={state.groups} />
        </section>
      </div>
    </div>
  );
}
