export type Settled<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/**
 * Runs `work` and waits at most `ms` for it to settle. A synchronous throw
 * counts as an error. If the deadline passes first, resolves { kind: 'timeout' }
 * and the work keeps running; should it reject later, `onLateError` gets the
 * error (so user-script failures are still recorded and never become
 * unhandled rejections).
 */
export function settleWithin<T>(
  work: () => T | PromiseLike<T>,
  ms: number,
  onLateError: (err: unknown) => void,
): Promise<Settled<Awaited<T>>> {
  return new Promise((resolve) => {
    let done = false;
    let p: Promise<Awaited<T>>;
    try {
      p = Promise.resolve(work()) as Promise<Awaited<T>>;
    } catch (err) {
      p = Promise.reject(err);
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ kind: 'timeout' });
    }, ms);
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ kind: 'ok', value });
      },
      (error: unknown) => {
        if (done) {
          onLateError(error);
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve({ kind: 'error', error });
      },
    );
  });
}
