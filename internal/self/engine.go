package self

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type Patch struct {
	File   string `json:"file"`
	Action string `json:"action"`
	Diff   string `json:"diff"`
}

type Result struct {
	Root    string
	Files   []string
	Output  string
	Elapsed time.Duration
}

type snapshot struct {
	content []byte
	exists  bool
}

type Engine struct {
	Root string
}

func New(root string) (*Engine, error) {
	if root != "" {
		root, err := discoverRoot(root)
		if err != nil {
			return nil, err
		}
		return &Engine{Root: root}, nil
	}

	cwd, err := os.Getwd()
	if err == nil {
		if root, err := discoverRoot(cwd); err == nil {
			return &Engine{Root: root}, nil
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	root, err = discoverRoot(filepath.Dir(exe))
	if err != nil {
		return nil, err
	}
	return &Engine{Root: root}, nil
}

func (e *Engine) Status(ctx context.Context) (Result, error) {
	files, err := trackedGoFiles(e.Root)
	if err != nil {
		return Result{}, err
	}
	out, _ := run(ctx, e.Root, "git", "status", "--short")
	return Result{Root: e.Root, Files: files, Output: strings.TrimSpace(out)}, nil
}

func (e *Engine) ApplyPatchFile(ctx context.Context, patchFile string) (Result, error) {
	start := time.Now()
	patches, err := readPatches(patchFile)
	if err != nil {
		return Result{}, err
	}
	if len(patches) == 0 {
		return Result{}, errors.New("patch file is empty")
	}

	snapshots := make(map[string]snapshot)
	changed := make([]string, 0, len(patches))
	for _, patch := range patches {
		path, err := e.cleanPath(patch.File)
		if err != nil {
			return Result{}, err
		}
		if _, ok := snapshots[path]; !ok {
			b, readErr := os.ReadFile(path)
			if readErr != nil {
				if !errors.Is(readErr, os.ErrNotExist) || patch.Action != "create" {
					return Result{}, readErr
				}
				snapshots[path] = snapshot{exists: false}
			} else {
				snapshots[path] = snapshot{content: b, exists: true}
			}
		}
		if err := apply(path, patch); err != nil {
			rollback(snapshots)
			return Result{}, err
		}
		changed = append(changed, path)
	}

	if err := formatChanged(ctx, e.Root, changed); err != nil {
		rollback(snapshots)
		return Result{}, err
	}
	out, err := e.Rebuild(ctx, "")
	if err != nil {
		rollback(snapshots)
		return Result{}, fmt.Errorf("build failed after patch and rollback was applied: %w\n%s", err, out.Output)
	}
	return Result{Root: e.Root, Files: unique(changed), Output: out.Output, Elapsed: time.Since(start)}, nil
}

func (e *Engine) Rebuild(ctx context.Context, output string) (Result, error) {
	start := time.Now()
	goPath, err := findGo()
	if err != nil {
		return Result{Root: e.Root, Elapsed: time.Since(start)}, err
	}
	args := []string{"build"}
	if output != "" {
		args = append(args, "-o", output)
	}
	args = append(args, ".")
	out, err := run(ctx, e.Root, goPath, args...)
	return Result{Root: e.Root, Output: out, Elapsed: time.Since(start)}, err
}

func discoverRoot(start string) (string, error) {
	start, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		mod := filepath.Join(start, "go.mod")
		b, err := os.ReadFile(mod)
		if err == nil && strings.Contains(string(b), "module github.com/mochi/mochi") {
			return start, nil
		}
		next := filepath.Dir(start)
		if next == start {
			return "", errors.New("could not find MOCHI Go repository root")
		}
		start = next
	}
}

func trackedGoFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == ".git" || name == "tmp" || name == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func readPatches(path string) ([]Patch, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var patches []Patch
	if err := json.Unmarshal(b, &patches); err == nil {
		return patches, nil
	}
	var patch Patch
	if err := json.Unmarshal(b, &patch); err != nil {
		return nil, err
	}
	return []Patch{patch}, nil
}

func (e *Engine) cleanPath(file string) (string, error) {
	if file == "" {
		return "", errors.New("patch file path is empty")
	}
	file = strings.TrimPrefix(filepath.FromSlash(file), string(filepath.Separator))
	path := filepath.Join(e.Root, file)
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(e.Root)
	if err != nil {
		return "", err
	}
	if path != root && !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return "", fmt.Errorf("patch escapes repository root: %s", file)
	}
	return path, nil
}

