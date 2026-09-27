import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AppState, ScriptInfo } from '@automator/shared';
import { api, errorMessage } from '../api';
import type { StatePatch } from '../useLiveState';
import { BOT_API, STARTER_SCRIPT } from '../scriptTemplate';
import { formatDateTime } from '../format';
import { useAction } from '../useAction';

interface Props {
  state: AppState;
  patch(fn: StatePatch): void;
}

const upsert = (list: ScriptInfo[], s: ScriptInfo) =>
  list.some((x) => x.name === s.name) ? list.map((x) => (x.name === s.name ? s : x)) : [...list, s];

export function normalizeScriptName(raw: string): string {
  const name = raw.trim().replace(/[\\/]/g, '-');
  if (!name) return '';
  return /\.m?js$/i.test(name) ? name : `${name}.js`;
}

export function ScriptsView({ state, patch }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [saved, setSaved] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const escaped = useRef(false);
  const dirty = selected !== null && source !== saved;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getScript(selected)
      .then((res) => {
        if (cancelled) return;
        setSource(res.source);
        setSaved(res.source);
      })
      .catch((err) => !cancelled && setLoadError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const confirmDiscard = () => !dirty || window.confirm('Discard unsaved changes to this script?');

  const select = (name: string) => {
    if (name === selected || !confirmDiscard()) return;
    setNotice(null);
    setSelected(name);
  };

  const save = () =>
    action.run(async () => {
      if (!selected) return;
      const info = await api.saveScript(selected, source);
      setSaved(source);
      patch((s) => ({ ...s, scripts: upsert(s.scripts, info) }));
      setNotice(info.error ? null : `Saved and reloaded ${info.name}.`);
    });

  const create = () =>
    action.run(async () => {
      const name = normalizeScriptName(newName);
      if (!name) throw new Error('Enter a file name for the script.');
      if (state.scripts.some((s) => s.name === name)) throw new Error(`A script named ${name} already exists.`);
      if (!confirmDiscard()) return;
      const info = await api.saveScript(name, STARTER_SCRIPT);
      patch((s) => ({ ...s, scripts: upsert(s.scripts, info) }));
      setNewName('');
      setSaved(STARTER_SCRIPT);
      setSource(STARTER_SCRIPT);
      setSelected(name);
      setNotice(`Created ${name} from the starter template.`);
    });

  const remove = (name: string) => {
    if (!window.confirm(`Delete script ${name}? The file is removed from the scripts folder.`)) return;
    void action.run(async () => {
      await api.deleteScript(name);
      patch((s) => ({ ...s, scripts: s.scripts.filter((x) => x.name !== name) }));
      if (selected === name) {
        setSelected(null);
        setSource('');
        setSaved('');
      }
    });
  };

  const toggle = (s: ScriptInfo, enabled: boolean) =>
    action.run(async () => {
      const info = await api.setScriptEnabled(s.name, enabled);
      patch((st) => ({ ...st, scripts: upsert(st.scripts, info) }));
    });

  const reloadAll = () =>
    action.run(async () => {
      const scripts = await api.reloadScripts();
      patch((s) => ({ ...s, scripts }));
      setNotice('All scripts reloaded.');
    });

  const onEditorKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty) void save();
      return;
    }
    if (e.key === 'Escape') {
      escaped.current = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      const next = source.slice(0, start) + '  ' + source.slice(end);
      setSource(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
      return;
    }
    escaped.current = false;
  };

  const info = state.scripts.find((s) => s.name === selected) ?? null;

  return (
    <div className="view">
      <div className="view-head">
        <h2 className="view-title">Scripts</h2>
        <button type="button" className="btn" disabled={action.busy} onClick={() => void reloadAll()}>
          Reload all
        </button>
      </div>
      <p className="muted view-intro">JavaScript modules in the scripts folder that handle incoming and outgoing messages.</p>

      {action.error && (
        <p className="notice tone-bad" role="alert">
          {action.error}
        </p>
      )}

      <div className="scripts-layout">
        <aside className="panel scripts-list" aria-labelledby="scripts-list-title">
          <h3 id="scripts-list-title">Files</h3>
          {state.scripts.length === 0 ? (
            <p className="muted">No scripts yet.</p>
          ) : (
            <ul>
              {state.scripts.map((s) => (
                <li key={s.name} className={s.name === selected ? 'is-selected' : ''}>
                  <button
                    type="button"
                    className="script-select"
                    onClick={() => select(s.name)}
                    aria-current={s.name === selected ? 'true' : undefined}
                  >
                    <span className="script-name mono">{s.name}</span>
                    <span className="script-badges">
                      {!s.enabled ? (
                        <span className="badge">disabled</span>
                      ) : s.error ? (
                        <span className="badge tone-bad">error</span>
                      ) : s.loaded ? (
                        <span className="badge tone-ok">loaded</span>
                      ) : (
                        <span className="badge tone-warn">not loaded</span>
                      )}
                    </span>
                    {s.commands.length > 0 && <span className="small muted">commands: {s.commands.join(', ')}</span>}
                  </button>
                  <label className="switch switch-small">
                    <input type="checkbox" checked={s.enabled} disabled={action.busy} onChange={(e) => void toggle(s, e.target.checked)} />
                    <span className="switch-track" aria-hidden="true" />
                    <span className="sr-only">Enable {s.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form
            className="new-script"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label htmlFor="new-script-name">New script</label>
            <div className="input-with-button">
              <input id="new-script-name" className="mono" placeholder="auto-away.js" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button type="submit" className="btn" disabled={action.busy || !newName.trim()}>
                Create
              </button>
            </div>
          </form>
        </aside>

        <section className="panel script-editor" aria-labelledby="editor-title">
          {!selected ? (
            <div className="empty-state">
              <h3 id="editor-title">No script selected</h3>
              <p className="muted">Pick a script to edit, or create one from the starter template.</p>
            </div>
          ) : (
            <>
              <div className="panel-head">
                <h3 id="editor-title" className="mono">
                  {selected}
                  {dirty && <span className="badge tone-warn">unsaved</span>}
                </h3>
                <div className="inline-actions">
                  <button type="button" className="btn btn-primary" disabled={!dirty || action.busy || loading} onClick={() => void save()}>
                    {action.busy ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => remove(selected)}>
                    Delete
                  </button>
                </div>
              </div>
              {info?.error && (
                <div className="notice tone-bad" role="alert">
                  <strong>Script error</strong>
                  <pre className="output">{info.error}</pre>
                </div>
              )}
              {notice && !info?.error && (
                <p className="notice tone-ok" aria-live="polite">
                  {notice}
                </p>
              )}
              {loadError && <p className="notice tone-bad">{loadError}</p>}
              <label htmlFor="script-source" className="sr-only">
                Source of {selected}
              </label>
              <textarea
                id="script-source"
                className="code-editor"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                value={loading ? '' : source}
                placeholder={loading ? 'Loading…' : undefined}
                disabled={loading}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={onEditorKey}
                aria-describedby="script-editor-hint"
              />
              <p id="script-editor-hint" className="hint">
                Tab inserts two spaces (press Esc, then Tab, to move focus out). Ctrl/Cmd+S saves.
                {info && ` Last changed ${formatDateTime(info.updatedAt)}.`}
              </p>
            </>
          )}
        </section>
      </div>

      <details className="panel cheat-sheet">
        <summary>Scripting API cheat sheet</summary>
        <div className="cheat-grid">
          {BOT_API.map((group) => (
            <section key={group.title}>
              <h4>{group.title}</h4>
              <dl>
                {group.entries.map((e) => (
                  <div key={e.sig}>
                    <dt>
                      <code>{e.sig}</code>
                    </dt>
                    <dd>{e.doc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </details>
    </div>
  );
}
