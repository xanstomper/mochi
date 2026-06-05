package statusbar

import (
	"strings"
	"testing"

	"github.com/mochi/mochi/internal/ui/canvas"
)

func TestBarIdle(t *testing.T) {
	r := canvas.NewRenderer(80, 1)
	r.Clear()
	bar := New(MochiPalette())
	bar.Draw(r.Back, 0, 0, 80)
	out := r.Present()
	// Idle state should show the spinner and the "idle" label.
	if !strings.Contains(out, "idle") {
		t.Errorf("expected 'idle' label in output, got %q", out)
	}
	// Should have background color set.
	if !strings.Contains(out, "\x1b[48;2;26;27;38m") {
		t.Errorf("expected background color, got %q", out)
	}
}

func TestBarWithStatus(t *testing.T) {
	r := canvas.NewRenderer(120, 1)
	r.Clear()
	bar := New(MochiPalette())
	bar.SetStatus(Status{
		State:     StateThinking,
		Model:     "claude-3-5-sonnet",
		Provider:  "anthropic",
		Tokens:    1234,
		LatencyMs: 230,
		Cost:      0.0123,
	})
	bar.Draw(r.Back, 0, 0, 120)
	out := r.Present()
	for _, want := range []string{"thinking", "claude-3-5-sonnet", "anthropic", "1,234", "230ms", "$0.0123"} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in output, got %q", want, out)
		}
	}
}

func TestBarStateTransition(t *testing.T) {
	bar := New(MochiPalette())
	bar.SetState(StateIdle)
	if bar.status.State != StateIdle {
		t.Error("idle state not set")
	}
	bar.SetState(StateThinking)
	if bar.status.State != StateThinking {
		t.Error("thinking state not set")
	}
	// Advance should trigger the color tween.
	bar.Advance(0.05)
	bar.Advance(0.05)
	bar.Advance(0.05)
	bar.Advance(0.05)
	if bar.anim.ColorTween("state") != nil {
		t.Error("color tween should be done after 0.2s")
	}
}

func TestFormatInt(t *testing.T) {
	cases := []struct {
		in   int
		want string
	}{
		{0, "0"},
		{1, "1"},
		{999, "999"},
		{1000, "1,000"},
		{12345, "12,345"},
		{1234567, "1,234,567"},
		{-1234, "-1,234"},
	}
	for _, c := range cases {
		if got := formatInt(c.in); got != c.want {
			t.Errorf("formatInt(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSpinnerRunes(t *testing.T) {
	// Each state should return a non-empty rune pool.
	states := []State{
		StateIdle, StateInitializing, StateThinking, StateExecuting,
		StateAwaiting, StateStreaming, StateSuccess, StateError,
	}
	for _, s := range states {
		r := spinnerRunes(s)
		if len(r) == 0 {
			t.Errorf("state %d has empty spinner pool", s)
		}
	}
}
