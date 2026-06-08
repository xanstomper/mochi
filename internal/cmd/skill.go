package cmd

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/mochi/mochi/internal/config"
	"github.com/mochi/mochi/internal/skills"
	"github.com/spf13/cobra"
)

func init() {
	skillCmd.AddCommand(
		skillListCmd,
		skillEnableCmd,
		skillDisableCmd,
		skillInspectCmd,
		skillInstallCmd,
		skillRemoveCmd,
		skillSearchCmd,
	)
	rootCmd.AddCommand(skillCmd)

	skillInstallCmd.Flags().Bool("global", false, "Install to global skills directory")
}

var skillCmd = &cobra.Command{
	Use:   "skill",
	Short: "Manage agent skills",
	Long: `View, enable, disable, install, and remove agent skills.

Skills are SKILL.md files that teach the agent how to handle specific tasks.
They can be built-in, user-created, or installed from remote sources.`,
}

var skillListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List all available skills",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		allSkills := discoverSkillsForCLI(cfg)

		if len(allSkills) == 0 {
			cmd.Println("(no skills found)")
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tVERSION\tSTATUS\tTYPE\tDESCRIPTION")
		fmt.Fprintln(w, "----\t-------\t------\t----\t-----------")

		for _, s := range allSkills {
			status := string(s.LifecycleStatusDisplay())
			typ := "user"
			if s.Builtin {
				typ = "builtin"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
				s.Name, s.VersionDisplay(), status, typ, truncateStr(s.Description, 60))
		}
		return w.Flush()
	},
}

var skillEnableCmd = &cobra.Command{
	Use:   "enable [name]",
	Short: "Enable a skill",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		store := cfg.Config()

		disabled := store.Options.DisabledSkills
		var found bool
		for i, d := range disabled {
			if d == name {
				store.Options.DisabledSkills = append(disabled[:i], disabled[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			cmd.Printf("Skill %s is already enabled\n", name)
			return nil
		}
		if err := cfg.SetConfigField(config.ScopeWorkspace, "options.disabled_skills", store.Options.DisabledSkills); err != nil {
			return fmt.Errorf("saving config: %w", err)
		}
		cmd.Printf("✓ Enabled skill: %s\n", name)
		return nil
	},
}

var skillDisableCmd = &cobra.Command{
	Use:   "disable [name]",
	Short: "Disable a skill",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		store := cfg.Config()

		for _, d := range store.Options.DisabledSkills {
			if d == name {
				cmd.Printf("Skill %s is already disabled\n", name)
				return nil
			}
		}
		store.Options.DisabledSkills = append(store.Options.DisabledSkills, name)
		if err := cfg.SetConfigField(config.ScopeWorkspace, "options.disabled_skills", store.Options.DisabledSkills); err != nil {
			return fmt.Errorf("saving config: %w", err)
		}
		cmd.Printf("✓ Disabled skill: %s\n", name)
		return nil
	},
}

var skillInspectCmd = &cobra.Command{
	Use:   "inspect [name]",
	Short: "Show full skill details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		allSkills := discoverSkillsForCLI(cfg)

		var found *skills.Skill
		for _, s := range allSkills {
			if s.Name == name {
				found = s
				break
			}
		}
		if found == nil {
			return fmt.Errorf("skill %q not found", name)
		}

		out := cmd.OutOrStdout()
		fmt.Fprintf(out, "Name:        %s\n", found.Name)
		fmt.Fprintf(out, "Version:     %s\n", found.VersionDisplay())
		fmt.Fprintf(out, "Status:      %s\n", found.LifecycleStatusDisplay())
		fmt.Fprintf(out, "Description: %s\n", found.Description)
		fmt.Fprintf(out, "Path:        %s\n", found.SkillFilePath)
		fmt.Fprintf(out, "Builtin:     %v\n", found.Builtin)
		fmt.Fprintf(out, "License:     %s\n", found.License)

		if found.Meta != nil {
			if found.Meta.Author != "" {
				fmt.Fprintf(out, "Author:      %s\n", found.Meta.Author)
			}
			if len(found.Meta.Tags) > 0 {
				fmt.Fprintf(out, "Tags:        %s\n", strings.Join(found.Meta.Tags, ", "))
			}
			if found.Meta.Repository != "" {
				fmt.Fprintf(out, "Repository:  %s\n", found.Meta.Repository)
			}
		}
		if found.Instructions != "" {
			fmt.Fprintln(out, "\nInstructions:")
			fmt.Fprintln(out, found.Instructions)
		}
		return nil
	},
}

