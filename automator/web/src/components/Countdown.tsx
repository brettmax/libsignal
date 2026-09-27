import { useNow } from '../useNow';
import { formatDuration } from '../format';

interface Props {
  /** Target time in ms epoch; null shows `idleLabel`. */
  target: number | null;
  idleLabel?: string;
  dueLabel?: string;
}

/** Live countdown to `target`, updating every second. */
export function Countdown({ target, idleLabel = '—', dueLabel = 'due now' }: Props) {
  const now = useNow();
  if (target === null) return <span className="countdown idle">{idleLabel}</span>;
  const remaining = target - now;
  return (
    <time className={`countdown${remaining <= 0 ? ' due' : ''}`} dateTime={new Date(target).toISOString()} role="timer">
      {remaining <= 0 ? dueLabel : formatDuration(remaining)}
    </time>
  );
}
