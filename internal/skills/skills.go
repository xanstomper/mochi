// Package skills implements the Agent Skills open standard (v2).
// See https://agentskills.io for the specification.
package skills

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/charlievieth/fastwalk"
	"github.com/mochi/mochi/internal/pubsub"
	"golang.org/x/mod/semver"
	"gopkg.in/yaml.v3"
)

const (
	SkillFileName          = "SKILL.md"
	MaxNameLength          = 64
	MaxDescriptionLength   = 1024
	MaxCompatibilityLength = 500
)

var (
	namePattern    = regexp.MustCompile(`^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$`)
	promptReplacer = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;")

	latestStates   []*SkillState
	latestStatesMu sync.RWMutex
)

// --- Lifecycle types (v2) ---

// LifecycleStatus represents the stability/status of a skill.
type LifecycleStatus string

const (
	LifecycleExperimental LifecycleStatus = "experimental"
	LifecycleStable       LifecycleStatus = "stable"
	LifecycleDeprecated   LifecycleStatus = "deprecated"
	LifecycleArchived     LifecycleStatus = "archived"
)

// Deprecation describes skill deprecation metadata.
type Deprecation struct {
	Message             string `yaml:"message" json:"message"`
	SuggestedReplacement string `yaml:"suggested_replacement" json:"suggested_replacement"`
	Effective           string `yaml:"effective" json:"effective"`
}

// Lifecycle holds skill lifecycle metadata.
type Lifecycle struct {
	Status      LifecycleStatus `yaml:"status" json:"status"`
	Introduced  string          `yaml:"introduced" json:"introduced"`
	Deprecation *Deprecation    `yaml:"deprecation,omitempty" json:"deprecation,omitempty"`
}

// ExtendedMetadata holds extended skill metadata (v2).
type ExtendedMetadata struct {
	Author          string   `yaml:"author,omitempty" json:"author,omitempty"`
	AuthorURL       string   `yaml:"author_url,omitempty" json:"author_url,omitempty"`
	Repository      string   `yaml:"repository,omitempty" json:"repository,omitempty"`
	License         string   `yaml:"license,omitempty" json:"license,omitempty"`
	Tags            []string `yaml:"tags,omitempty" json:"tags,omitempty"`
	Categories      []string `yaml:"categories,omitempty" json:"categories,omitempty"`
	MinMochiVersion string   `yaml:"min_mochi_version,omitempty" json:"min_mochi_version,omitempty"`
	Icon            string   `yaml:"icon,omitempty" json:"icon,omitempty"`
	Version         string   `yaml:"version,omitempty" json:"version,omitempty"` // v1 compat: metadata.version
}

// LifecycleState is the runtime lifecycle state tracked by the curator.
type LifecycleState int

const (
	StateUnknown LifecycleState = iota
	StateFresh
	StateActive
	StateStale
	StateArchived
)

func (s LifecycleState) String() string {
	switch s {
	case StateUnknown:
		return "unknown"
	case StateFresh:
		return "fresh"
	case StateActive:
		return "active"
	case StateStale:
		return "stale"
	case StateArchived:
		return "archived"
	default:
		return "unknown"
	}
}

// Skill represents a parsed SKILL.md file (v2).
type Skill struct {
	Name                   string            `yaml:"name" json:"name"`
	Description            string            `yaml:"description" json:"description"`
	Version                string            `yaml:"version,omitempty" json:"version,omitempty"`                                  // NEW v2: semver
	Lifecycle              *Lifecycle        `yaml:"lifecycle,omitempty" json:"lifecycle,omitempty"`                              // NEW v2
	Meta                   *ExtendedMetadata `yaml:"metadata,omitempty" json:"metadata,omitempty"`                                // NEW v2: extends v1 map
	Metadata               map[string]string `yaml:"-" json:"metadata,omitempty" swaggerignore:"true"`                                 // KEPT for v1 compat
	UserInvocable          bool              `yaml:"user-invocable" json:"user_invocable"`
	DisableModelInvocation bool              `yaml:"disable-model-invocation" json:"disable_model_invocation"`
	License                string            `yaml:"license,omitempty" json:"license,omitempty"`
	Compatibility          string            `yaml:"compatibility,omitempty" json:"compatibility,omitempty"`
	Instructions           string            `yaml:"-" json:"instructions"`
	Path                   string            `yaml:"-" json:"path"`
	SkillFilePath          string            `yaml:"-" json:"skill_file_path"`
	Builtin                bool              `yaml:"-" json:"builtin"`

	// Runtime state (not from file)
	LifecycleState LifecycleState `yaml:"-" json:"lifecycle_state"`     // NEW: curator-managed
	LastUsed       time.Time      `yaml:"-" json:"last_used"`           // NEW: curator-tracked
	UsageCount     int            `yaml:"-" json:"usage_count"`         // NEW: curator-tracked
}

