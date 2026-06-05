// Package canvas provides a cell-based, double-buffered,
// dirty-tracking terminal renderer that complements the
// Ultraviolet-backed renderer used by the rest of Mochi's UI.
//
// # Architecture
//
// The package has four primary types:
//
//   - Cell represents a single terminal cell: a glyph, foreground
//     and background colors, attributes, and a width (1 or 2 for
//     wide characters).
//   - Framebuffer is a 2D grid of cells with per-cell dirty
//     tracking. Setting a cell only marks it dirty if the value
//     changed, so unchanged regions are skipped on render.
//   - Renderer is a double-buffered terminal renderer. Draw
//     functions mutate the back buffer; Present diffs the back
//     against the front and emits the ANSI escape sequence for
//     every changed cell.
//   - AnimationEngine drives a set of tweens and color tweens
//     and calls back to the caller on every update.
//
// # Usage
//
//	r := canvas.NewRenderer(80, 24)
//	for {
//	    r.Draw(func(fb *canvas.Framebuffer) {
//	        fb.SetString(0, 0, "Hello, world!", canvas.Cell{Fg: canvas.Hex("#FF4D94"), Attrs: canvas.AttrBold})
//	    })
//	    fmt.Print(r.Present())
//	    time.Sleep(16 * time.Millisecond)
//	}
package canvas
