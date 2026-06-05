package canvas

import "strings"

// Framebuffer is a 2D grid of cells with per-cell dirty tracking.
// A framebuffer is owned by a single renderer; sharing it across
// goroutines is the caller's responsibility.
type Framebuffer struct {
	Width, Height int
	Cells         []Cell
	Dirty         []bool
}

// NewFramebuffer allocates a framebuffer of the given size filled
// with empty cells. Every cell starts dirty so the first render
// produces output for the whole screen.
func NewFramebuffer(width, height int) *Framebuffer {
	if width < 0 {
		width = 0
	}
	if height < 0 {
		height = 0
	}
	fb := &Framebuffer{
		Width:  width,
		Height: height,
		Cells:  make([]Cell, width*height),
		Dirty:  make([]bool, width*height),
	}
	for i := range fb.Dirty {
		fb.Dirty[i] = true
	}
	return fb
}

// Resize changes the framebuffer dimensions. Cells that fit inside
// both the old and new dimensions are preserved; everything else is
// reset to empty. After a resize, the entire framebuffer is marked
// dirty so the renderer emits a full repaint.
func (fb *Framebuffer) Resize(width, height int) {
	if width == fb.Width && height == fb.Height {
		return
	}
	old := fb.Cells
	oldW, oldH := fb.Width, fb.Height
	fb.Width = width
	fb.Height = height
	fb.Cells = make([]Cell, width*height)
	fb.Dirty = make([]bool, width*height)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if x < oldW && y < oldH {
				fb.Cells[y*width+x] = old[y*oldW+x]
			} else {
				fb.Cells[y*width+x] = Empty()
			}
			fb.Dirty[y*width+x] = true
		}
	}
}

// In returns the cell at (x, y) and whether the coordinates are
// inside the framebuffer. The cell value is returned by value so
// the caller can read it without copying; mutating it has no
// effect on the framebuffer — use Set for that.
func (fb *Framebuffer) In(x, y int) (Cell, bool) {
	if x < 0 || y < 0 || x >= fb.Width || y >= fb.Height {
		return Cell{}, false
	}
	return fb.Cells[y*fb.Width+x], true
}

// Set writes a cell at (x, y). If the new cell differs from the
// existing one, the cell is marked dirty. Coordinates outside the
// framebuffer are silently ignored.
func (fb *Framebuffer) Set(x, y int, c Cell) {
	if x < 0 || y < 0 || x >= fb.Width || y >= fb.Height {
		return
	}
	idx := y*fb.Width + x
	if !fb.Cells[idx].Equal(c) {
		fb.Cells[idx] = c
		fb.Dirty[idx] = true
	}
}

// SetString writes a string at (x, y) using the cell's colors and
// attributes for every rune. The string is truncated at the right
// edge of the framebuffer. Wide characters (CJK) consume two
// columns: the second column is written as a zero-width placeholder
// cell so the next SetString call at the same x will continue
// correctly.
func (fb *Framebuffer) SetString(x, y int, s string, style Cell) {
	col := x
	for _, r := range s {
		if col >= fb.Width || y < 0 || y >= fb.Height {
			return
		}
		if r == '\n' {
			return
		}
		w := runeWidth(r)
		c := style
		c.Glyph = r
		c.Width = uint8(w)
		fb.Set(col, y, c)
		col += w
		if w == 2 {
			// Mark the trailing cell as a continuation.
			fb.Set(col, y, Cell{Width: 0})
		}
	}
}

// FillRect fills a rectangular region with the given cell. The
// fill is clipped to the framebuffer bounds. Every cell in the
// region is marked dirty.
func (fb *Framebuffer) FillRect(x, y, w, h int, c Cell) {
	if w <= 0 || h <= 0 {
		return
	}
	for j := 0; j < h; j++ {
		cy := y + j
		if cy < 0 || cy >= fb.Height {
			continue
		}
		for i := 0; i < w; i++ {
			cx := x + i
			if cx < 0 || cx >= fb.Width {
				continue
			}
			fb.Set(cx, cy, c)
		}
	}
}

// DrawBox draws a single-line box border around the rectangle
// (x, y, w, h) using the given cell style. The border is drawn with
// Unicode box-drawing characters. If the rectangle is smaller than
// 2x2, the function is a no-op.
func (fb *Framebuffer) DrawBox(x, y, w, h int, c Cell) {
	if w < 2 || h < 2 {
		return
	}
	top := string([]rune{'─'})
	bot := top
	left := '│'
	right := '╮'
	_ = right
	_ = bot
	_ = left
	fb.SetString(x, y, strings.Repeat("─", w-2)+"╮", c) //nolint
	fb.SetString(x, y+h-1, strings.Repeat("─", w-2)+"╯", c)
	for j := 1; j < h-1; j++ {
		fb.Set(x, y+j, c)
		fb.Cells[(y+j)*fb.Width+x].Glyph = '│'
		fb.Dirty[(y+j)*fb.Width+x] = true
		fb.Set(x+w-1, y+j, c)
		fb.Cells[(y+j)*fb.Width+x+w-1].Glyph = '│'
		fb.Dirty[(y+j)*fb.Width+x+w-1] = true
	}
	_ = top
}

// ClearDirty marks every cell as clean. After a render this is
// called so the next render only emits cells that have changed.
func (fb *Framebuffer) ClearDirty() {
	for i := range fb.Dirty {
		fb.Dirty[i] = false
	}
}

// MarkAllDirty forces the next render to emit every cell, ignoring
// the previous frame. Useful after a theme switch or a size change.
func (fb *Framebuffer) MarkAllDirty() {
	for i := range fb.Dirty {
		fb.Dirty[i] = true
	}
}

// String returns a human-readable dump of the framebuffer. It is
// intended for debugging, not for rendering to a terminal, because
// it emits raw glyphs with no ANSI codes.
func (fb *Framebuffer) String() string {
	var b strings.Builder
	for y := 0; y < fb.Height; y++ {
		for x := 0; x < fb.Width; x++ {
			c := fb.Cells[y*fb.Width+x]
			if c.IsZero() {
				b.WriteRune(' ')
			} else {
				b.WriteRune(c.Glyph)
			}
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// runeWidth is a minimal implementation of the East Asian Width
// property. It returns 2 for runes in the CJK ranges and the
// common full-width block, and 1 for everything else. This is
// not a complete implementation but covers the common cases that
// appear in TUI art and user input.
func runeWidth(r rune) int {
	if r < 0x1100 {
		return 1
	}
	switch {
	case r >= 0x1100 && r <= 0x115F, // Hangul Jamo
		r >= 0x2E80 && r <= 0x303E,   // CJK Radicals
		r >= 0x3041 && r <= 0x33FF,   // Hiragana, Katakana, CJK
		r >= 0x3400 && r <= 0x4DBF,   // CJK Extension A
		r >= 0x4E00 && r <= 0x9FFF,   // CJK Unified
		r >= 0xA000 && r <= 0xA4CF,   // Yi
		r >= 0xAC00 && r <= 0xD7A3,   // Hangul Syllables
		r >= 0xF900 && r <= 0xFAFF,   // CJK Compatibility
		r >= 0xFE30 && r <= 0xFE4F,   // CJK Compatibility Forms
		r >= 0xFF00 && r <= 0xFF60,   // Fullwidth Forms
		r >= 0xFFE0 && r <= 0xFFE6,   // Fullwidth Signs
		r >= 0x20000 && r <= 0x2FFFD, // CJK Extension B/C/D/E/F
		r >= 0x30000 && r <= 0x3FFFD: // CJK Extension G
		return 2
	}
	return 1
}
