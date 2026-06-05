package streamviz

import (
	"regexp"
	"testing"

	"github.com/mochi/mochi/internal/ui/canvas"
)

// stripANSI removes all ANSI escape sequences from a string so
// tests can assert on the visible characters.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]`)

func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

func TestStreamerPushAndReveal(t *testing.T) {
	s := New(40, 5, MochiPalette())
	s.Push("Hello, world!")
	if s.PendingLen() != 13 {
		t.Errorf("expected 13 pending, got %d", s.PendingLen())
	}
	if s.RevealedLen() != 0 {
		t.Errorf("expected 0 revealed initially, got %d", s.RevealedLen())
	}
	// 13 chars * 12ms = 156ms
	s.Advance(160)
	if s.PendingLen() != 0 {
		t.Errorf("expected 0 pending after full reveal, got %d", s.PendingLen())
	}
	if s.RevealedLen() != 13 {
		t.Errorf("expected 13 revealed, got %d", s.RevealedLen())
	}
}

func TestStreamerPacing(t *testing.T) {
	s := New(40, 5, MochiPalette())
	s.TypeOnMs = 100
	s.Push("Hi")
	s.Advance(50) // half a reveal period
	if s.RevealedLen() != 0 {
		t.Errorf("expected 0 revealed at 50ms, got %d", s.RevealedLen())
	}
	s.Advance(50) // 100ms total: 1 char
	if s.RevealedLen() != 1 {
		t.Errorf("expected 1 revealed at 100ms, got %d", s.RevealedLen())
	}
	s.Advance(100) // 200ms total: 2 chars
	if s.RevealedLen() != 2 {
		t.Errorf("expected 2 revealed at 200ms, got %d", s.RevealedLen())
	}
}

func TestStreamerReset(t *testing.T) {
	s := New(40, 5, MochiPalette())
	s.Push("test")
	s.Advance(100)
	if s.RevealedLen() == 0 {
		t.Fatal("expected reveals before reset")
	}
	s.Reset()
	if s.RevealedLen() != 0 || s.PendingLen() != 0 {
		t.Error("reset should clear both revealed and pending")
	}
}

func TestStreamerDraw(t *testing.T) {
	r := canvas.NewRenderer(40, 5)
	r.Clear()
	s := New(38, 3, MochiPalette())
	s.Push("Hello")
	s.Advance(200) // fully reveal "Hello"
	s.Draw(r.Back, 1, 1)
	out := r.Present()
	stripped := stripANSI(out)
	if !contains(stripped, "Hello") {
		t.Errorf("expected 'Hello' in output, got stripped=%q", stripped)
	}
}

func TestStreamerWordWrap(t *testing.T) {
	s := New(10, 5, MochiPalette())
	s.TypeOnMs = 0
	s.Push("This is a long line that should wrap")
	s.Advance(1000)
	// After reveal, the text should wrap. We can't easily assert
	// the exact layout, but we can confirm the reveal completed.
	if s.RevealedLen() != len("This is a long line that should wrap") {
		t.Errorf("expected full reveal, got %d", s.RevealedLen())
	}
}

func TestHSV(t *testing.T) {
	// Pure red is hue=0, sat=1, val=1 → (255, 0, 0).
	red := hsv(0, 1, 1)
	if red.R < 250 || red.G > 5 || red.B > 5 {
		t.Errorf("hsv(0,1,1) = %+v, want ~red", red)
	}
	// Pure green is hue=1/3 → (0, 255, 0).
	green := hsv(1.0/3.0, 1, 1)
	if green.G < 250 || green.R > 5 || green.B > 5 {
		t.Errorf("hsv(1/3,1,1) = %+v, want ~green", green)
	}
	// Pure blue is hue=2/3 → (0, 0, 255).
	blue := hsv(2.0/3.0, 1, 1)
	if blue.B < 250 || blue.R > 5 || blue.G > 5 {
		t.Errorf("hsv(2/3,1,1) = %+v, want ~blue", blue)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
