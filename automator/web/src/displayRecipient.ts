import type { Contact, Group, Recipient } from '@automator/shared';

export function recipientKey(r: Recipient): string {
  return `${r.kind}:${r.id}`;
}

export function parseRecipientKey(key: string): Recipient | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!id || (kind !== 'contact' && kind !== 'group')) return null;
  return { kind, id };
}

export function findContact(id: string, contacts: Contact[]): Contact | undefined {
  return contacts.find((c) => c.id === id || c.number === id || c.uuid === id);
}

export function contactLabel(c: Contact): string {
  const handle = c.number ?? c.uuid ?? c.id;
  return c.name ? `${c.name} (${handle})` : handle;
}

/** Human-readable name for a conversation target. */
export function displayRecipient(r: Recipient, contacts: Contact[], groups: Group[]): string {
  if (r.kind === 'group') {
    const g = groups.find((x) => x.id === r.id);
    if (g) return g.name || 'Unnamed group';
    return `Group ${r.id.slice(0, 8)}…`;
  }
  const c = findContact(r.id, contacts);
  return c?.name || c?.number || r.id;
}

/** Display name for an incoming sender id, preferring the name Signal reported. */
export function displaySender(id: string | undefined, name: string | undefined, contacts: Contact[]): string {
  if (!id) return '';
  if (name) return name;
  const c = findContact(id, contacts);
  return c?.name || c?.number || id;
}
