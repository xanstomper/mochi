package self

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestApplyUnified(t *testing.T) {
	before := "package main\n\nfunc main() {\n\tprintln(\"old\")\n}\n"
	diff := `--- a/main.go
+++ b/main.go
@@ -1,5 +1,5 @@
 package main
 
 func main() {
-	println("old")
+	println("new")
 }
`

	after, err := applyUnified(before, diff)
	require.NoError(t, err)
	require.Equal(t, "package main\n\nfunc main() {\n\tprintln(\"new\")\n}\n", after)
}

func TestApplyUnifiedRejectsMismatchedHunk(t *testing.T) {
	before := "package main\n\nfunc main() {\n\tprintln(\"current\")\n}\n"
	diff := `--- a/main.go
+++ b/main.go
@@ -1,5 +1,5 @@
 package main
 
 func main() {
-	println("old")
+	println("new")
 }
`

	_, err := applyUnified(before, diff)
	require.Error(t, err)
}

func TestCleanPathRejectsEscape(t *testing.T) {
	root := t.TempDir()
	engine := &Engine{Root: root}

	_, err := engine.cleanPath("../outside.go")
	require.Error(t, err)
}

func TestRollbackRestoresEmptyFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "empty.go")
	require.NoError(t, os.WriteFile(path, nil, 0o644))

	rollback(map[string]snapshot{
		path: {content: nil, exists: true},
	})

	content, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Empty(t, content)
}

func TestRollbackRemovesCreatedFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "created.go")
	require.NoError(t, os.WriteFile(path, []byte("package main\n"), 0o644))

	rollback(map[string]snapshot{
		path: {exists: false},
	})

	_, err := os.Stat(path)
	require.ErrorIs(t, err, os.ErrNotExist)
}