func apply(path string, patch Patch) error {
	switch patch.Action {
	case "modify":
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		updated, err := applyUnified(string(b), patch.Diff)
		if err != nil {
			return err
		}
		return os.WriteFile(path, []byte(updated), 0o644)
	case "create":
		if patch.Diff == "" {
			return errors.New("create patch requires diff content")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return os.WriteFile(path, []byte(patch.Diff), 0o644)
	case "delete":
		return os.Remove(path)
	default:
		return fmt.Errorf("unknown patch action: %s", patch.Action)
	}
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

func applyUnified(content, diff string) (string, error) {
	lines := strings.Split(content, "\n")
	diffLines := strings.Split(diff, "\n")
	for i := 0; i < len(diffLines); i++ {
		match := hunkHeader.FindStringSubmatch(diffLines[i])
		if match == nil {
			continue
		}
		oldStart := atoi(match[1]) - 1
		var oldBlock []string
		var newBlock []string
		i++
		for ; i < len(diffLines); i++ {
			line := diffLines[i]
			if hunkHeader.MatchString(line) {
				i--
				break
			}
			if line == `\ No newline at end of file` {
				continue
			}
			if line == "" {
				continue
			}
			switch line[0] {
			case ' ':
				oldBlock = append(oldBlock, line[1:])
				newBlock = append(newBlock, line[1:])
			case '-':
				oldBlock = append(oldBlock, line[1:])
			case '+':
				newBlock = append(newBlock, line[1:])
			}
		}
		if oldStart < 0 || oldStart+len(oldBlock) > len(lines) {
			return "", errors.New("patch hunk is outside file bounds")
		}
		current := lines[oldStart : oldStart+len(oldBlock)]
		if strings.Join(current, "\n") != strings.Join(oldBlock, "\n") {
			return "", errors.New("patch hunk does not match current file content")
		}
		updated := make([]string, 0, len(lines)-len(oldBlock)+len(newBlock))
		updated = append(updated, lines[:oldStart]...)
		updated = append(updated, newBlock...)
		updated = append(updated, lines[oldStart+len(oldBlock):]...)
		lines = updated
	}
	return strings.Join(lines, "\n"), nil
}

func formatChanged(ctx context.Context, root string, changed []string) error {
	var goFiles []string
	for _, file := range unique(changed) {
		if strings.HasSuffix(file, ".go") {
			rel, err := filepath.Rel(root, file)
			if err != nil {
				return err
			}
			goFiles = append(goFiles, rel)
		}
	}
	if len(goFiles) == 0 {
		return nil
	}
	goPath, err := findGo()
	if err != nil {
		return err
	}
	if gofmtPath, err := findGofmt(goPath); err == nil {
		args := append([]string{"-w"}, goFiles...)
		_, err := run(ctx, root, gofmtPath, args...)
		if err == nil {
			return nil
		}
	}
	args := append([]string{"fmt"}, goFiles...)
	_, err = run(ctx, root, goPath, args...)
	return err
}

func findGo() (string, error) {
	if path, err := exec.LookPath("go"); err == nil {
		return path, nil
	}
	for _, path := range knownToolPaths("go.exe") {
		if executableFile(path) {
			return path, nil
		}
	}
	return "", errors.New("could not find Go toolchain")
}

func findGofmt(goPath string) (string, error) {
	if path, err := exec.LookPath("gofmt"); err == nil {
		return path, nil
	}
	path := filepath.Join(filepath.Dir(goPath), "gofmt.exe")
	if executableFile(path) {
		return path, nil
	}
	for _, path := range knownToolPaths("gofmt.exe") {
		if executableFile(path) {
			return path, nil
		}
	}
	return "", errors.New("could not find gofmt")
}

func knownToolPaths(name string) []string {
	var paths []string
	if home := os.Getenv("USERPROFILE"); home != "" {
		paths = append(paths, filepath.Join(home, ".local", "go", "extract", "go", "bin", name))
	}
	if home := os.Getenv("HOME"); home != "" {
		paths = append(paths, filepath.Join(home, ".local", "go", "extract", "go", "bin", name))
	}
	paths = append(paths, filepath.Join("C:", "Users", "Ben", ".local", "go", "extract", "go", "bin", name))
	return paths
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func rollback(snapshots map[string]snapshot) {
	for path, snap := range snapshots {
		if !snap.exists {
			_ = os.Remove(path)
			continue
		}
		_ = os.WriteFile(path, snap.content, 0o644)
	}
}

func run(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOEXPERIMENT=greenteagc")
	b, err := cmd.CombinedOutput()
	return string(b), err
}

func unique(files []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, file := range files {
		if seen[file] {
			continue
		}
		seen[file] = true
		out = append(out, file)
	}
	return out
}

func atoi(s string) int {
	var n int
	for _, r := range s {
		n = n*10 + int(r-'0')
	}
	return n
}