// DiscoveryState represents the outcome of discovering a single skill file.
type DiscoveryState int

const (
	StateNormal DiscoveryState = iota
	StateError
)

// SkillState represents the latest discovery status of a skill file.
type SkillState struct {
	Name  string
	Path  string
	State DiscoveryState
	Err   error
}

// Event is published when skill discovery completes.
type Event struct {
	States []*SkillState
}

var broker = pubsub.NewBroker[Event]()

// SubscribeEvents returns a channel that receives events when skill discovery state changes.
func SubscribeEvents(ctx context.Context) <-chan pubsub.Event[Event] {
	return broker.Subscribe(ctx)
}

// PublishStates publishes a skill discovery event with the given states.
func PublishStates(states []*SkillState) {
	broker.Publish(pubsub.UpdatedEvent, Event{States: cloneStates(states)})
}

func cloneStates(states []*SkillState) []*SkillState {
	if states == nil {
		return nil
	}
	result := make([]*SkillState, len(states))
	for i, s := range states {
		clone := *s
		result[i] = &clone
	}
	return result
}

// GetLatestStates returns the latest discovery states.
func GetLatestStates() []*SkillState {
	latestStatesMu.RLock()
	defer latestStatesMu.RUnlock()
	return cloneStates(latestStates)
}

// SetLatestStates stores the given states in the package-level cache.
func SetLatestStates(states []*SkillState) {
	latestStatesMu.Lock()
	latestStates = cloneStates(states)
	latestStatesMu.Unlock()
}

// VersionDisplay returns the version string or "0.0.0" if unset.
func (s *Skill) VersionDisplay() string {
	if s.Version != "" {
		return s.Version
	}
	return "0.0.0"
}

// LifecycleStatusDisplay returns the lifecycle status or "stable" for v1 legacy skills.
func (s *Skill) LifecycleStatusDisplay() LifecycleStatus {
	if s.Lifecycle != nil && s.Lifecycle.Status != "" {
		return s.Lifecycle.Status
	}
	return LifecycleStable
}

// IsDeprecated returns true if the skill is marked as deprecated.
func (s *Skill) IsDeprecated() bool {
	return s.Lifecycle != nil && s.Lifecycle.Status == LifecycleDeprecated
}

// IsExperimental returns true if the skill is marked as experimental.
func (s *Skill) IsExperimental() bool {
	return s.Lifecycle != nil && s.Lifecycle.Status == LifecycleExperimental
}

// Validate checks if the skill meets spec requirements (v2).
func (s *Skill) Validate() error {
	var errs []error

	if s.Name == "" {
		errs = append(errs, errors.New("name is required"))
	} else {
		if len(s.Name) > MaxNameLength {
			errs = append(errs, fmt.Errorf("name exceeds %d characters", MaxNameLength))
		}
		if !namePattern.MatchString(s.Name) {
			errs = append(errs, errors.New("name must be alphanumeric with hyphens, no leading/trailing/consecutive hyphens"))
		}
		if s.Path != "" && !strings.EqualFold(filepath.Base(s.Path), s.Name) {
			errs = append(errs, fmt.Errorf("name %q must match directory %q", s.Name, filepath.Base(s.Path)))
		}
	}

	if s.Description == "" {
		errs = append(errs, errors.New("description is required"))
	} else if len(s.Description) > MaxDescriptionLength {
		errs = append(errs, fmt.Errorf("description exceeds %d characters", MaxDescriptionLength))
	}

	if len(s.Compatibility) > MaxCompatibilityLength {
		errs = append(errs, fmt.Errorf("compatibility exceeds %d characters", MaxCompatibilityLength))
	}

	// v2 validations
	if s.Version != "" {
		if !semver.IsValid(s.Version) {
			errs = append(errs, fmt.Errorf("version %q is not valid semver", s.Version))
		}
	}

	if s.Lifecycle != nil {
		switch s.Lifecycle.Status {
		case LifecycleExperimental, LifecycleStable, LifecycleDeprecated, LifecycleArchived:
			// valid
		case "":
			// absent = stable for backward compat
		default:
			errs = append(errs, fmt.Errorf("invalid lifecycle status: %q", s.Lifecycle.Status))
		}
		if s.Lifecycle.Deprecation != nil && s.Lifecycle.Status != LifecycleDeprecated {
			errs = append(errs, errors.New("deprecation info requires lifecycle.status=deprecated"))
		}
	}

	if s.Meta != nil && s.Meta.MinMochiVersion != "" {
		if !semver.IsValid(s.Meta.MinMochiVersion) {
			errs = append(errs, fmt.Errorf("min_mochi_version %q is not valid semver", s.Meta.MinMochiVersion))
		}
	}

	return errors.Join(errs...)
}

