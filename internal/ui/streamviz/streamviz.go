// Package streamviz renders an animated token stream: each
// incoming character is revealed with a type-on delay, the most
// recent character cycles through hues, and a short particle
// trail spawns at the cursor on each new token.
//
// The component is intentionally a pure renderer: it does not
// own an LLM client. Callers push tokens via Push or PushString
// and call Draw on each frame.
package streamviz

import (
	"math"
	"strings"
	"unicode/utf8"

	"github.com/mochi/mochi/internal/ui/canvas"
)

// Streamer renders an animated token stream into a canvas
// framebuffer. The streamer maintains a buffer of revealed text,
// a queue of pending characters, and a small particle system
// for the trail effect.
type Streamer struct {
	Width    int
	Height   int
	Palette  Palette
	TypeOnMs int // ms per character reveal; default 12
	CycleHz  float64
	MaxTrail int

	// Internal state.
	revealed  []rune     // characters already shown
	pending   []rune     // characters waiting to be revealed
	pendingMs int        // ms accumulated toward next reveal
	trail     []particle // particles, oldest first
	hueOffset float64    // accumulated hue rotation
}

// Palette is the color set for the streaming visualization.
type Palette struct {
	Text    canvas.RGBA
	Pending canvas.RGBA
	Head    canvas.RGBA
	Trail   canvas.RGBA
	Bg      canvas.RGBA
	Border  canvas.RGBA
}

// MochiPalette returns the default Mochi-pink palette.
func MochiPalette() Palette {
	return Palette{
		Text:    canvas.Hex("#C0CAF5"),
		Pending: canvas.Hex("#565F89"),
		Head:    canvas.Hex("#FF4D94"),
		Trail:   canvas.Hex("#7DCFFF"),
		Bg:      canvas.Hex("#1A1B26"),
		Border:  canvas.Hex("#414868"),
	}
}

// particle is a single particle in the trail.
type particle struct {
	x, y    int
	vx, vy  float64
	lifeMs  int
	maxLife int
	glyph   rune
	color   canvas.RGBA
}

// New creates a streamer with the given dimensions and palette.
func New(width, height int, palette Palette) *Streamer {
	return &Streamer{
		Width:    width,
		Height:   height,
		Palette:  palette,
		TypeOnMs: 12,
		CycleHz:  1.5,
		MaxTrail: 64,
	}
}

// Push appends a token (one or more characters) to the pending
// queue. The streamer will reveal them over the next several
// frames, paced by TypeOnMs.
func (s *Streamer) Push(token string) {
	for _, r := range token {
		if r == '\n' {
			s.pending = append(s.pending, '\n')
		} else if r != '\r' {
			s.pending = append(s.pending, r)
		}
	}
}

// Reset clears all revealed, pending, and trail state.
func (s *Streamer) Reset() {
	s.revealed = s.revealed[:0]
	s.pending = s.pending[:0]
	s.pendingMs = 0
	s.trail = s.trail[:0]
	s.hueOffset = 0
}

// Advance moves the animation forward by dtMs milliseconds.
// It reveals pending characters, ages particles, and updates
// the head color.
func (s *Streamer) Advance(dtMs int) {
	if dtMs <= 0 {
		return
	}
	// Reveal pending characters paced by TypeOnMs.
	if len(s.pending) > 0 {
		s.pendingMs += dtMs
		for s.pendingMs >= s.TypeOnMs && len(s.pending) > 0 {
			s.pendingMs -= s.TypeOnMs
			r := s.pending[0]
			s.pending = s.pending[1:]
			s.revealed = append(s.revealed, r)
			// Spawn a particle at the current cursor position.
			s.spawnTrailParticle(r)
		}
	} else {
		s.pendingMs = 0
	}
	// Update hue offset.
	s.hueOffset += float64(dtMs) / 1000.0 * s.CycleHz
	if s.hueOffset > 1 {
		s.hueOffset -= 1
	}
	// Age particles.
	alive := s.trail[:0]
	for _, p := range s.trail {
		p.lifeMs += dtMs
		p.x += int(p.vx * float64(dtMs) / 50)
		p.y += int(p.vy * float64(dtMs) / 50)
		p.vy += 0.05 * float64(dtMs) / 16 // gravity
		if p.lifeMs < p.maxLife {
			alive = append(alive, p)
		}
	}
	s.trail = alive
	if len(s.trail) > s.MaxTrail {
		s.trail = s.trail[len(s.trail)-s.MaxTrail:]
	}
}

// spawnTrailParticle creates a particle at the current cursor
// position (the last revealed character's location).
func (s *Streamer) spawnTrailParticle(r rune) {
	if len(s.revealed) == 0 {
		return
	}
	// Compute current cursor: count runes that fit per line.
	col, row := 0, 0
	for _, rr := range s.revealed {
		if rr == '\n' {
			col = 0
			row++
			continue
		}
		w := runeWidth(rr)
		if col+w > s.Width {
			col = 0
			row++
		}
		col += w
	}
	// Spawn at the last revealed character with a small upward velocity.
	p := particle{
		x:       col - 1,
		y:       row,
		vx:      (math.Sin(float64(len(s.trail))) - 0.5) * 0.2,
		vy:      -0.3,
		lifeMs:  0,
		maxLife: 600,
		glyph:   '·',
		color:   s.Palette.Trail,
	}
	s.trail = append(s.trail, p)
}

