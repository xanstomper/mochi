// Package banner renders an animated ASCII art banner with a
// gradient sweep reveal, falling particles, and a gentle
// breathing effect on the final state.
//
// The banner is intended to be shown once at startup or on
// demand. It is self-contained: provide the ASCII art (or use
// the Mochi wordmark), the dimensions, and a palette, then
// Advance + Draw each frame.
package banner

import (
	"math"
	"math/rand/v2"
	"strings"

	"github.com/mochi/mochi/internal/ui/canvas"
)

// MochiWordmark is the default Mochi ASCII wordmark. Each line
// is 32 columns wide. The banner expects art where every line
// has the same width.
const MochiWordmark = `███╗░░░███╗░█████╗░░░░░░░░█████╗░██╗░░██╗██╗
████║░████║██╔══██╗░░░░░░██╔══██╗██║░░██║██║
██╔██║██╔██║██║░░██║█████╗██║░░╚═╝███████║██║
██║╚██╔╝██║██║░░██║╚════╝██║░░██╗██╔══██║██║
██║░╚═╝░██║╚█████╔╝░░░░░░╚█████╔╝██║░░██║██║
╚═╝░░░░░╚═╝░╚════╝░░░░░░░░╚════╝░╚═╝░░╚═╝╚═╝`

// Banner animates a reveal of an ASCII art block.
type Banner struct {
	Width     int
	Height    int
	Art       string
	Palette   Palette
	RevealMs  int
	BreatheHz float64

	// Internal state.
	elapsedMs   int
	revealed    [][]bool // per-cell reveal flag, sized Width x Height
	particles   []particle
	breathPhase float64
	rng         *rand.Rand
}

// Palette holds the banner colors.
type Palette struct {
	Start    canvas.RGBA
	End      canvas.RGBA
	Bg       canvas.RGBA
	Glow     canvas.RGBA
	Particle canvas.RGBA
}

// MochiPalette returns the default pink gradient palette.
func MochiPalette() Palette {
	return Palette{
		Start:    canvas.Hex("#FF4D94"),
		End:      canvas.Hex("#FFB3D1"),
		Bg:       canvas.Hex("#1A1B26"),
		Glow:     canvas.Hex("#FFE5F0"),
		Particle: canvas.Hex("#7DCFFF"),
	}
}

// particle is a single falling particle spawned when a cell is
// revealed.
type particle struct {
	x, y    int
	vx, vy  float64
	lifeMs  int
	maxLife int
	glyph   rune
}

// New creates a banner. Width and Height should be at least as
// large as the art's natural dimensions; if smaller, the art
// is clipped.
func New(width, height int, art string, palette Palette) *Banner {
	if art == "" {
		art = MochiWordmark
	}
	b := &Banner{
		Width:     width,
		Height:    height,
		Art:       art,
		Palette:   palette,
		RevealMs:  1500,
		BreatheHz: 0.5,
		rng:       rand.New(rand.NewPCG(0xC0FFEE, 0xBEEF)),
	}
	lines := strings.Split(art, "\n")
	b.revealed = make([][]bool, len(lines))
	for i, l := range lines {
		b.revealed[i] = make([]bool, len([]rune(l)))
	}
	return b
}

// Done reports whether the reveal animation has completed.
// The banner keeps breathing forever; Done is true once the
// reveal has finished.
func (b *Banner) Done() bool {
	return b.elapsedMs >= b.RevealMs
}

// Advance moves the animation forward by dtMs milliseconds.
func (b *Banner) Advance(dtMs int) {
	if dtMs <= 0 {
		return
	}
	b.elapsedMs += dtMs
	b.breathPhase += float64(dtMs) / 1000.0 * b.BreatheHz
	if b.breathPhase > 1 {
		b.breathPhase -= 1
	}
	// Reveal new cells based on a left-to-right sweep.
	lines := strings.Split(b.Art, "\n")
	sweepX := int(float64(b.revealMaxX()) * float64(b.elapsedMs) / float64(b.RevealMs))
	if sweepX > b.revealMaxX() {
		sweepX = b.revealMaxX()
	}
	for y, l := range lines {
		runes := []rune(l)
		for x := 0; x < len(runes) && x < b.Width; x++ {
			if runes[x] == ' ' || runes[x] == '░' {
				continue
			}
			if !b.revealed[y][x] && x <= sweepX {
				b.revealed[y][x] = true
				if y < len(b.revealed) && x < len(b.revealed[y]) {
					b.spawnParticle(x, y)
				}
			}
		}
	}
	// Age particles.
	alive := b.particles[:0]
	for _, p := range b.particles {
		p.lifeMs += dtMs
		p.x += int(p.vx * float64(dtMs) / 30)
		p.y += int(p.vy * float64(dtMs) / 30)
		p.vy += 0.08 * float64(dtMs) / 16
		if p.lifeMs < p.maxLife {
			alive = append(alive, p)
		}
	}
	b.particles = alive
}

// revealMaxX returns the widest line's length.
func (b *Banner) revealMaxX() int {
	max := 0
	for _, l := range strings.Split(b.Art, "\n") {
		if len([]rune(l)) > max {
			max = len([]rune(l))
		}
	}
	return max
}

// spawnParticle emits one or more particles at the given cell.
func (b *Banner) spawnParticle(x, y int) {
	for i := 0; i < 3; i++ {
		p := particle{
			x:       x,
			y:       y,
			vx:      (b.rng.Float64() - 0.5) * 0.6,
			vy:      -0.2 - b.rng.Float64()*0.4,
			lifeMs:  0,
			maxLife: 800 + b.rng.IntN(400),
			glyph:   []rune{'·', '∘', '°', '°'}[b.rng.IntN(4)],
		}
		b.particles = append(b.particles, p)
	}
}

// Draw renders the banner into the framebuffer at (x, y).
func (b *Banner) Draw(fb *canvas.Framebuffer, x, y int) {
	// Background.
	fb.FillRect(x, y, b.Width, b.Height, canvas.Cell{Bg: b.Palette.Bg, Width: 1})
	// Breathing brightness factor in [0.8, 1.0].
	breathe := 0.9 + 0.1*math.Sin(b.breathPhase*2*math.Pi)
	lines := strings.Split(b.Art, "\n")
	for row, l := range lines {
		if y+row >= b.Height {
			break
		}
		runes := []rune(l)
		for col, r := range runes {
			if x+col >= b.Width {
				break
			}
			if r == ' ' {
				continue
			}
			if !b.revealed[row][col] {
				continue
			}
			// Color: gradient from Start to End across columns.
			t := float64(col) / float64(b.revealMaxX())
			c := b.Palette.Start.Lerp(b.Palette.End, t)
			// Apply breathing.
			c = c.Lerp(b.Palette.Glow, (breathe-0.8)*0.5)
			fb.Set(x+col, y+row, canvas.Cell{
				Glyph: r,
				Width: 1,
				Fg:    c,
				Attrs: canvas.AttrBold,
			})
		}
	}
	// Render particles.
	for _, p := range b.particles {
		px, py := x+p.x, y+p.y
		if px < x || px >= x+b.Width || py < y || py >= y+b.Height {
			continue
		}
		fb.Set(px, py, canvas.Cell{
			Glyph: p.glyph,
			Width: 1,
			Fg:    b.Palette.Particle,
		})
	}
}
