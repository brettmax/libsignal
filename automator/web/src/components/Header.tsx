import type { TransportStatus } from '@automator/shared';
import type { ConnectionState } from '../useLiveState';
import { useNow } from '../useNow';
import { formatDuration } from '../format';

interface Props {
  status: TransportStatus | null;
  connection: ConnectionState;
  retryAt: number | null;
  onReconnect(): void;
}

const STATE_TONE: Record<TransportStatus['state'], string> = {
  connected: 'ok',
  connecting: 'warn',
  disconnected: 'muted',
  error: 'bad',
};

export function Header({ status, connection, retryAt, onReconnect }: Props) {
  return (
    <header className="app-header">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <h1>Signal Automator</h1>
      </div>
      <div className="header-status">
        {status && (
          <div className={`pill tone-${STATE_TONE[status.state]}`} title={status.detail ?? undefined}>
            <span className="dot" aria-hidden="true" />
            <span className="sr-only">Signal transport: </span>
            <span className="pill-kind">{status.kind}</span>
            <span className="pill-state">{status.state}</span>
            {status.account && <span className="pill-account">{status.account}</span>}
            {status.detail && <span className="pill-detail">{status.detail}</span>}
          </div>
        )}
        <WsIndicator connection={connection} retryAt={retryAt} onReconnect={onReconnect} />
      </div>
    </header>
  );
}

function WsIndicator({ connection, retryAt, onReconnect }: Omit<Props, 'status'>) {
  const now = useNow();
  const tone = connection === 'open' ? 'ok' : connection === 'connecting' ? 'warn' : 'bad';
  const label = connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Offline';
  return (
    <div className={`ws-indicator tone-${tone}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span className="sr-only">Live updates: </span>
      <span className="ws-label">{label}</span>
      {connection === 'closed' && (
        <>
          <span className="ws-retry" aria-hidden="true">
            {retryAt ? `retry in ${formatDuration(retryAt - now)}` : ''}
          </span>
          <button type="button" className="btn btn-small" onClick={onReconnect}>
            Retry now
          </button>
        </>
      )}
    </div>
  );
}
