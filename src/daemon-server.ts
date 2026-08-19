// Standalone daemon-server entry: `node dist/daemon-server.js <port> <token> <cwd>`.
// Re-exported from daemon.ts so the child process is just this one module.
export * from './daemon.js';