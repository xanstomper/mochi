package skills

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Default curator paths
const (
	DefaultCuratorDir        = "curator"
	CuratorUsageFileName     = "skill-usage.json"
	DefaultStalenessSessions = 10
	DefaultArchiveSessions   = 20
)

// CuratorConfig controls curator behavior.
type CuratorConfig struct {
	// Enabled controls whether the curator runs automatically.
	Enabled bool `json:"enabled" yaml:"enabled"`

	// StalenessThreshold is the number of sessions without use before marking stale.
	StalenessThreshold int `json:"staleness_threshold" yaml:"staleness_threshold"`

	// ArchiveGracePeriod is the number of additional sessions stale before archiving.
	ArchiveGracePeriod int `json:"archive_grace_period" yaml:"archive_grace_period"`
}

// DefaultCuratorConfig returns the default curator configuration.
func DefaultCuratorConfig() CuratorConfig {
	return CuratorConfig{
		Enabled:            true,
		StalenessThreshold: DefaultStalenessSessions,
		ArchiveGracePeriod: DefaultArchiveSessions,
	}
}

// SkillUsage tracks per-skill usage for the curator.
type SkillUsage struct {
	Name       string    `json:"name"`
	Version    string    `json:"version"`
	LastUsed   time.Time `json:"last_used"`
	UsageCount int       `json:"usage_count"`
	StaleSince time.Time `json:"stale_since,omitempty"`
	Archived   bool      `json:"archived,omitempty"`
}

// usageDB is a file-backed JSON store for skill usage data.
type usageDB struct {
	mu     sync.Mutex
	path   string
	Skills map[string]*SkillUsage `json:"skills"`
}

func loadUsageDB(dir string) (*usageDB, error) {
	path := filepath.Join(dir, CuratorUsageFileName)
	db := &usageDB{
		path:   path,
		Skills: make(map[string]*SkillUsage),
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return db, nil // fresh DB
		}
		return nil, err
	}

	if err := json.Unmarshal(data, db); err != nil {
		return nil, err
	}
	if db.Skills == nil {
		db.Skills = make(map[string]*SkillUsage)
	}
	return db, nil
}

func (db *usageDB) save() error {
	data, err := json.MarshalIndent(db, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(db.path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(db.path, data, 0o644)
}

func (db *usageDB) recordUsage(name, version string) {
	db.mu.Lock()
	defer db.mu.Unlock()

	u, ok := db.Skills[name]
	if !ok {
		u = &SkillUsage{Name: name}
		db.Skills[name] = u
	}
	u.Version = version
	u.LastUsed = time.Now()
	u.UsageCount++
	u.StaleSince = time.Time{} // reset staleness on use
	u.Archived = false
	_ = db.save()
}

func (db *usageDB) getUsage(name string) *SkillUsage {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.Skills[name]
}

func (db *usageDB) getAllUsage() []*SkillUsage {
	db.mu.Lock()
	defer db.mu.Unlock()
	result := make([]*SkillUsage, 0, len(db.Skills))
	for _, u := range db.Skills {
		result = append(result, u)
	}
	return result
}

// Curator manages skill lifecycle: usage tracking, staleness detection, archival.
type Curator struct {
	mu         sync.Mutex
	usageDB    *usageDB
	cfg        CuratorConfig
	skillsDir  string
	archiveDir string
}

// NewCurator creates a new curator service.
func NewCurator(cfg CuratorConfig, skillsDir, dataDir string) (*Curator, error) {
	curatorDir := filepath.Join(dataDir, DefaultCuratorDir)
	archiveDir := filepath.Join(dataDir, "skills-archive")
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		return nil, err
	}

	db, err := loadUsageDB(curatorDir)
	if err != nil {
		return nil, err
	}

	return &Curator{
		usageDB:    db,
		cfg:        cfg,
		skillsDir:  skillsDir,
		archiveDir: archiveDir,
	}, nil
}

// RecordUsage records that a skill was used in a session.
func (c *Curator) RecordUsage(name, version string) {
	if !c.cfg.Enabled {
		return
	}
	c.usageDB.recordUsage(name, version)
}

// GetUsage returns usage data for a skill.
func (c *Curator) GetUsage(name string) *SkillUsage {
	return c.usageDB.getUsage(name)
}

// GetAllUsage returns usage data for all skills.
func (c *Curator) GetAllUsage() []*SkillUsage {
	return c.usageDB.getAllUsage()
}

// DetectStale returns skills that haven't been used recently.
// A skill is considered stale if its UsageCount == 0 or
// its LastUsed is beyond the staleness threshold (in sessions).
func (c *Curator) DetectStale(sessionCount int, allSkills []*Skill) []*Skill {
	if !c.cfg.Enabled || len(allSkills) == 0 {
		return nil
	}

	threshold := c.cfg.StalenessThreshold
	if threshold <= 0 {
		threshold = DefaultStalenessSessions
	}

	var stale []*Skill
	for _, s := range allSkills {
		if s.Builtin {
			continue // never mark builtins as stale
		}
		usage := c.usageDB.getUsage(s.Name)
		if usage == nil {
			// Never used — skip (fresh skills shouldn't be stale immediately)
			continue
		}
		if sessionCount-usage.UsageCount > threshold {
			stale = append(stale, s)
		}
	}
	return stale
}

// ArchiveSkill moves a skill to the archive directory.
func (c *Curator) ArchiveSkill(skill *Skill) error {
	if skill.Builtin {
		return nil // never archive builtins
	}

	archiveName := skill.Name + "-" + time.Now().Format("2006-01-02")
	dest := filepath.Join(c.archiveDir, archiveName)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}

	// Move SKILL.md to archive
	src := skill.SkillFilePath
	if src == "" {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dest, SkillFileName), data, 0o644); err != nil {
		return err
	}
	// Remove original
	_ = os.Remove(src)

	// Update usage
	c.usageDB.mu.Lock()
	if u, ok := c.usageDB.Skills[skill.Name]; ok {
		u.StaleSince = time.Now()
		u.Archived = true
		_ = c.usageDB.save()
	}
	c.usageDB.mu.Unlock()

	return nil
}
