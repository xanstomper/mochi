// Canned solution: per-stream accumulation with keep-ends truncation, ported
// from src/exec.ts as of e39d744 (fix(exec): keep-ends truncation — firehose
// output keeps head AND rolling tail). The pushStream/streamText logic below
// is the fix's own, verbatim apart from TypeScript types; the class shape
// matches the fixture so the observable contract is unchanged: result() is
// the accumulated text, wasTruncated reports whether the cap was exceeded,
// and the literal '[truncated]' anchor stays intact for consumers that grep
// for it.
class OutputCollector {
  constructor(cap) {
    this.cap = cap;
    this.total = 0;
    this.head = '';
    this.tail = '';
    this.truncated = false;
  }

  push(chunk) {
    const cap = this.cap;
    this.total += chunk.length;
    if (!this.truncated) {
      this.head += chunk;
      if (this.head.length > cap) {
        this.truncated = true;
        const keep = Math.max(0, Math.floor(cap / 2));
        this.tail = this.head.slice(keep);
        this.head = this.head.slice(0, keep);
        if (this.tail.length > keep) this.tail = this.tail.slice(-keep);
      }
      return;
    }
    this.tail += chunk;
    const keep = Math.max(0, Math.floor(cap / 2));
    if (this.tail.length > keep) this.tail = this.tail.slice(-keep);
  }

  result() {
    if (!this.truncated) return this.head;
    const dropped = this.total - this.head.length - this.tail.length;
    // The literal `[truncated]` anchor is part of the observable contract —
    // consumers (and tests) grep for it — so it stays intact with the detail
    // appended after it.
    return `${this.head}\n... [truncated] (${dropped} bytes in the middle elided — output ends below) ...\n${this.tail}`;
  }

  get wasTruncated() {
    return this.truncated;
  }
}

module.exports = { OutputCollector };
