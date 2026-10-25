// ACP stdio conformance fixture: runs the ACP serverLoop on THIS process's
// stdin/stdout. Spawned by acp.conformance.test.ts with env:
//   MOCHI_CONFIG_PATH → config.json pointing the model at a fake OpenAI
//   ACP_FIXTURE_CWD   → the workspace dir sessions default to
// Test-support entry only; the production entry point is `mochi acp`.
import { serverLoop } from '../acp.js';

const cwd = process.env.ACP_FIXTURE_CWD || process.cwd();
serverLoop(cwd).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
