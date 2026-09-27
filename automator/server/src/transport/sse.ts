/** A single dispatched Server-Sent Event. */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental text/event-stream parser (per the WHATWG spec, minus `retry`).
 * Feed it decoded text chunks as they arrive; it returns the events completed by each chunk.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType = '';
  private lastId: string | undefined;
  /** True when the previous chunk ended with '\r' (a '\n' may follow in the next chunk). */
  private pendingCR = false;

  push(chunk: string): SseEvent[] {
    if (this.pendingCR && chunk.startsWith('\n')) chunk = chunk.slice(1);
    this.pendingCR = false;
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone trailing '\r' may be the first half of '\r\n'; treat it as a line end and skip a following '\n'.
      const line = this.buffer.slice(0, m.index);
      const endsAtBufferEnd = m.index + m[0].length === this.buffer.length;
      if (m[0] === '\r' && endsAtBufferEnd) this.pendingCR = true;
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (this.dataLines.length === 0) {
        this.eventType = '';
        return null;
      }
      const ev: SseEvent = { event: this.eventType || 'message', data: this.dataLines.join('\n') };
      if (this.lastId !== undefined) ev.id = this.lastId;
      this.dataLines = [];
      this.eventType = '';
      return ev;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        break;
    }
    return null;
  }
}
