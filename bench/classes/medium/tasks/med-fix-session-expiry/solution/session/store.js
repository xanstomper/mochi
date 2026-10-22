class SessionStore {
  // `now` is injectable so tests can drive a fake clock.
  constructor(now = Date.now) {
    this.now = now;
    this.sessions = new Map();
    this.seq = 0;
  }
  create(userId) {
    const id = `sess-${++this.seq}`;
    const t = this.now();
    this.sessions.set(id, { userId, createdAt: t, lastSeenAt: t });
    return id;
  }
  get(id) {
    return this.sessions.get(id) ?? null;
  }
  // Record activity on a session (for auditing / last-seen display).
  // Activity must NEVER extend the session's absolute lifetime, so
  // createdAt is left untouched here.
  touch(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lastSeenAt = this.now();
  }
}
module.exports = { SessionStore };
