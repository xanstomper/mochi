package styles

import (
	"fmt"
	"image/color"
	"strings"

	"github.com/xanstomper/mofu"
	"github.com/rivo/uniseg"
)

func colorToMOFU(c color.Color) mofu.Color {
	r, g, b, _ := c.RGBA()
	return mofu.RGB(uint8(r>>8), uint8(g>>8), uint8(b>>8))
}

func ForegroundGrad(base mofu.Style, input string, bold bool, color1, color2 color.Color) []string {
	if input == "" {
		return []string{""}
	}
	if len(input) == 1 {
		style := base.Fg(colorToMOFU(color1))
		if bold {
			style = style.Bold()
		}
		return []string{style.Apply(input)}
	}
	var clusters []string
	gr := uniseg.NewGraphemes(input)
	for gr.Next() {
		clusters = append(clusters, string(gr.Runes()))
	}

	for i := range clusters {
		ratio := float64(i) / float64(len(clusters)-1)
		c := mofu.Blend(colorToMOFU(color1), colorToMOFU(color2), ratio)
		style := base.Fg(c)
		if bold {
			style = style.Bold()
		}
		clusters[i] = style.Apply(clusters[i])
	}
	return clusters
}

func ApplyForegroundGrad(base mofu.Style, input string, color1, color2 color.Color) string {
	if input == "" {
		return ""
	}
	var o strings.Builder
	clusters := ForegroundGrad(base, input, false, color1, color2)
	for _, c := range clusters {
		fmt.Fprint(&o, c)
	}
	return o.String()
}

func ApplyBoldForegroundGrad(base mofu.Style, input string, color1, color2 color.Color) string {
	if input == "" {
		return ""
	}
	var o strings.Builder
	clusters := ForegroundGrad(base, input, true, color1, color2)
	for _, c := range clusters {
		fmt.Fprint(&o, c)
	}
	return o.String()
}
