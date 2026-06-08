package cmd

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/mochi/mochi/internal/config"
	"github.com/mochi/mochi/internal/db"
	"github.com/mochi/mochi/internal/scheduler"
	"github.com/spf13/cobra"
)

func init() {
	cronCmd.AddCommand(
		cronListCmd,
		cronAddCmd,
		cronRemoveCmd,
		cronEnableCmd,
		cronDisableCmd,
		cronResultsCmd,
	)
	rootCmd.AddCommand(cronCmd)
}

var cronCmd = &cobra.Command{
	Use:   "cron",
	Short: "Manage scheduled agent tasks",
	Long: `Schedule and manage recurring agent tasks.

Schedules can be:
  - Duration: "30m", "1h", "2h30m"
  - Preset:   "@every 30m", "@hourly", "@daily", "@weekly"
  - Cron:     "*/5 * * * *" (5-field format, minute/hour/day/month/weekday)

Examples:
  mochi cron add "daily-report" "@daily" "Run tests and summarize"
  mochi cron list
  mochi cron results daily-report
  mochi cron disable daily-report
  mochi cron remove daily-report`,
}

var cronListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all scheduled jobs",
	RunE: func(cmd *cobra.Command, args []string) error {
		svc, ctx, cleanup, err := cronSetup(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		jobs, err := svc.ListJobs(ctx)
		if err != nil {
			return fmt.Errorf("listing jobs: %w", err)
		}

		if len(jobs) == 0 {
			cmd.Println("(no scheduled jobs)")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tSCHEDULE\tNEXT RUN\tSTATUS\tRUNS")
		fmt.Fprintln(w, "--\t----\t--------\t--------\t------\t----")
		for _, j := range jobs {
			status := "enabled"
			if !j.Enabled {
				status = "disabled"
			}
			nextRun := "now"
			if !j.NextRunAt.IsZero() {
				nextRun = j.NextRunAt.Format("15:04 01/02")
			}
			shortID := j.ID[:8]
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\n",
				shortID, j.Name, j.Schedule, nextRun, status, j.RunCount)
		}
		return w.Flush()
	},
}

var cronAddCmd = &cobra.Command{
	Use:   "add [name] [schedule] [prompt...]",
	Short: "Add a scheduled job",
	Args:  cobra.MinimumNArgs(3),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		schedule := args[1]
		prompt := strings.Join(args[2:], " ")

		if !scheduler.ValidSchedule(schedule) {
			return fmt.Errorf("invalid schedule: %q (use @every 30m, @hourly, @daily, etc.)", schedule)
		}

		svc, ctx, cleanup, err := cronSetup(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		job, err := svc.CreateJob(ctx, name, schedule, prompt, "")
		if err != nil {
			return fmt.Errorf("creating job: %w", err)
		}

		cmd.Printf("✓ Created cron job: %s (%s)\n", job.Name, job.Schedule)
		cmd.Printf("  ID: %s\n", job.ID)
		cmd.Printf("  Next run: %s\n", job.NextRunAt.Format("15:04 02 Jan 2006"))
		return nil
	},
}

var cronRemoveCmd = &cobra.Command{
	Use:   "remove [name-or-id]",
	Short: "Remove a scheduled job",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		svc, ctx, cleanup, err := cronSetup(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		// Resolve name or partial ID to full ID
		fullID, err := resolveCronID(ctx, svc, id)
		if err != nil {
			return err
		}

		if err := svc.DeleteJob(ctx, fullID); err != nil {
			return fmt.Errorf("removing job: %w", err)
		}
		cmd.Printf("✓ Removed cron job: %s\n", id)
		return nil
	},
}

var cronEnableCmd = &cobra.Command{
	Use:   "enable [name-or-id]",
	Short: "Enable a cron job",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		svc, ctx, cleanup, err := cronSetup(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		fullID, err := resolveCronID(ctx, svc, id)
		if err != nil {
			return err
		}

		if err := svc.EnableJob(ctx, fullID); err != nil {
			return fmt.Errorf("enabling job: %w", err)
		}
		cmd.Printf("✓ Enabled cron job: %s\n", id)
		return nil
	},
}

var cronDisableCmd = &cobra.Command{
	Use:   "disable [name-or-id]",
	Short: "Disable a cron job",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		svc, ctx, cleanup, err := cronSetup(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		fullID, err := resolveCronID(ctx, svc, id)
		if err != nil {
			return err
		}

		if err := svc.DisableJob(ctx, fullID); err != nil {
			return fmt.Errorf("disabling job: %w", err)
		}
		cmd.Printf("✓ Disabled cron job: %s\n", id)
		return nil
	},
}

var cronResultsCmd = &cobra.Command{
	Use:   "results [name-or-id]",
	Short: "Show recent results for a cron job",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		svc, ctx, cleanup, err := cronSetup(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		fullID, err := resolveCronID(ctx, svc, id)
		if err != nil {
			return err
		}

		results, err := svc.ListResults(ctx, fullID, 10)
		if err != nil {
			return fmt.Errorf("listing results: %w", err)
		}

		if len(results) == 0 {
			cmd.Println("(no results yet)")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "STARTED\tDURATION\tSTATUS\tOUTPUT")
		fmt.Fprintln(w, "-------\t--------\t------\t------")
		for _, r := range results {
			status := "✓"
			if !r.Success {
				status = "✗"
			}
			out := truncateStr(r.Output, 60)
			if r.Error != "" {
				out = truncateStr(r.Error, 60)
			}
			fmt.Fprintf(w, "%s\t%v\t%s\t%s\n",
				r.StartedAt.Format("15:04:05"), fmt.Sprintf("%dms", r.DurationMs), status, out)
		}
		return w.Flush()
	},
}

// --- Helpers ---

func cronSetup(cmd *cobra.Command) (*scheduler.Scheduler, context.Context, func(), error) {
	ctx := cmd.Context()
	dataDir := ""

	cfg, err := config.Init("", dataDir, false)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to initialize config: %w", err)
	}
	if dataDir == "" {
		dataDir = cfg.Config().Options.DataDirectory
	}

	conn, err := db.Connect(ctx, dataDir)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	// Create a no-op handler for CLI operations (actual execution uses app's handler)
	svc := scheduler.New(conn, func(ctx context.Context, job scheduler.Job) (string, error) {
		return "", fmt.Errorf("cron jobs run via the agent, not directly from CLI")
	})

	return svc, ctx, func() {
		_ = conn.Close()
		_ = db.Release(dataDir)
	}, nil
}

func resolveCronID(ctx context.Context, svc *scheduler.Scheduler, id string) (string, error) {
	if len(id) >= 36 && !strings.Contains(id, " ") {
		// Looks like a full UUID — try direct lookup
		job, err := svc.GetJob(ctx, id)
		if err == nil {
			return job.ID, nil
		}
	}

	// Search by name or prefix
	jobs, err := svc.ListJobs(ctx)
	if err != nil {
		return "", err
	}

	var matches []scheduler.Job
	for _, j := range jobs {
		if j.ID == id || strings.HasPrefix(j.ID, id) || j.Name == id {
			matches = append(matches, j)
		}
	}

	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no cron job matching %q", id)
	case 1:
		return matches[0].ID, nil
	default:
		names := make([]string, len(matches))
		for i, m := range matches {
			names[i] = fmt.Sprintf("%s (%s)", m.Name, m.ID[:8])
		}
		return "", fmt.Errorf("multiple jobs match %q: %s", id, strings.Join(names, ", "))
	}
}
