package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mochi/mochi/internal/swarm"
	"github.com/mochi/mochi/internal/workspace"
	"github.com/spf13/cobra"
)

// SwarmFlags is the set of flags the swarm command accepts.
type SwarmFlags struct {
	Mode        string
	MaxAgents   int
	MaxParallel int
	OutputJSON  bool
	Watch       bool
	DataDir     string
	// AutoApproveAll auto-approves every non-destructive
	// operation. Even in RPM mode the runtime asks for
	// approval for deletes and external deploys; this flag
	// suppresses the prompt (use with care).
	AutoApproveAll bool
}

var swarmFlags SwarmFlags

// SwarmCmd is the `MOCHI swarm` subcommand. It runs a swarm mission
// against the current working directory.
var SwarmCmd = &cobra.Command{
	Use:   "swarm [mission]",
	Short: "Run a multi-agent swarm mission",
	Long: `Run a MOCHI swarm mission: a master orchestrator decomposes the
mission into a task DAG, the scheduler dispatches tasks to 1-30
specialist agents, and an integration step merges the result.

Modes:
  balanced (default)  Conservative. Up to 4 agents, 4 parallel
                      tasks, 3 retries per task.
  rpm                 Throughput mode. Up to 30 agents, 16
                      parallel tasks, 5 retries. Auto-approves
                      non-destructive operations.

The mission is read from the first positional argument or from
stdin. The run produces a final report on stdout (JSON if --json,
human-readable otherwise).`,
	Args: cobra.MaximumNArgs(1),
	RunE: runSwarm,
}

func init() {
	SwarmCmd.Flags().StringVar(&swarmFlags.Mode, "mode", "balanced", "Swarm mode: balanced or rpm")
	SwarmCmd.Flags().IntVar(&swarmFlags.MaxAgents, "max-agents", 0, "Maximum concurrent agents (0 = mode default)")
	SwarmCmd.Flags().IntVar(&swarmFlags.MaxParallel, "max-parallel", 0, "Maximum parallel tasks per tick (0 = mode default)")
	SwarmCmd.Flags().BoolVar(&swarmFlags.OutputJSON, "json", false, "Emit the run report as JSON")
	SwarmCmd.Flags().BoolVar(&swarmFlags.Watch, "watch", false, "Stream events to stderr as the run progresses")
	SwarmCmd.Flags().StringVar(&swarmFlags.DataDir, "data-dir", "", "Override the swarm database directory (default <cwd>/.MOCHI)")
	SwarmCmd.Flags().BoolVar(&swarmFlags.AutoApproveAll, "yes", false, "Auto-approve every operation including destructive ones")
}

func runSwarm(cmd *cobra.Command, args []string) error {
	mission, err := readMission(args)
	if err != nil {
		return err
	}
	wd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("getwd: %w", err)
	}
	mode := swarm.Mode(swarmFlags.Mode)
	if mode != swarm.ModeBalanced && mode != swarm.ModeRPM {
		return fmt.Errorf("invalid mode %q (want balanced or rpm)", swarmFlags.Mode)
	}
	cfg := swarm.DefaultConfig(mode, wd, mission)
	if swarmFlags.MaxAgents > 0 {
		cfg.MaxAgents = swarmFlags.MaxAgents
	}
	if swarmFlags.MaxParallel > 0 {
		cfg.MaxParallel = swarmFlags.MaxParallel
	}
	if swarmFlags.AutoApproveAll {
		cfg.AutoApprove = append(cfg.AutoApprove, swarm.OpFileDelete, swarm.OpDeploy)
	}
	dataDir := swarmFlags.DataDir
	if dataDir == "" {
		dataDir = filepath.Join(wd, ".MOCHI")
	}
	cfg.DataDir = dataDir
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("mkdir data dir: %w", err)
	}

	// Optional SQLite store. A failure to open is non-fatal;
	// the runtime still works in memory.
	var store *swarm.Store
	storePath := filepath.Join(dataDir, "swarm.db")
	if s, err := swarm.OpenStore(storePath); err == nil {
		store = s
		defer s.Close()
	} else {
		fmt.Fprintf(os.Stderr, "warning: open store: %v (continuing without persistence)\n", err)
	}

	// Build the real MOCHI app so the swarm can dispatch to a
	// live coordinator. We reuse the same workspace setup that
	// the rest of the CLI uses.
	var adapter swarm.CoordinatorAdapter = noopAdapter{}
	ws, cleanup, wsErr := setupLocalWorkspace(cmd)
	if wsErr != nil || ws == nil {
		fmt.Fprintf(os.Stderr, "warning: could not build local app: %v (using noop adapter)\n", wsErr)
	} else {
		defer cleanup()
		if appWs, ok := ws.(*workspace.AppWorkspace); ok {
			if a := appWs.App(); a != nil && a.AgentCoordinator != nil {
				adapter = newMOCHIAdapter(a.AgentCoordinator)
			}
		}
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	rt, err := swarm.NewRuntime(swarm.Options{
		Config:      cfg,
		Coordinator: adapter,
		Store:       store,
		Logger:      logger,
	})
	if err != nil {
		return err
	}

	if swarmFlags.Watch {
		go watchEvents(rt)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchInterrupt(cancel)

	rep, runErr := rt.Run(ctx)

	if swarmFlags.OutputJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
	} else {
		printHumanReport(os.Stdout, rep)
	}
	if runErr != nil {
		fmt.Fprintf(os.Stderr, "run failed: %v\n", runErr)
		os.Exit(1)
	}
	return nil
}

