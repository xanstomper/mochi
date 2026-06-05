package canvas

import (
	"fmt"
	"strings"
)

// Renderer is a double-buffered, dirty-tracking terminal renderer.
// Draw functions mutate the back buffer; calling Present diffs the
// back against the front and emits ANSI escape codes for every
// changed cell. The renderer is not safe for concurrent use; it
// is designed to be driven by a single goroutine that owns the
// terminal.
type Renderer struct {
	Front, Back *Framebuffer
	// hideCursor suppresses the final cursor position output.
	hideCursor bool
	// lastX, lastY track the cursor position so the renderer can
	// emit minimal "\x1b[r;cH" sequences.
	lastX, lastY int
}

// NewRenderer creates a renderer with front and back buffers of
// the given size. The front buffer is used as the comparison
// baseline; the back buffer is the one callers draw into.
func NewRenderer(width, height int) *Renderer {
	return &Renderer{
		Front: NewFramebuffer(width, height),
		Back:  NewFramebuffer(width, height),
	}
}

// Resize resizes both front and back buffers. After a resize the
// entire screen is dirty.
func (r *Renderer) Resize(width, height int) {
	r.Front.Resize(width, height)
	r.Back.Resize(width, height)
}

// SetHideCursor controls whether the final cursor-position escape
// is emitted. Useful when the renderer is part of a larger UI
// that manages cursor position independently.
func (r *Renderer) SetHideCursor(hide bool) { r.hideCursor = hide }

// Draw runs fn with the back buffer. The back buffer is NOT
// cleared; callers are expected to overwrite every cell they
// care about. After Present, the back and front are swapped, so
// the next Draw call sees a back buffer containing the previous
// frame's content. Cells the caller does not touch will appear
// unchanged in the diff and will not be re-emitted.
//
// To clear the entire screen, call Clear first.
func (r *Renderer) Draw(fn func(*Framebuffer)) {
	fn(r.Back)
}

// Clear resets the back buffer to all empty cells. Cells that
// are already empty are not marked dirty, so the diff against
// the front buffer will skip them. Use this at the start of a
// frame when the caller wants to repaint the entire screen.
func (r *Renderer) Clear() {
	empty := Empty()
	for i := range r.Back.Cells {
		if !r.Back.Cells[i].Equal(empty) {
			r.Back.Cells[i] = empty
			r.Back.Dirty[i] = true
		}
	}
}

// ClearRect blanks a rectangular region of the back buffer.
func (r *Renderer) ClearRect(x, y, w, h int) {
	r.Back.FillRect(x, y, w, h, Empty())
}

// Present diffs the back buffer against the front buffer and
// returns the ANSI escape sequence to emit. After Present, the
// back and front buffers are swapped so the next Draw call sees
// a back buffer containing the previous frame's content.
func (r *Renderer) Present() string {
	if r.Back.Width != r.Front.Width || r.Back.Height != r.Front.Height {
		// Size mismatch: resize front to match back.
		r.Front.Resize(r.Back.Width, r.Back.Height)
		r.Front.MarkAllDirty()
	}
	var emitted bool
	var b strings.Builder
	w, h := r.Back.Width, r.Back.Height
	// We use a 1-based cursor coordinate for "\x1b[r;cH" so the
	// initial position is (1, 1) and "no move yet" is (0, 0).
	cursorX, cursorY := 0, 0
	// pending colors and attributes; if equal to last emitted
	// value, the renderer skips the SGR code.
	lastFg := RGBA{}
	lastBg := RGBA{}
	lastAttrs := Attrs(0xFF) // sentinel: never emitted yet
	// Continuation cells (wide char second half) are skipped
	// because the leading cell already advanced the cursor.
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			idx := y*w + x
			back := r.Back.Cells[idx]
			front := r.Front.Cells[idx]
			if back.Width == 0 {
				// Continuation cell; skip but make sure the
				// front buffer is also a continuation so the
				// next frame's diff does not re-emit.
				r.Front.Cells[idx] = back
				r.Front.Dirty[idx] = false
				continue
			}
			if back.Equal(front) {
				// Cell value unchanged; no emit needed.
				continue
			}
			// Move cursor if needed.
			if cursorX != x+1 || cursorY != y+1 {
				fmt.Fprintf(&b, "\x1b[%d;%dH", y+1, x+1)
				cursorX = x + 1
				cursorY = y + 1
			}
			// Emit fg/bg/attrs only when changed.
			if back.Fg != lastFg {
				fmt.Fprintf(&b, "\x1b[38;2;%d;%d;%dm", back.Fg.R, back.Fg.G, back.Fg.B)
				lastFg = back.Fg
			}
			if back.Bg != lastBg {
				fmt.Fprintf(&b, "\x1b[48;2;%d;%d;%dm", back.Bg.R, back.Bg.G, back.Bg.B)
				lastBg = back.Bg
			}
			if back.Attrs != lastAttrs {
				b.WriteString(attrsToSGR(back.Attrs))
				lastAttrs = back.Attrs
			}
			// Emit the glyph.
			b.WriteRune(back.Glyph)
			emitted = true
			cursorX++
			if back.Width == 2 {
				// Wide char: advance cursor by one more column.
				cursorX++
			}
			// Copy to front buffer.
			r.Front.Cells[idx] = back
			r.Front.Dirty[idx] = false
			// If wide char, also copy the continuation cell to front.
			if back.Width == 2 && x+1 < w {
				r.Front.Cells[idx+1] = r.Back.Cells[idx+1]
				r.Front.Dirty[idx+1] = false
			}
		}
	}
	if !r.hideCursor && emitted {
		// Position cursor at the bottom-left so subsequent input
		// does not clobber the rendered output. The exact column
		// is intentionally left to the caller; we just emit a
		// "hide cursor" sequence.
		b.WriteString("\x1b[?25l")
	}
	r.lastX, r.lastY = cursorX, cursorY
	// Swap front and back so the next Draw sees the previous
	// frame in the (now) back buffer.
	r.Front, r.Back = r.Back, r.Front
	return b.String()
}

// attrsToSGR converts an Attrs bitmask to a SGR escape sequence.
// The output is empty when attrs is AttrNone so callers can
// concatenate it without producing a useless "\x1b[0m".
func attrsToSGR(a Attrs) string {
	if a == AttrNone {
		return ""
	}
	var b strings.Builder
	b.WriteString("\x1b[")
	first := true
	emit := func(code int) {
		if !first {
			b.WriteByte(';')
		}
		fmt.Fprintf(&b, "%d", code)
		first = false
	}
	if a&AttrBold != 0 {
		emit(1)
	}
	if a&AttrDim != 0 {
		emit(2)
	}
	if a&AttrItalic != 0 {
		emit(3)
	}
	if a&AttrUnderline != 0 {
		emit(4)
	}
	if a&AttrBlink != 0 {
		emit(5)
	}
	if a&AttrReverse != 0 {
		emit(7)
	}
	if a&AttrStrike != 0 {
		emit(9)
	}
	if first {
		// No attributes set; emit a reset.
		b.WriteString("0")
	}
	b.WriteByte('m')
	return b.String()
}