// Parse parses a SKILL.md file from disk.
func Parse(path string) (*Skill, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	skill, err := ParseContent(content)
	if err != nil {
		return nil, err
	}

	skill.Path = filepath.Dir(path)
	skill.SkillFilePath = path

	return skill, nil
}

// ParseContent parses a SKILL.md from raw bytes.
func ParseContent(content []byte) (*Skill, error) {
	frontmatter, body, err := splitFrontmatter(string(content))
	if err != nil {
		return nil, err
	}

	// Parse into v2 Skill struct
	var skill Skill
	if err := yaml.Unmarshal([]byte(frontmatter), &skill); err != nil {
		return nil, fmt.Errorf("parsing frontmatter: %w", err)
	}

	// Populate v1 Metadata map from v2 Meta for backward compatibility
	if skill.Meta != nil || skill.Version != "" {
		skill.Metadata = make(map[string]string)
		if skill.Meta != nil {
			if skill.Meta.Author != "" {
				skill.Metadata["author"] = skill.Meta.Author
			}
			if skill.Meta.AuthorURL != "" {
				skill.Metadata["author_url"] = skill.Meta.AuthorURL
			}
			if skill.Meta.Repository != "" {
				skill.Metadata["repository"] = skill.Meta.Repository
			}
			if skill.Meta.License != "" {
				skill.Metadata["license"] = skill.Meta.License
			}
			if skill.Meta.MinMochiVersion != "" {
				skill.Metadata["min_mochi_version"] = skill.Meta.MinMochiVersion
			}
			if skill.Meta.Icon != "" {
				skill.Metadata["icon"] = skill.Meta.Icon
			}
			if skill.Meta.Version != "" {
				skill.Metadata["version"] = skill.Meta.Version
			}
			// Tags and Categories are slices, skip for v1 map compat
		}
		if skill.Version != "" {
			skill.Metadata["version"] = skill.Version
		}
	}

	skill.Instructions = strings.TrimSpace(body)

	return &skill, nil
}