func readMission(args []string) (string, error) {
	if len(args) > 0 && args[0] != "" {
		return args[0], nil
	}
	stat, err := os.Stdin.Stat()
	if err != nil {
		return "", err
	}
	// ModeCharDevice means "is a TTY" (i.e. no piped data).
	if (stat.Mode() & os.ModeCharDevice) != 0 {
		return "", fmt.Errorf("mission required: pass it as the first arg or pipe via stdin")
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", fmt.Errorf("mission required: pass it as the first arg or pipe via stdin")
	}
	return string(data), nil
}

func watchEvents(rt *swarm.Runtime) {
	for e := range rt.Events() {
		b, _ := json.Marshal(e)
		fmt.Fprintln(os.Stderr, string(b))
	}
}

func watchInterrupt(cancel context.CancelFunc) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
	cancel()
}

func printHumanReport(w io.Writer, rep swarm.Report) {
	fmt.Fprintf(w, "Run:       %s\n", rep.RunID)
	fmt.Fprintf(w, "Mode:      %s\n", rep.Mode)
	fmt.Fprintf(w, "Duration:  %s\n", rep.Duration().Truncate(time.Millisecond))
	fmt.Fprintf(w, "Tasks:     %d total, %d ok, %d failed, %d blocked\n",
		rep.TasksTotal, rep.TasksSucceeded, rep.TasksFailed, rep.TasksBlocked)
	fmt.Fprintf(w, "Tokens:    %d in / %d out\n", rep.TokensIn, rep.TokensOut)
	if len(rep.FilesChanged) > 0 {
		fmt.Fprintf(w, "Files:     %d changed\n", len(rep.FilesChanged))
		for i, f := range rep.FilesChanged {
			if i >= 20 {
				fmt.Fprintf(w, "           ... and %d more\n", len(rep.FilesChanged)-20)
				break
			}
			fmt.Fprintf(w, "           %s\n", f)
		}
	}
	if rep.Reason != "" {
		fmt.Fprintf(w, "Reason:    %s\n", rep.Reason)
	}
}

// noopAdapter is the default coordinator adapter. Real
// installations will replace it with a wrapper around the MOCHI
// agent coordinator. The runtime works without an LLM — every
// agent run is logged and treated as a successful no-op — which
// is the right behaviour for `MOCHI swarm --watch` smoke tests
// and for the first end-to-end integration before the coordinator
// is wired in.
type noopAdapter struct{}

func (noopAdapter) Run(ctx context.Context, sessionID, prompt string) (swarm.CoordinatorResult, error) {
	return swarm.CoordinatorResult{Text: "(no LLM wired; would run: " + truncate(prompt, 80) + ")"}, nil
}

func (noopAdapter) Cancel(sessionID string) {}
func (noopAdapter) CancelAll()              {}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
