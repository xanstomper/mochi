package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var (
	memDBPath  string
	cronDBPath string
)

func init() {
	home, _ := os.UserHomeDir()
	defaultDir := filepath.Join(home, ".config", "mochi")
	memDBPath = filepath.Join(defaultDir, "memory.json")
	cronDBPath = filepath.Join(defaultDir, "cron.json")

	extrasCmd.AddCommand(extrasMemoryCmd, extrasCronCmd, extrasSysinfoCmd, extrasVersionCmd)
	rootCmd.AddCommand(extrasCmd)
}

var extrasCmd = &cobra.Command{
	Use:   "extras",
	Short: "Mochi-specific extras beyond crush (memory, cron, system info)",
}

var extrasMemoryCmd = &cobra.Command{
	Use:   "memory",
	Short: "Manage long-term memory entries",
}

var memListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all memory entries",
	RunE: func(cmd *cobra.Command, args []string) error {
		entries := loadMem(cmd.Context())
		if len(entries) == 0 {
			cmd.Println("(no memory entries)")
			return nil
		}
		for _, e := range entries {
			tags := strings.Join(e.Tags, ",")
			if tags != "" {
				tags = " [" + tags + "]"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s%s: %s\n", e.ID, tags, e.Content)
		}
		return nil
	},
}

var memAddCmd = &cobra.Command{
	Use:   "add [content]",
	Short: "Add a new memory entry",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tagsFlag, _ := cmd.Flags().GetString("tags")
		sourceFlag, _ := cmd.Flags().GetString("source")
		var tags []string
		if tagsFlag != "" {
			tags = strings.Split(tagsFlag, ",")
		}
		entries := loadMem(cmd.Context())
		content := strings.Join(args, " ")
		entry := memEntry{
			ID:        randomID(),
			Content:   content,
			Tags:      tags,
			Source:    sourceFlag,
			CreatedAt: time.Now(),
		}
		entries = append(entries, entry)
		if err := saveJSON(memDBPath, memFile{Entries: entries}); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "added memory %s\n", entry.ID)
		return nil
	},
}

var memSearchCmd = &cobra.Command{
	Use:   "search [query]",
	Short: "Search memory entries",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		entries := loadMem(cmd.Context())
		query := strings.ToLower(strings.Join(args, " "))
		if len(entries) == 0 {
			cmd.Println("(no entries)")
			return nil
		}
		matches := 0
		for _, e := range entries {
			if strings.Contains(strings.ToLower(e.Content), query) || strings.Contains(strings.ToLower(e.Source), query) {
				fmt.Fprintf(cmd.OutOrStdout(), "%s: %s\n", e.ID, e.Content)
				matches++
			}
		}
		if matches == 0 {
			cmd.Println("(no matches)")
		}
		return nil
	},
}

var memClearCmd = &cobra.Command{
	Use:   "clear",
	Short: "Clear all memory entries",
	RunE: func(cmd *cobra.Command, args []string) error {
		confirm, _ := cmd.Flags().GetBool("yes")
		if !confirm {
			cmd.Print("Type 'yes' to confirm clearing all memory: ")
			var ans string
			fmt.Scanln(&ans)
			if ans != "yes" {
				cmd.Println("cancelled")
				return nil
			}
		}
		return saveJSON(memDBPath, memFile{Entries: []memEntry{}})
	},
}

var memCountCmd = &cobra.Command{
	Use:   "count",
	Short: "Count memory entries",
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Fprintf(cmd.OutOrStdout(), "%d entries\n", len(loadMem(cmd.Context())))
		return nil
	},
}

