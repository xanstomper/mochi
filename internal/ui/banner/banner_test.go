package banner

import (
	"strings"
	"testing"

	"github.com/mochi/mochi/internal/ui/canvas"
)

func TestNewBanner(t *testing.T) {
	b := New(40, 8, "", MochiPalette())
	if b.Art == "" {
		t.Error("default wordmark should be set")
	}
	if b.Done() {
		t.Error("new banner should not be done")
	}
}

func TestRevealProgress(t *testing.T) {
	b := New(40, 8, MochiWordmark, MochiPalette())
	if b.Done() {
		t.Error("banner should not be done initially")
	}
	b.Advance(b.RevealMs / 2)
	if b.Done() {
		t.Error("banner should not be done halfway through reveal")
	}
	// At halfway, some cells should be revealed.
	revealedCount := 0
	for _, row := range b.revealed {
		for _, r := range row {
			if r {
				revealedCount++
			}
		}
	}
	if revealedCount == 0 {
		t.Error("expected some cells revealed at halfway")
	}
	b.Advance(b.RevealMs) // well past the end
	if !b.Done() {
		t.Error("banner should be done after full reveal duration")
	}
}

func TestRevealAllCells(t *testing.T) {
	b := New(48, 8, MochiWordmark, MochiPalette())
	b.Advance(b.RevealMs * 2) // well past reveal
	// All non-space, non-shade cells should be revealed.
	lines := strings.Split(MochiWordmark, "\n")
	for y, l := range lines {
		runes := []rune(l)
		for x, r := range runes {
			if r == ' ' || r == '░' {
				continue
			}
			if !b.revealed[y][x] {
				t.Errorf("cell (%d,%d) should be revealed", x, y)
			}
		}
	}
}

func TestDraw(t *testing.T) {
	r := canvas.NewRenderer(48, 8)
	r.Clear()
	b := New(48, 8, MochiWordmark, MochiPalette())
	b.Advance(b.RevealMs * 2) // complete reveal
	b.Draw(r.Back, 0, 0)
	out := r.Present()
	// Should contain bold attribute and pink-ish foreground.
	if !strings.Contains(out, "\x1b[1m") {
		t.Error("expected bold attribute in output")
	}
	// Pink is roughly R~255, G in [60,200], B in [130,230] after
	// gradient + breathing. Look for the bold SGR followed by a
	// pink-ish 38;2 color.
	hasPink := strings.Contains(out, "\x1b[1m\x1b[38;2;255;") ||
		strings.Contains(out, "\x1b[38;2;255;")
	if !hasPink {
		t.Error("expected pink foreground in output")
	}
}

func TestParticlesSpawn(t *testing.T) {
	b := New(40, 8, MochiWordmark, MochiPalette())
	b.Advance(b.RevealMs / 4)
	if len(b.particles) == 0 {
		t.Error("expected particles to spawn during reveal")
	}
	b.Advance(2000) // well past particle lifetime
	if len(b.particles) > 0 {
		t.Errorf("particles should age out, still have %d", len(b.particles))
	}
}
