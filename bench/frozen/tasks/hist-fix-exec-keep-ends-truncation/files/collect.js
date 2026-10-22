// Frozen-task fixture: per-stream output accumulation for spawned commands,
// re-expressed from the inline stdout/stderr handlers in src/exec.ts as of
// e39d744^ (the parent of the keep-ends truncation fix). The parent handlers
// appended each chunk to one string; on overflow they sliced the HEAD only,
// appended the '\n... [truncated]' marker, and destroyed the stream — so the
// tail of a long output (where build/test failure summaries print) was lost.
// This class reproduces that observable behavior exactly: push() after
// overflow is a no-op because the stream is gone.
class OutputCollector {
  constructor(cap) {
    this.cap = cap;
    this.text = '';
    this.truncated = false;
    this.streamDestroyed = false;
  }

  push(chunk) {
    if (this.streamDestroyed) return;
    this.text += chunk;
    if (this.text.length > this.cap) {
      this.text = this.text.slice(0, this.cap) + '\n... [truncated]';
      this.truncated = true;
      this.streamDestroyed = true;
    }
  }

  result() {
    return this.text;
  }

  get wasTruncated() {
    return this.truncated;
  }
}

module.exports = { OutputCollector };