func splitComma(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

// splitFrontmatter extracts YAML frontmatter and body from markdown content.
func splitFrontmatter(content string) (frontmatter, body string, err error) {
	content = strings.TrimPrefix(content, "\uFEFF")
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.ReplaceAll(content, "\r", "\n")

	lines := strings.Split(content, "\n")
	start := slices.IndexFunc(lines, func(line string) bool {
		return strings.TrimSpace(line) != ""
	})
	if start == -1 || strings.TrimSpace(lines[start]) != "---" {
		return "", "", errors.New("no YAML frontmatter found")
	}

	endOffset := slices.IndexFunc(lines[start+1:], func(line string) bool {
		return strings.TrimSpace(line) == "---"
	})
	if endOffset == -1 {
		return "", "", errors.New("unclosed frontmatter")
	}
	end := start + 1 + endOffset

	frontmatter = strings.Join(lines[start+1:end], "\n")
	body = strings.Join(lines[end+1:], "\n")
	return frontmatter, body, nil
}

// Discover finds all valid skills in the given paths.
func Discover(paths []string) []*Skill {
	skills, _ := DiscoverWithStates(paths)
	return skills
}

// DiscoverWithStates finds all valid skills in the given paths.
func DiscoverWithStates(paths []string) ([]*Skill, []*SkillState) {
	var skills []*Skill
	var states []*SkillState
	var mu sync.Mutex
	seen := make(map[string]bool)
	addState := func(name, path string, state DiscoveryState, err error) {
		mu.Lock()
		states = append(states, &SkillState{Name: name, Path: path, State: state, Err: err})
		mu.Unlock()
	}

	for _, base := range paths {
		conf := fastwalk.Config{Follow: true, ToSlash: fastwalk.DefaultToSlash()}
		err := fastwalk.Walk(&conf, base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				slog.Warn("Failed to walk skills path entry", "base", base, "path", path, "error", err)
				addState("", path, StateError, err)
				return nil
			}
			if d.IsDir() || d.Name() != SkillFileName {
				return nil
			}
			mu.Lock()
			if seen[path] {
				mu.Unlock()
				return nil
			}
			seen[path] = true
			mu.Unlock()
			skill, err := Parse(path)
			if err != nil {
				slog.Warn("Failed to parse skill file", "path", path, "error", err)
				addState("", path, StateError, err)
				return nil
			}
			if err := skill.Validate(); err != nil {
				slog.Warn("Skill validation failed", "path", path, "error", err)
				addState(skill.Name, path, StateError, err)
				return nil
			}
			slog.Debug("Successfully loaded skill", "name", skill.Name, "path", path, "version", skill.VersionDisplay())
			mu.Lock()
			skills = append(skills, skill)
			mu.Unlock()
			addState(skill.Name, path, StateNormal, nil)
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			slog.Warn("Failed to walk skills path", "path", base, "error", err)
		}
	}

	slices.SortStableFunc(skills, func(a, b *Skill) int {
		if c := strings.Compare(strings.ToLower(a.Path), strings.ToLower(b.Path)); c != 0 {
			return c
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})

	return skills, states
}

// ToPromptXML generates XML for injection into the system prompt.
func ToPromptXML(skills []*Skill) string {
	if len(skills) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("<available_skills>\n")
	for _, s := range skills {
		if s.DisableModelInvocation {
			continue
		}
		sb.WriteString("  <skill>\n")
		fmt.Fprintf(&sb, "    <name>%s</name>\n", escape(s.Name))
		fmt.Fprintf(&sb, "    <description>%s</description>\n", escape(s.Description))
		fmt.Fprintf(&sb, "    <location>%s</location>\n", escape(s.SkillFilePath))
		fmt.Fprintf(&sb, "    <version>%s</version>\n", escape(s.VersionDisplay()))
		if s.Builtin {
			sb.WriteString("    <type>builtin</type>\n")
		}
		if s.LifecycleStatusDisplay() != "" {
			fmt.Fprintf(&sb, "    <status>%s</status>\n", escape(string(s.LifecycleStatusDisplay())))
		}
		sb.WriteString("  </skill>\n")
	}
	sb.WriteString("</available_skills>")
	return sb.String()
}

// FormatInvocation generates XML for a skill when invoked as a user command.
func (s *Skill) FormatInvocation() string {
	var sb strings.Builder
	sb.WriteString("<loaded_skill>\n")
	fmt.Fprintf(&sb, "  <name>%s</name>\n", escape(s.Name))
	fmt.Fprintf(&sb, "  <description>%s</description>\n", escape(s.Description))
	fmt.Fprintf(&sb, "  <location>%s</location>\n", escape(s.SkillFilePath))
	fmt.Fprintf(&sb, "  <version>%s</version>\n", escape(s.VersionDisplay()))
	sb.WriteString("  <instructions>\n")
	sb.WriteString(escape(s.Instructions))
	sb.WriteString("\n  </instructions>\n")
	sb.WriteString("</loaded_skill>")
	return sb.String()
}

func escape(s string) string {
	return promptReplacer.Replace(s)
}

// --- Filtering & Deduplication ---

// Filter removes skills whose names appear in the disabled list.
func Filter(all []*Skill, disabled []string) []*Skill {
	if len(disabled) == 0 {
		return all
	}
	disabledSet := make(map[string]bool, len(disabled))
	for _, name := range disabled {
		disabledSet[name] = true
	}
	result := make([]*Skill, 0, len(all))
	for _, s := range all {
		if !disabledSet[s.Name] {
			result = append(result, s)
		}
	}
	return result
}

// Deduplicate removes duplicate skills by name (last occurrence wins).
func Deduplicate(all []*Skill) []*Skill {
	seen := make(map[string]int, len(all))
	for i, s := range all {
		seen[s.Name] = i
	}
	result := make([]*Skill, 0, len(seen))
	for i, s := range all {
		if seen[s.Name] == i {
			result = append(result, s)
		}
	}
	return result
}

// DeduplicateStates removes duplicate states by name (last occurrence wins).
func DeduplicateStates(all []*SkillState) []*SkillState {
	seen := make(map[string]int, len(all))
	for i, s := range all {
		if s.Name != "" {
			seen[s.Name] = i
		}
	}
	result := make([]*SkillState, 0, len(all))
	for i, s := range all {
		if s.Name == "" || seen[s.Name] == i {
			result = append(result, s)
		}
	}
	return result
}

// ApproxTokenCount estimates tokens (~4 chars per token).
func ApproxTokenCount(s string) int {
	if s == "" {
		return 0
	}
	return (len(s) + 3) / 4
}