type memEntry struct {
	ID        string    `json:"id"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags,omitempty"`
	Source    string    `json:"source,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type memFile struct {
	Entries []memEntry `json:"entries"`
}

func loadMem(_ context.Context) []memEntry {
	var f memFile
	_ = loadJSON(memDBPath, &f)
	if f.Entries == nil {
		f.Entries = []memEntry{}
	}
	return f.Entries
}

func init() {
	memAddCmd.Flags().String("tags", "", "Comma-separated tags")
	memAddCmd.Flags().String("source", "", "Source identifier")
	memClearCmd.Flags().Bool("yes", false, "Skip confirmation")
	extrasMemoryCmd.AddCommand(memListCmd, memAddCmd, memSearchCmd, memClearCmd, memCountCmd)
}

var extrasCronCmd = &cobra.Command{
	Use:   "cron",
	Short: "Manage scheduled agent tasks",
}

var cronListCmd = &cobra.Command{
	Use:   "list",
	Short: "List scheduled jobs",
	RunE: func(cmd *cobra.Command, args []string) error {
		store := loadCron()
		if len(store.Jobs) == 0 {
			cmd.Println("(no scheduled jobs)")
			return nil
		}
		for _, j := range store.Jobs {
			fmt.Fprintf(cmd.OutOrStdout(), "%s: %s (every %s, %d runs)\n",
				j.Name, j.Prompt, j.Schedule, j.RunCount)
		}
		return nil
	},
}

var cronAddCmd = &cobra.Command{
	Use:   "add [name] [schedule] [prompt]",
	Short: "Add a scheduled job",
	Args:  cobra.MinimumNArgs(3),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := loadCron()
		store.Jobs = append(store.Jobs, cronJob{
			Name:     args[0],
			Schedule: args[1],
			Prompt:   strings.Join(args[2:], " "),
			Enabled:  true,
			LastRun:  time.Time{},
			NextRun:  time.Now().Add(time.Hour),
		})
		return saveJSON(cronDBPath, store)
	},
}

var cronRemoveCmd = &cobra.Command{
	Use:   "remove [name]",
	Short: "Remove a scheduled job",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := loadCron()
		out := store.Jobs[:0]
		for _, j := range store.Jobs {
			if j.Name != args[0] {
				out = append(out, j)
			}
		}
		store.Jobs = out
		return saveJSON(cronDBPath, store)
	},
}

func init() {
	extrasCronCmd.AddCommand(cronListCmd, cronAddCmd, cronRemoveCmd)
}

type cronJob struct {
	Name     string    `json:"name"`
	Schedule string    `json:"schedule"`
	Prompt   string    `json:"prompt"`
	Enabled  bool      `json:"enabled"`
	LastRun  time.Time `json:"last_run"`
	NextRun  time.Time `json:"next_run"`
	RunCount int64     `json:"run_count"`
}

type cronStore struct {
	Jobs []cronJob `json:"jobs"`
}

func loadCron() cronStore {
	var s cronStore
	_ = loadJSON(cronDBPath, &s)
	if s.Jobs == nil {
		s.Jobs = []cronJob{}
	}
	return s
}

var extrasSysinfoCmd = &cobra.Command{
	Use:   "sysinfo",
	Short: "Show system and runtime information",
	RunE: func(cmd *cobra.Command, args []string) error {
		host, _ := os.Hostname()
		out := cmd.OutOrStdout()
		fmt.Fprintf(out, "OS:         %s\n", runtime.GOOS)
		fmt.Fprintf(out, "Arch:       %s\n", runtime.GOARCH)
		fmt.Fprintf(out, "CPUs:       %d\n", runtime.NumCPU())
		fmt.Fprintf(out, "Goroutines: %d\n", runtime.NumGoroutine())
		fmt.Fprintf(out, "Go version: %s\n", runtime.Version())
		fmt.Fprintf(out, "Hostname:   %s\n", host)
		wd, _ := os.Getwd()
		fmt.Fprintf(out, "WorkingDir: %s\n", wd)
		return nil
	},
}

var extrasVersionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show mochi version and feature set",
	RunE: func(cmd *cobra.Command, args []string) error {
		out := cmd.OutOrStdout()
		fmt.Fprintln(out, "mochi extras v2.0.0")
		fmt.Fprintln(out, "")
		fmt.Fprintln(out, "Mochi features beyond crush:")
		fmt.Fprintln(out, "  • Long-term memory store (remember/recall)")
		fmt.Fprintln(out, "  • Cron-based task scheduler")
		fmt.Fprintln(out, "  • Self-critique and security audit tools")
		fmt.Fprintln(out, "  • Plugin registry for extensions")
		fmt.Fprintln(out, "  • Multi-project workspace manager")
		fmt.Fprintln(out, "  • Hermes-style subagent orchestration")
		return nil
	},
}

// loadJSON loads JSON from path into target. Missing file is not an error.
func loadJSON(path string, target any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return json.Unmarshal(b, target)
}

// saveJSON writes target as pretty JSON to path, creating directories as needed.
func saveJSON(path string, target any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(target, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

var _ = context.Background

func randomID() string {
	const hex = "0123456789abcdef"
	b := make([]byte, 16)
	now := time.Now().UnixNano()
	for i := range b {
		b[i] = hex[(now>>(i*4))&0xf]
	}
	return string(b)
}
