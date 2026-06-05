package projects

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Project struct {
	Path         string    `json:"path"`
	DataDir      string    `json:"data_dir"`
	LastAccessed time.Time `json:"last_accessed"`
}

type record struct {
	Path         string    `json:"path"`
	DataDir      string    `json:"data_dir"`
	LastAccessed time.Time `json:"last_accessed"`
}

var (
	mu      sync.RWMutex
	indexes = map[string]*indexFile{}
)

type indexFile struct {
	path     string
	Projects []record `json:"projects"`
}

func indexFileFor(dataDir string) *indexFile {
	idx := filepath.Join(dataDir, "projects.json")
	return &indexFile{path: idx}
}

func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

func load(idx *indexFile) error {
	b, err := os.ReadFile(idx.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return json.Unmarshal(b, &idx.Projects)
}

func save(idx *indexFile) error {
	if err := ensureDir(filepath.Dir(idx.path)); err != nil {
		return err
	}
	b, err := json.MarshalIndent(idx.Projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(idx.path, b, 0o644)
}

func globalDataDir() string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "mochi")
}

func List() ([]Project, error) {
	mu.Lock()
	defer mu.Unlock()
	idx := indexFileFor(globalDataDir())
	if err := load(idx); err != nil {
		return nil, err
	}
	out := make([]Project, 0, len(idx.Projects))
	for _, r := range idx.Projects {
		out = append(out, Project{
			Path:         r.Path,
			DataDir:      r.DataDir,
			LastAccessed: r.LastAccessed,
		})
	}
	return out, nil
}

func Track(path, dataDir string) error {
	mu.Lock()
	defer mu.Unlock()
	idx := indexFileFor(globalDataDir())
	if err := load(idx); err != nil {
		return err
	}
	now := time.Now()
	found := false
	for i, r := range idx.Projects {
		if r.Path == path {
			idx.Projects[i].LastAccessed = now
			idx.Projects[i].DataDir = dataDir
			found = true
			break
		}
	}
	if !found {
		idx.Projects = append(idx.Projects, record{
			Path:         path,
			DataDir:      dataDir,
			LastAccessed: now,
		})
	}
	return save(idx)
}

func Forget(path string) error {
	mu.Lock()
	defer mu.Unlock()
	idx := indexFileFor(globalDataDir())
	if err := load(idx); err != nil {
		return err
	}
	for i, r := range idx.Projects {
		if r.Path == path {
			idx.Projects = append(idx.Projects[:i], idx.Projects[i+1:]...)
			return save(idx)
		}
	}
	return nil
}

func Register(path, dataDir string) error {
	return Track(path, dataDir)
}
