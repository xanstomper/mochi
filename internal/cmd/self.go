package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/mochi/mochi/internal/self"
	"github.com/spf13/cobra"
)

var selfOutput string

var selfCmd = &cobra.Command{
	Use:   "self",
	Short: "Inspect, patch, and rebuild MOCHI from the terminal",
	Long: `Native self-modification controls for the MOCHI Go repository.

The self command keeps MOCHI terminal-first: it inspects the current Go repo,
applies structured diff patches, rebuilds with Go, and rolls back failed patches.`,
}

var selfStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show native self-modification status",
	RunE: func(cmd *cobra.Command, _ []string) error {
		engine, err := self.New("")
		if err != nil {
			return err
		}
		result, err := engine.Status(cmd.Context())
		if err != nil {
			return err
		}
		cmd.Printf("Root: %s\n", result.Root)
		cmd.Printf("Go files: %d\n", len(result.Files))
		if result.Output != "" {
			cmd.Println("Git status:")
			cmd.Println(result.Output)
		}
		return nil
	},
}

var selfApplyCmd = &cobra.Command{
	Use:   "apply <patch.json>",
	Short: "Apply structured self patches, rebuild, and rollback on failure",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		engine, err := self.New("")
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
		defer cancel()
		result, err := engine.ApplyPatchFile(ctx, args[0])
		if err != nil {
			return err
		}
		cmd.Printf("Patched %d file(s) in %s\n", len(result.Files), result.Elapsed.Round(time.Millisecond))
		for _, file := range result.Files {
			cmd.Printf("- %s\n", file)
		}
		return nil
	},
}

var selfRebuildCmd = &cobra.Command{
	Use:   "rebuild",
	Short: "Rebuild MOCHI with the native Go build pipeline",
	RunE: func(cmd *cobra.Command, _ []string) error {
		engine, err := self.New("")
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
		defer cancel()
		result, err := engine.Rebuild(ctx, selfOutput)
		if result.Output != "" {
			cmd.Print(result.Output)
		}
		if err != nil {
			return fmt.Errorf("rebuild failed: %w", err)
		}
		cmd.Printf("Rebuilt MOCHI in %s\n", result.Elapsed.Round(time.Millisecond))
		return nil
	},
}

func init() {
	selfRebuildCmd.Flags().StringVarP(&selfOutput, "output", "o", "", "Build output path")
	selfCmd.AddCommand(selfStatusCmd, selfApplyCmd, selfRebuildCmd)
}
