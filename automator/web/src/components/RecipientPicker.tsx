import { useState } from 'react';
import type { Contact, Group, Recipient } from '@automator/shared';
import { contactLabel, displayRecipient, parseRecipientKey, recipientKey } from '../displayRecipient';

interface Props {
  /** Base id for the inputs. */
  id: string;
  label: string;
  value: Recipient[];
  onChange(value: Recipient[]): void;
  contacts: Contact[];
  groups: Group[];
  /** When false, choosing a recipient replaces the current one. */
  multiple?: boolean;
}

export function RecipientPicker({ id, label, value, onChange, contacts, groups, multiple = true }: Props) {
  const [number, setNumber] = useState('');
  const selected = new Set(value.map(recipientKey));

  const add = (r: Recipient) => {
    if (!multiple) return onChange([r]);
    if (!selected.has(recipientKey(r))) onChange([...value, r]);
  };

  const addNumber = () => {
    const n = number.trim().replace(/[\s()-]/g, '');
    if (!n) return;
    add({ kind: 'contact', id: n });
    setNumber('');
  };

  const availableContacts = contacts.filter((c) => !selected.has(`contact:${c.id}`));
  const availableGroups = groups.filter((g) => !selected.has(`group:${g.id}`));

  return (
    <fieldset className="recipient-picker">
      <legend>{label}</legend>
      {value.length > 0 ? (
        <ul className="chips" aria-label={`Selected ${multiple ? 'recipients' : 'recipient'}`}>
          {value.map((r) => (
            <li key={recipientKey(r)} className={`chip chip-${r.kind}`}>
              <span className="chip-kind">{r.kind === 'group' ? 'Group' : 'Contact'}</span>
              <span className="chip-name">{displayRecipient(r, contacts, groups)}</span>
              <button
                type="button"
                className="chip-remove"
                onClick={() => onChange(value.filter((x) => recipientKey(x) !== recipientKey(r)))}
                aria-label={`Remove ${displayRecipient(r, contacts, groups)}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None selected.</p>
      )}
      <div className="picker-row">
        <div className="field">
          <label htmlFor={`${id}-select`}>{multiple ? 'Add contact or group' : 'Contact or group'}</label>
          <select
            id={`${id}-select`}
            value=""
            onChange={(e) => {
              const r = parseRecipientKey(e.target.value);
              if (r) add(r);
            }}
          >
            <option value="">
              {contacts.length + groups.length === 0 ? 'No contacts synced yet' : 'Choose…'}
            </option>
            {availableContacts.length > 0 && (
              <optgroup label="Contacts">
                {availableContacts.map((c) => (
                  <option key={c.id} value={`contact:${c.id}`}>
                    {contactLabel(c)}
                  </option>
                ))}
              </optgroup>
            )}
            {availableGroups.length > 0 && (
              <optgroup label="Groups">
                {availableGroups.map((g) => (
                  <option key={g.id} value={`group:${g.id}`}>
                    {g.name || 'Unnamed group'}
                    {g.memberCount ? ` (${g.memberCount})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-number`}>Or a phone number</label>
          <div className="input-with-button">
            <input
              id={`${id}-number`}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="+15551234567"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addNumber();
                }
              }}
            />
            <button type="button" className="btn" onClick={addNumber} disabled={!number.trim()}>
              {multiple ? 'Add' : 'Use'}
            </button>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
