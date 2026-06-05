package tools

import "testing"

func TestExtractFilePathsFromLS(t *testing.T) {
	text := `internal/
  agent/
    agent.go
    coordinator.go
  cmd/
    root.go
  config/
    config.go
  go.mod
  main.go
  README.md
`
	paths := ExtractFilePathsFromLS(text)
	if len(paths) == 0 {
		t.Fatalf("expected non-empty paths")
	}
	want := []string{"internal/", "agent/", "agent.go", "coordinator.go", "cmd/", "root.go", "config/", "config.go", "go.mod", "main.go", "README.md"}
	if len(paths) != len(want) {
		t.Fatalf("expected %d paths, got %d (%v)", len(want), len(paths), paths)
	}
	for i, w := range want {
		if paths[i] != w {
			t.Errorf("path %d: want %q, got %q", i, w, paths[i])
		}
	}
}

func TestExtractFilePathsFromGrep(t *testing.T) {
	text := `internal/agent/coordinator.go:42:buildAgentModels
internal/agent/agent.go:13:NewCoordinator
./internal/cmd/swarm.go:7:Setup
`
	paths := ExtractFilePathsFromGrep(text)
	want := []string{"internal/agent/coordinator.go", "internal/agent/agent.go", "internal/cmd/swarm.go"}
	if len(paths) != len(want) {
		t.Fatalf("expected %d paths, got %d (%v)", len(want), len(paths), paths)
	}
	for i, w := range want {
		if paths[i] != w {
			t.Errorf("path %d: want %q, got %q", i, w, paths[i])
		}
	}
}
