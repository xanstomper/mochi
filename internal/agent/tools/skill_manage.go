package tools

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"charm.land/fantasy"

	"github.com/mochi/mochi/internal/skills"
)

const SkillManageToolName = "skill_manage"

// SkillManageParams defines parameters for the skill management tool.
type SkillManageParams struct {
	// Action is one of: create, list, inspect, disable, enable.
	Action string `json:"action" description:"Action: create, list, inspect"`
	// Name is the skill name (kebab-case).
	Name string `json:"name,omitempty" description:"Skill name in kebab-case (e.g., 'react-testing')"`
	// Description briefly explains what the skill does.
	Description string `json:"description,omitempty" description:"Brief description of the skill's purpose (max 100 chars)"`
	// Workflow is the step-by-step instructions for the skill.
	Workflow string `json:"workflow,omitempty" description:"Step-by-step instructions for the skill workflow"`
	// SkillsDir is the base directory for skills (default: .agents/skills/).
	SkillsDir string `json:"-"` // Injected at construction time
}

//go:embed skill_manage.md
var skillManageDescription string

func NewSkillManageTool(skillsDir string) fantasy.AgentTool {
	return fantasy.NewAgentTool(
		SkillManageToolName,
		skillManageDescription,
		func(ctx context.Context, params SkillManageParams, call fantasy.ToolCall) (fantasy.ToolResponse, error) {
			switch strings.ToLower(params.Action) {
			case "create":
				return handleSkillCreate(ctx, params, skillsDir)
			case "list":
				return handleSkillList(ctx, params, skillsDir)
			case "inspect":
				return handleSkillInspect(ctx, params, skillsDir)
			default:
				return fantasy.NewTextErrorResponse("unknown action: use create, list, or inspect"), nil
			}
		},
	)
}

func handleSkillCreate(ctx context.Context, params SkillManageParams, skillsDir string) (fantasy.ToolResponse, error) {
	if params.Name == "" {
		return fantasy.NewTextErrorResponse("name is required"), nil
	}
	if params.Description == "" {
		return fantasy.NewTextErrorResponse("description is required"), nil
	}
	if params.Workflow == "" {
		return fantasy.NewTextErrorResponse("workflow is required"), nil
	}
	if len(params.Description) > 120 {
		return fantasy.NewTextErrorResponse("description must be under 120 characters"), nil
	}

	// Validate skill name format
	if err := validateSkillName(params.Name); err != nil {
		return fantasy.NewTextErrorResponse(err.Error()), nil
	}

	skillDir := filepath.Join(skillsDir, params.Name)
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		return fantasy.NewTextErrorResponse(fmt.Sprintf("cannot create skill directory: %v", err)), nil
	}

	content := fmt.Sprintf(`---
name: %s
description: "%s"
version: 1.0.0
lifecycle:
  status: stable
user-invocable: false
disable-model-invocation: false
---

# %s

## Workflow
%s
`, params.Name, params.Description, params.Name, params.Workflow)

	skillPath := filepath.Join(skillDir, "SKILL.md")
	if err := os.WriteFile(skillPath, []byte(content), 0o644); err != nil {
		return fantasy.NewTextErrorResponse(fmt.Sprintf("cannot write skill file: %v", err)), nil
	}

	// Validate the skill was written correctly
	skill, err := skills.Parse(skillPath)
	if err != nil {
		_ = os.RemoveAll(skillDir)
		return fantasy.NewTextErrorResponse(fmt.Sprintf("created skill is invalid: %v", err)), nil
	}
	if err := skill.Validate(); err != nil {
		_ = os.RemoveAll(skillDir)
		return fantasy.NewTextErrorResponse(fmt.Sprintf("created skill failed validation: %v", err)), nil
	}

	return fantasy.NewTextResponse(fmt.Sprintf("Created skill %s v1.0.0 at %s", params.Name, skillPath)), nil
}

func handleSkillList(ctx context.Context, params SkillManageParams, skillsDir string) (fantasy.ToolResponse, error) {
	// Discover skills from the skills directory
	allSkills := skills.DiscoverBuiltin()
	if skillsDir != "" {
		userSkills := skills.Discover([]string{skillsDir})
		allSkills = append(allSkills, userSkills...)
	}
	allSkills = skills.Deduplicate(allSkills)

	if len(allSkills) == 0 {
		return fantasy.NewTextResponse("No skills found."), nil
	}

	var result strings.Builder
	result.WriteString("Available skills:\n\n")
	for _, s := range allSkills {
		status := string(s.LifecycleStatusDisplay())
		fmt.Fprintf(&result, "- **%s** v%s (%s): %s\n",
			s.Name, s.VersionDisplay(), status, s.Description)
		if !s.Builtin {
			fmt.Fprintf(&result, "  Location: %s\n", s.SkillFilePath)
		}
	}
	return fantasy.NewTextResponse(result.String()), nil
}

func handleSkillInspect(ctx context.Context, params SkillManageParams, skillsDir string) (fantasy.ToolResponse, error) {
	if params.Name == "" {
		return fantasy.NewTextErrorResponse("name is required for inspect action"), nil
	}

	// Search builtin and user skills
	allSkills := skills.DiscoverBuiltin()
	if skillsDir != "" {
		userSkills := skills.Discover([]string{skillsDir})
		allSkills = append(allSkills, userSkills...)
	}
	allSkills = skills.Deduplicate(allSkills)

	var found *skills.Skill
	for _, s := range allSkills {
		if s.Name == params.Name {
			found = s
			break
		}
	}
	if found == nil {
		return fantasy.NewTextErrorResponse(fmt.Sprintf("skill %q not found", params.Name)), nil
	}

	var result strings.Builder
	fmt.Fprintf(&result, "**%s** v%s (%s)\n", found.Name, found.VersionDisplay(), found.LifecycleStatusDisplay())
	fmt.Fprintf(&result, "Description: %s\n", found.Description)
	fmt.Fprintf(&result, "Location: %s\n", found.SkillFilePath)
	if found.Builtin {
		result.WriteString("Type: builtin\n")
	} else {
		result.WriteString("Type: user\n")
	}
	if found.Instructions != "" {
		fmt.Fprintf(&result, "\nInstructions:\n%s\n", found.Instructions)
	}
	return fantasy.NewTextResponse(result.String()), nil
}

func validateSkillName(name string) error {
	if len(name) > 64 {
		return fmt.Errorf("skill name too long (max 64 chars)")
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return fmt.Errorf("skill name must be lowercase alphanumeric with hyphens only, got %q", name)
		}
	}
	return nil
}