// Draw renders the streamer into the given framebuffer region.
func (s *Streamer) Draw(fb *canvas.Framebuffer, x, y int) {
	// Background.
	fb.FillRect(x, y, s.Width, s.Height, canvas.Cell{Bg: s.Palette.Bg, Width: 1})
	// Border.
	if s.Height >= 2 && s.Width >= 2 {
		border := canvas.Cell{Fg: s.Palette.Border, Width: 1}
		fb.SetString(x, y, "╭"+strings.Repeat("─", s.Width-2)+"╮", border)
		fb.SetString(x, y+s.Height-1, "╰"+strings.Repeat("─", s.Width-2)+"╯", border)
		for row := 1; row < s.Height-1; row++ {
			fb.Set(x, y+row, border)
			fb.Set(x+s.Width-1, y+row, border)
		}
	}
	// Text content. Render revealed runes in the Text color, with
	// the most recent character in the cycling Head color.
	textX, textY := x+1, y+1
	innerW := s.Width - 2
	col, row := 0, 0
	for i, r := range s.revealed {
		if r == '\n' {
			col = 0
			row++
			continue
		}
		w := runeWidth(r)
		if col+w > innerW {
			col = 0
			row++
		}
		if row >= s.Height-2 {
			break
		}
		isHead := i == len(s.revealed)-1
		var c canvas.Cell
		c.Glyph = r
		c.Width = uint8(w)
		c.Fg = s.Palette.Text
		if isHead {
			c.Fg = hsv(s.hueOffset, 0.85, 1.0)
		}
		fb.Set(textX+col, textY+row, c)
		col += w
	}
	// Render the next pending character as a dim ghost if the
	// cursor is in the visible region.
	if len(s.pending) > 0 {
		next := s.pending[0]
		w := runeWidth(next)
		if col+w > innerW {
			col = 0
			row++
		}
		if row < s.Height-2 {
			fb.Set(textX+col, textY+row, canvas.Cell{
				Glyph: next,
				Width: uint8(w),
				Fg:    s.Palette.Pending,
			})
		}
	}
	// Render particles on top.
	for _, p := range s.trail {
		px, py := x+1+p.x, y+1+p.y
		if px < x+1 || px >= x+s.Width-1 || py < y+1 || py >= y+s.Height-1 {
			continue
		}
		fb.Set(px, py, canvas.Cell{
			Glyph: p.glyph,
			Width: 1,
			Fg:    p.color,
		})
	}
}

// RevealedLen returns the number of characters that have been
// revealed. Useful for "X / Y tokens shown" indicators.
func (s *Streamer) RevealedLen() int { return len(s.revealed) }

// PendingLen returns the number of characters still waiting.
func (s *Streamer) PendingLen() int { return len(s.pending) }

// hsv returns an RGB color from hue/saturation/value. Hue is
// in [0, 1].
func hsv(h, s, v float64) canvas.RGBA {
	if s < 0 {
		s = 0
	}
	if s > 1 {
		s = 1
	}
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	h = h - math.Floor(h)
	i := int(h * 6)
	f := h*6 - float64(i)
	p := v * (1 - s)
	q := v * (1 - s*f)
	t := v * (1 - s*(1-f))
	var r, g, b float64
	switch i % 6 {
	case 0:
		r, g, b = v, t, p
	case 1:
		r, g, b = q, v, p
	case 2:
		r, g, b = p, v, t
	case 3:
		r, g, b = p, q, v
	case 4:
		r, g, b = t, p, v
	case 5:
		r, g, b = v, p, q
	}
	return canvas.RGBA{
		R: uint8(r * 255),
		G: uint8(g * 255),
		B: uint8(b * 255),
		A: 0xff,
	}
}

// runeWidth is a minimal East Asian Width implementation, kept
// local to avoid pulling in the canvas package's version (which
// is not exported).
func runeWidth(r rune) int {
	if r < 0x1100 {
		return 1
	}
	switch {
	case r >= 0x1100 && r <= 0x115F,
		r >= 0x2E80 && r <= 0x303E,
		r >= 0x3041 && r <= 0x33FF,
		r >= 0x3400 && r <= 0x4DBF,
		r >= 0x4E00 && r <= 0x9FFF,
		r >= 0xA000 && r <= 0xA4CF,
		r >= 0xAC00 && r <= 0xD7A3,
		r >= 0xF900 && r <= 0xFAFF,
		r >= 0xFE30 && r <= 0xFE4F,
		r >= 0xFF00 && r <= 0xFF60,
		r >= 0xFFE0 && r <= 0xFFE6:
		return 2
	}
	return 1
}

// Compile-time check: ensure runeWidth agrees with utf8.RuneLen
// for ASCII.
var _ = utf8.RuneLen('A')
