package canvas

import (
	"strings"
	"testing"
)

func TestCellEquality(t *testing.T) {
	a := Cell{Glyph: 'A', Fg: Hex("#FF0000"), Bg: Hex("#000000"), Width: 1}
	b := Cell{Glyph: 'A', Fg: Hex("#FF0000"), Bg: Hex("#000000"), Width: 1}
	if !a.Equal(b) {
		t.Error("expected equal cells to be equal")
	}
	c := a
	c.Fg = Hex("#00FF00")
	if a.Equal(c) {
		t.Error("expected different fg cells to be unequal")
	}
}

func TestHexParsing(t *testing.T) {
	cases := []struct {
		in   string
		want RGBA
	}{
		{"#FF0000", RGB(0xFF, 0x00, 0x00)},
		{"#00FF00", RGB(0x00, 0xFF, 0x00)},
		{"#0000FF", RGB(0x00, 0x00, 0xFF)},
		{"#F0F", RGB(0xFF, 0x00, 0xFF)},
		{"#FFF", RGB(0xFF, 0xFF, 0xFF)},
		{"#000", RGB(0x00, 0x00, 0x00)},
	}
	for _, c := range cases {
		got := Hex(c.in)
		if got != c.want {
			t.Errorf("Hex(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestFramebufferSetAndDirty(t *testing.T) {
	fb := NewFramebuffer(10, 5)
	if !fb.Dirty[0] {
		t.Error("new framebuffer should be fully dirty")
	}
	fb.Set(3, 2, Cell{Glyph: 'X', Width: 1})
	if fb.Cells[2*10+3].Glyph != 'X' {
		t.Error("set failed")
	}
	fb.Set(100, 100, Cell{Glyph: 'O'}) // out of bounds
	// Setting the same cell again should not change dirty state
	// to true, but ClearDirty resets all.
	fb.ClearDirty()
	for i, d := range fb.Dirty {
		if d {
			t.Errorf("cell %d still dirty after ClearDirty", i)
		}
	}
}

func TestRendererEmpty(t *testing.T) {
	r := NewRenderer(5, 3)
	out := r.Present()
	if out != "" {
		t.Errorf("expected empty output for empty renderer, got %q", out)
	}
}

func TestRendererSingleCell(t *testing.T) {
	r := NewRenderer(5, 3)
	r.Clear()
	r.Draw(func(fb *Framebuffer) {
		fb.Set(0, 0, Cell{Glyph: 'H', Fg: Hex("#FF0000"), Width: 1})
	})
	out := r.Present()
	// Should contain: cursor move to 1;1, fg red, glyph 'H'.
	if !strings.Contains(out, "\x1b[1;1H") {
		t.Errorf("expected cursor move in output, got %q", out)
	}
	if !strings.Contains(out, "\x1b[38;2;255;0;0m") {
		t.Errorf("expected red fg in output, got %q", out)
	}
	if !strings.Contains(out, "H") {
		t.Errorf("expected glyph in output, got %q", out)
	}
	// Second frame: clear, draw same cell. After present, the
	// second call should emit no diff because the cell is the
	// same as the front buffer (which was swapped in after the
	// first Present).
	r.Clear()
	r.Draw(func(fb *Framebuffer) {
		fb.Set(0, 0, Cell{Glyph: 'H', Fg: Hex("#FF0000"), Width: 1})
	})
	out2 := r.Present()
	if out2 != "" {
		t.Errorf("expected empty diff on second present, got %q", out2)
	}
}

func TestRendererEmoji(t *testing.T) {
	// Sparkle emoji "✦" is a single-width rune, not wide.
	// Verify it renders correctly.
	r := NewRenderer(10, 1)
	r.Clear()
	r.Draw(func(fb *Framebuffer) {
		fb.SetString(0, 0, "✦✦✦", Cell{Fg: Hex("#FFD700"), Width: 1})
	})
	out := r.Present()
	if !strings.Contains(out, "✦") {
		t.Errorf("expected sparkle in output, got %q", out)
	}
}

func TestTweenValue(t *testing.T) {
	tr := NewTween(0, 100, 1.0, Linear)
	if tr.Value() != 0 {
		t.Errorf("initial value should be 0, got %f", tr.Value())
	}
	tr.Advance(0.5)
	if v := tr.Value(); v < 49 || v > 51 {
		t.Errorf("mid value should be ~50, got %f", v)
	}
	tr.Advance(1.0)
	if !tr.Done {
		t.Error("tween should be done after full duration")
	}
	if tr.Value() != 100 {
		t.Errorf("final value should be 100, got %f", tr.Value())
	}
}

func TestTweenOvershootClamped(t *testing.T) {
	// OutBack overshoots End before settling. After Clamp in
	// Value(), the result must still be within [Start, End].
	tr := NewTween(0, 10, 1.0, OutBack)
	tr.Advance(0.7) // near peak of overshoot
	v := tr.Value()
	if v < 0 || v > 10 {
		t.Errorf("OutBack value should be clamped, got %f", v)
	}
}

func TestColorTween(t *testing.T) {
	ct := NewColorTween(Hex("#000000"), Hex("#FFFFFF"), 1.0, Linear)
	ct.Advance(0.5)
	mid := ct.Value()
	// Midpoint of black and white is roughly (128, 128, 128).
	if mid.R < 120 || mid.R > 135 {
		t.Errorf("expected mid color around gray, got %+v", mid)
	}
}

func TestEasingInQuad(t *testing.T) {
	if v := InQuad(0); v != 0 {
		t.Errorf("InQuad(0) = %f, want 0", v)
	}
	if v := InQuad(1); v != 1 {
		t.Errorf("InQuad(1) = %f, want 1", v)
	}
	if v := InQuad(0.5); v != 0.25 {
		t.Errorf("InQuad(0.5) = %f, want 0.25", v)
	}
}

func TestAnimationEngine(t *testing.T) {
	e := NewAnimationEngine(16 * 1_000_000) // 16ms in ns; we only use seconds
	ct := NewColorTween(Hex("#000"), Hex("#FFF"), 0.5, Linear)
	e.AddColorTween("color", ct)
	if !e.Active() {
		t.Error("engine should be active with one tween")
	}
	e.Advance(0.3)
	if !e.Active() {
		t.Error("engine should still be active mid-tween")
	}
	e.Advance(0.5)
	if e.Active() {
		t.Error("engine should be inactive after tween completes")
	}
}
