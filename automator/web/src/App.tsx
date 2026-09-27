import { useEffect, useState } from 'react';
import { useLiveState } from './useLiveState';
import { Header } from './components/Header';
import { Dashboard } from './components/Dashboard';
import { SendPanel } from './components/SendPanel';
import { RepeatersView } from './components/Repeaters';
import { KeywordsView } from './components/Keywords';
import { ScriptsView } from './components/Scripts';
import { LogView } from './components/LogView';

export const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'send', label: 'Send' },
  { id: 'repeaters', label: 'Repeaters' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'log', label: 'Log' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

function tabFromHash(): TabId {
  const id = location.hash.replace(/^#\/?/, '');
  return TABS.find((t) => t.id === id)?.id ?? 'dashboard';
}

export function App() {
  const live = useLiveState();
  const [tab, setTab] = useState<TabId>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const label = TABS.find((t) => t.id === tab)?.label;
    document.title = `${label} · Signal Automator`;
  }, [tab]);

  const { state, patch } = live;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header status={state?.status ?? null} connection={live.connection} retryAt={live.retryAt} onReconnect={live.reconnect} />
      <div className="app-body">
        <nav className="app-nav" aria-label="Sections">
          <ul>
            {TABS.map((t) => (
              <li key={t.id}>
                <a href={`#/${t.id}`} aria-current={tab === t.id ? 'page' : undefined}>
                  {t.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="app-main" tabIndex={-1}>
          {!state ? (
            <div className="panel empty-state" role="status">
              <h2>Waiting for the automator server…</h2>
              <p className="muted">
                {live.connection === 'closed'
                  ? 'The server is not reachable. It is retrying automatically; check that the automator server is running.'
                  : 'Connecting to the live event stream.'}
              </p>
            </div>
          ) : tab === 'dashboard' ? (
            <Dashboard state={state} />
          ) : tab === 'send' ? (
            <SendPanel state={state} patch={patch} />
          ) : tab === 'repeaters' ? (
            <RepeatersView state={state} patch={patch} />
          ) : tab === 'keywords' ? (
            <KeywordsView state={state} patch={patch} />
          ) : tab === 'scripts' ? (
            <ScriptsView state={state} patch={patch} />
          ) : (
            <LogView state={state} />
          )}
        </main>
      </div>
    </div>
  );
}
