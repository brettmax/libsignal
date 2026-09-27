import type { Contact, Group, Recipient, TransportStatus } from '@automator/shared';
import type { Envelope, Logger, SignalTransport } from '../contracts.js';

export const MOCK_ACCOUNT = '+15550000000';

/** In-memory transport for development and tests; nothing leaves the machine. */
export class MockTransport implements SignalTransport {
  readonly kind = 'mock' as const;
  readonly sent: { to: Recipient; body: string; timestamp: number }[] = [];
  contactsList: Contact[] = [
    { id: '+15550000001', number: '+15550000001', name: 'Alice' },
    { id: '+15550000002', number: '+15550000002', name: 'Bob' },
    { id: '+15550000003', number: '+15550000003', name: 'Carol' },
  ];
  groupsList: Group[] = [{ id: 'bW9jay1ncm91cC0xAAAAAAAAAAAAAAAAAAAAAAAAAAA=', name: 'Test Group', memberCount: 3 }];
  private st: TransportStatus = { kind: 'mock', state: 'disconnected', account: MOCK_ACCOUNT, detail: null };
  private envSubs = new Set<(e: Envelope) => void>();
  private statusSubs = new Set<(s: TransportStatus) => void>();
  private lastTs = 0;

  constructor(private readonly logger?: Logger) {}

  async connect(): Promise<void> {
    this.setState('connected', 'mock transport: messages are not really sent');
  }

  async close(): Promise<void> {
    this.setState('disconnected', null);
  }

  status(): TransportStatus {
    return { ...this.st };
  }

  async send(to: Recipient, body: string): Promise<{ timestamp: number }> {
    // Signal timestamps identify messages, so keep them unique and increasing.
    const timestamp = Math.max(Date.now(), this.lastTs + 1);
    this.lastTs = timestamp;
    this.sent.push({ to, body, timestamp });
    this.logger?.log('info', 'transport', `[mock] send to ${to.kind}:${to.id}: ${body}`);
    return { timestamp };
  }

  async listContacts(): Promise<Contact[]> {
    return this.contactsList.map((c) => ({ ...c }));
  }

  async listGroups(): Promise<Group[]> {
    return this.groupsList.map((g) => ({ ...g }));
  }

  onEnvelope(cb: (e: Envelope) => void): () => void {
    this.envSubs.add(cb);
    return () => {
      this.envSubs.delete(cb);
    };
  }

  onStatus(cb: (s: TransportStatus) => void): () => void {
    this.statusSubs.add(cb);
    return () => {
      this.statusSubs.delete(cb);
    };
  }

  /** Push an envelope as if it had arrived from Signal. Empty bodies are dropped, like the real transport. */
  inject(envelope: Envelope): void {
    if (!envelope.body) return;
    for (const cb of this.envSubs) cb(envelope);
  }

  private setState(state: TransportStatus['state'], detail: string | null): void {
    this.st = { ...this.st, state, detail };
    const s = this.status();
    for (const cb of this.statusSubs) cb(s);
  }
}
