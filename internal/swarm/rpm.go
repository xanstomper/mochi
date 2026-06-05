package swarm

// RPMMode returns the Config values that implement the spec's
// RPM (Revolutions Per Minute) throughput mode. Centralising the
// constants here means callers can't accidentally drift from the
// documented behaviour.
//
// RPM mode is intentionally aggressive:
//
//   - Max agents scales to 30 (vs 4 in balanced).
//   - Max parallel tasks scales to 16 (vs 4).
//   - Max retries is 5 with 250ms base backoff capped at 30s
//     (vs 3 retries in balanced).
//   - All non-destructive operations are auto-approved;
//     OpFileDelete and OpDeploy are still gated on user approval.
func RPMMode(workingDir, mission string) Config {
	return Config{
		Mode:        ModeRPM,
		WorkingDir:  workingDir,
		Mission:     mission,
		MaxAgents:   30,
		MaxParallel: 16,
		MaxRetries:  5,
		BackoffBase: 250 * 1_000_000, // 250ms; the unit is ns
		BackoffMax:  30 * 1_000_000_000,
		AutoApprove: []OperationClass{
			OpFileEdit,
			OpFileCreate,
			OpShell,
			OpBuild,
			OpNetwork,
			OpSelfMod,
		},
	}
}

// BalancedMode returns the conservative default config.
func BalancedMode(workingDir, mission string) Config {
	return Config{
		Mode:        ModeBalanced,
		WorkingDir:  workingDir,
		Mission:     mission,
		MaxAgents:   4,
		MaxParallel: 4,
		MaxRetries:  3,
		BackoffBase: 250 * 1_000_000,
		BackoffMax:  30 * 1_000_000_000,
	}
}

// MaxAgentsForMode is a tiny helper for the TUI which sometimes
// needs the ceiling without the full config.
func MaxAgentsForMode(m Mode) int {
	if m == ModeRPM {
		return 30
	}
	return 4
}
