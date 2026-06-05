// Package canvas provides a cell-based, double-buffered, dirty-tracking
// terminal renderer. It is the foundation for the new Mochi TUI
// rendering layer and complements the existing Ultraviolet-backed
// screen renderer used by the main model.
package canvas

import "fmt"

// RGBA is a 24-bit color with an alpha channel. The alpha channel
// is preserved through the renderer but most terminals ignore it;
// it is included so that composite/blend operations have the
// information they need without re-parsing color values.
type RGBA struct {
	R, G, B, A uint8
}

// RGB builds an opaque RGBA from 8-bit channels.
func RGB(r, g, b uint8) RGBA { return RGBA{R: r, G: g, B: b, A: 0xff} }

// Hex parses a CSS-style "#rrggbb" or "#rgb" string. It panics on
// invalid input: this is a hot path called from style initializers
// and invalid colors indicate a programmer error, not a runtime
// condition that should be papered over.
func Hex(s string) RGBA {
	if len(s) == 0 || s[0] != '#' {
		panic(fmt.Sprintf("canvas: invalid hex color %q", s))
	}
	hex := s[1:]
	var r, g, b uint8
	switch len(hex) {
	case 3:
		fmt.Sscanf(hex, "%1x%1x%1x", &r, &g, &b)
		r = (r << 4) | r
		g = (g << 4) | g
		b = (b << 4) | b
	case 6:
		fmt.Sscanf(hex, "%02x%02x%02x", &r, &g, &b)
	default:
		panic(fmt.Sprintf("canvas: invalid hex color %q", s))
	}
	return RGB(r, g, b)
}

// Lerp linearly interpolates between two colors in straight RGB.
// This is not perceptually uniform but it is fast and good enough
// for short, on-screen transitions.
func (c RGBA) Lerp(o RGBA, t float64) RGBA {
	tt := float32(t)
	return RGBA{
		R: uint8(float32(c.R)*(1-tt) + float32(o.R)*tt),
		G: uint8(float32(c.G)*(1-tt) + float32(o.G)*tt),
		B: uint8(float32(c.B)*(1-tt) + float32(o.B)*tt),
		A: uint8(float32(c.A)*(1-tt) + float32(o.A)*tt),
	}
}

// Attrs is a bitmask of text attributes.
type Attrs uint8

// Attribute bits. Combine with bitwise OR.
const (
	AttrNone      Attrs = 0
	AttrBold      Attrs = 1 << 0
	AttrDim       Attrs = 1 << 1
	AttrItalic    Attrs = 1 << 2
	AttrUnderline Attrs = 1 << 3
	AttrBlink     Attrs = 1 << 4
	AttrReverse   Attrs = 1 << 5
	AttrStrike    Attrs = 1 << 6
)

// Cell is a single terminal cell. Width is the number of columns
// the glyph occupies in the terminal: 1 for ASCII, 2 for CJK and
// most box-drawing characters. A width-2 cell is always the
// "leading" half; the trailing half is a placeholder with Glyph=0
// and Width=0 that the renderer skips.
type Cell struct {
	Glyph rune
	Fg    RGBA
	Bg    RGBA
	Attrs Attrs
	Width uint8 // 0, 1, or 2
}

// Empty is the default cell: a single space, default colors, no
// attributes. It compares equal to a freshly zero-valued Cell.
func Empty() Cell {
	return Cell{Glyph: ' ', Fg: DefaultFg, Bg: DefaultBg, Width: 1}
}

// Equal reports whether two cells render identically. Two cells
// with the same glyph but different colors are not equal.
func (c Cell) Equal(o Cell) bool {
	return c.Glyph == o.Glyph && c.Fg == o.Fg && c.Bg == o.Bg && c.Attrs == o.Attrs && c.Width == o.Width
}

// IsZero reports whether the cell is the zero value, which means
// it has never been written. The renderer treats zero cells as
// transparent placeholders.
func (c Cell) IsZero() bool {
	return c.Glyph == 0 && c.Width == 0
}

// Default foreground and background used when a cell has not been
// explicitly colored. The default foreground is a light gray that
// reads well on both dark and light terminals.
var (
	DefaultFg = RGB(0xc0, 0xc0, 0xc0)
	DefaultBg = RGBA{}
)

// SetFg returns a copy of the cell with the foreground changed.
func (c Cell) SetFg(fg RGBA) Cell { c.Fg = fg; return c }

// SetBg returns a copy of the cell with the background changed.
func (c Cell) SetBg(bg RGBA) Cell { c.Bg = bg; return c }

// SetAttrs returns a copy of the cell with the attributes replaced.
func (c Cell) SetAttrs(a Attrs) Cell { c.Attrs = a; return c }
