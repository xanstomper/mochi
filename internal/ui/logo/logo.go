// Package logo renders the Mochi wordmark, mascots, and the
// compact one-line logo used in the sidebar and status pills.
package logo

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"image/color"
)

// Opts holds configuration for logo rendering.
type Opts struct {
	FieldColor   color.Color
	TitleColorA  color.Color
	TitleColorB  color.Color
	CharmColor   color.Color
	VersionColor color.Color
	Width        int
	Hyper        bool
	Unstable     bool
}

// Mascot selects which ASCII mascot to render.
type Mascot int

const (
	MascotHeart Mascot = iota
	MascotFox
	MascotCat
	MascotSakura
)

// ASCII mascots for status pills, headers, and animations.
const (
	// Heart is the primary Mochi mascot — a block-heart.
	Heart = `  ▄▄▄▄▄▄▄▄ ▄▄▄▄▄▄▄▄
  ███████████ ███████████
  ████████████████████████████
  ████████████████████████████
  ██████████▀██████▀██████████
  ██████████ ██████ ██████████
  ▀▀██████▄████▄▄████▄██████▀▀
      ████████████████████████
        ████████████████████
          ▀▀██████████▀▀
              ▀▀▀▀▀▀`

	// HeartTiny is a one-line heart for status pills.
	HeartTiny = " <3 "

	// Fox is a small ASCII fox mascot.
	Fox = " /\\_/\\ \n( o.o )\n > ^ < "
	// Cat is a small ASCII cat mascot.
	Cat = " /\\_/\\ \n( -.- )\n > \"^"
	// SakuraPetal is a tiny sakura petal for spring motifs.
	SakuraPetal = " . \n / \\ "
)

// MascotArt returns the ASCII art for the requested mascot.
func MascotArt(m Mascot) string {
	switch m {
	case MascotFox:
		return Fox
	case MascotCat:
		return Cat
	case MascotSakura:
		return SakuraPetal
	default:
		return Heart
	}
}

// MochiWordmark is the giant Unicode MOCHI banner rendered as the
// app's wordmark. The characters are double-width box-drawing glyphs
// that look correct in any UTF-8 terminal.
const MochiWordmark = `███╗░░░███╗░█████╗░░░░░░░░█████╗░██╗░░██╗██╗
████║░████║██╔══██╗░░░░░░██╔══██╗██║░░██║██║
██╔██║██╔██║██║░░██║█████╗██║░░╚═╝███████║██║
██║╚██╔╝██║██║░░██║╚════╝██║░░██╗██╔══██║██║
██║░╚═╝░██║╚█████╔╝░░░░░░╚█████╔╝██║░░██║██║
╚═╝░░░░░╚═╝░╚════╝░░░░░░░░╚════╝░╚═╝░░╚═╝╚═╝`

// MochiPink is the primary sakura pink used by the MochiSakura theme.
var MochiPink = lipgloss.Color("#FF4D94")

// MochiDeep is the deep rose used for shadows and borders.
var MochiDeep = lipgloss.Color("#3D1729")

// Render returns the full Mochi wordmark in sakura pink, optionally
// followed by a version string. Width is the minimum terminal width
// in cells; the wordmark needs at least 80 to render without clipping
// its double-width box-drawing characters.
func Render(version string, compact bool, opts Opts) string {
	if opts.Width <= 0 {
		opts.Width = 80
	}
	if opts.Width < 80 {
		opts.Width = 80
	}

	pinkStyle := lipgloss.NewStyle().Foreground(MochiPink).Bold(true)
	rendered := pinkStyle.Render(MochiWordmark)

	if version != "" {
		vStyle := lipgloss.NewStyle().Foreground(opts.VersionColor)
		v := vStyle.Render(" " + version)
		rendered = lipgloss.JoinVertical(lipgloss.Left, rendered, v)
	}

	return rendered
}

// SmallRender returns a compact one-line "Mochi" word for the sidebar.
func SmallRender(width int) string {
	if width <= 0 {
		width = 20
	}
	label := lipgloss.NewStyle().Bold(true).Foreground(MochiPink).Render("Mochi")
	w := ansi.StringWidth(label)
	if w < width {
		label += lipgloss.NewStyle().Render(strings.Repeat(" ", width-w))
	}
	return label
}