var skillInstallCmd = &cobra.Command{
	Use:   "install [source]",
	Short: "Install a skill from a URL or GitHub repo",
	Long: `Install a skill from a URL pointing to a SKILL.md file,
or from a GitHub repository in the format owner/repo.

Examples:
  mochi skill install https://example.com/skills/my-skill/SKILL.md
  mochi skill install my-org/my-skill-repo`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		source := args[0]
		global, _ := cmd.Flags().GetBool("global")

		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		store := cfg.Config()

		var installDir string
		if global {
			installDir = filepath.Join(store.Options.DataDirectory, "skills", "hub")
		} else {
			installDir = filepath.Join(cfg.WorkingDir(), ".agents", "skills")
		}

		if err := os.MkdirAll(installDir, 0o755); err != nil {
			return fmt.Errorf("creating install directory: %w", err)
		}

		skillDir := filepath.Join(installDir, sanitizeSkillName(source))
		if err := os.MkdirAll(skillDir, 0o755); err != nil {
			return fmt.Errorf("creating skill directory: %w", err)
		}

		destPath := filepath.Join(skillDir, skills.SkillFileName)
		content, err := fetchSkillSource(source)
		if err != nil {
			_ = os.RemoveAll(skillDir)
			return fmt.Errorf("fetching skill: %w", err)
		}

		if err := os.WriteFile(destPath, content, 0o644); err != nil {
			_ = os.RemoveAll(skillDir)
			return fmt.Errorf("writing skill file: %w", err)
		}

		skill, err := skills.Parse(destPath)
		if err != nil {
			_ = os.RemoveAll(skillDir)
			return fmt.Errorf("installed skill is invalid: %w", err)
		}
		if err := skill.Validate(); err != nil {
			_ = os.RemoveAll(skillDir)
			return fmt.Errorf("installed skill failed validation: %w", err)
		}

		cmd.Printf("✓ Installed skill: %s v%s\n", skill.Name, skill.VersionDisplay())
		cmd.Printf("  Location: %s\n", destPath)
		return nil
	},
}

var skillRemoveCmd = &cobra.Command{
	Use:   "remove [name]",
	Short: "Permanently remove a user-installed skill",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		allSkills := discoverSkillsForCLI(cfg)

		var found *skills.Skill
		for _, s := range allSkills {
			if s.Name == name && !s.Builtin {
				found = s
				break
			}
		}
		if found == nil {
			return fmt.Errorf("user skill %q not found (cannot remove builtin skills)", name)
		}

		skillDir := filepath.Dir(found.SkillFilePath)
		if err := os.RemoveAll(skillDir); err != nil {
			return fmt.Errorf("removing skill: %w", err)
		}
		cmd.Printf("✓ Removed skill: %s\n", name)
		return nil
	},
}

var skillSearchCmd = &cobra.Command{
	Use:   "search [query]",
	Short: "Search available skills by name or description",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		query := strings.ToLower(args[0])
		cfg, err := config.Init("", "", false)
		if err != nil {
			return err
		}
		allSkills := discoverSkillsForCLI(cfg)

		var matches []*skills.Skill
		for _, s := range allSkills {
			if strings.Contains(strings.ToLower(s.Name), query) ||
				strings.Contains(strings.ToLower(s.Description), query) {
				matches = append(matches, s)
			}
		}

		if len(matches) == 0 {
			cmd.Printf("(no skills matching %q)\n", query)
			return nil
		}

		w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tVERSION\tSTATUS\tDESCRIPTION")
		fmt.Fprintln(w, "----\t-------\t------\t-----------")
		for _, s := range matches {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
				s.Name, s.VersionDisplay(), s.LifecycleStatusDisplay(), truncateStr(s.Description, 60))
		}
		return w.Flush()
	},
}

// --- Helpers ---

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

func sanitizeSkillName(source string) string {
	source = strings.TrimRight(source, "/")
	if strings.Contains(source, "//") {
		parts := strings.Split(source, "/")
		return parts[len(parts)-1]
	}
	return strings.ReplaceAll(strings.ReplaceAll(source, "/", "-"), " ", "_")
}

func fetchSkillSource(source string) ([]byte, error) {
	if strings.Contains(source, "github.com") || (strings.Count(source, "/") == 1 && !strings.Contains(source, ".")) {
		parts := strings.SplitN(source, "/", 2)
		owner, repo := parts[0], strings.TrimSuffix(parts[1], ".git")
		url := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/main/SKILL.md", owner, repo)
		return fetchURL(url)
	}
	return fetchURL(source)
}

func fetchURL(url string) ([]byte, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}
	return io.ReadAll(resp.Body)
}

func discoverSkillsForCLI(cfg *config.ConfigStore) []*skills.Skill {
	workDir := cfg.WorkingDir()
	paths := cfg.Config().Options.SkillsPaths
	if len(paths) == 0 {
		paths = []string{filepath.Join(workDir, ".agents", "skills")}
	}

	allSkills := skills.DiscoverBuiltin()
	builtinNames := make(map[string]bool, len(allSkills))
	for _, s := range allSkills {
		builtinNames[s.Name] = true
	}

	for _, userSkill := range skills.Discover(paths) {
		if !builtinNames[userSkill.Name] {
			allSkills = append(allSkills, userSkill)
		}
	}

	allSkills = skills.Deduplicate(allSkills)
	allSkills = skills.Filter(allSkills, cfg.Config().Options.DisabledSkills)

	sort.Slice(allSkills, func(i, j int) bool {
		return allSkills[i].Name < allSkills[j].Name
	})
	return allSkills
}
