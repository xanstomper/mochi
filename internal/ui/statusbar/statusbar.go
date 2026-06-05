// Package statusbar provides an always-visible status bar for
// the new Mochi TUI. It uses the canvas package for rendering
// and supports smooth color transitions when the agent state
// changes (idle → thinking → executing → awaiting → success).
package statusbar

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mochi/mochi/internal/ui/canvas"
)

// State is the high-level agent state shown in the status bar.
type State int

// Agent states. The order matters: transitions use it to pick
// colors and animations.
const (
	StateIdle State = iota
	StateInitializing
	StateThinking
	StateExecuting
	StateAwaiting
	StateStreaming
	StateSuccess
	StateError
)

// String returns a short human-readable label for the state.
func (s State) String() string {
	switch s {
	case StateInitializing:
		return "init"
	case StateThinking:
		return "thinking"
	case StateExecuting:
		return "executing"
	case StateAwaiting:
		return "awaiting"
	case StateStreaming:
		return "streaming"
	case StateSuccess:
		return "done"
	case StateError:
		return "error"
	default:
		return "idle"
	}
}

// Status is the data shown in the status bar. All fields are
// optional; a zero value renders a minimal "idle" bar.
type Status struct {
	State     State
	Model     string  // model name, e.g. "claude-3-5-sonnet"
	Provider  string  // provider name, e.g. "anthropic"
	Tokens    int     // total tokens used in this session
	LatencyMs int     // last request latency in milliseconds
	Cost      float64 // estimated cost in USD
	Message   string  // optional free-form message
}

// Bar is the status bar widget. It is safe to read Status fields
// concurrently; mutations should go through the Set* methods.
type Bar struct {
	mu           sync.RWMutex
	status       Status
	anim         *canvas.AnimationEngine
	spinnerStep  float64
	currentColor canvas.RGBA
	targetColor  canvas.RGBA
	palette      Palette
}

// Palette holds the color tokens used by the status bar. Themes
// can swap a Palette at runtime to retint the bar without
// touching the widget logic.
type Palette struct {
	Idle       canvas.RGBA
	Initial    canvas.RGBA
	Thinking   canvas.RGBA
	Executing  canvas.RGBA
	Awaiting   canvas.RGBA
	Streaming  canvas.RGBA
	Success    canvas.RGBA
	Error      canvas.RGBA
	Label      canvas.RGBA
	Value      canvas.RGBA
	Separator  canvas.RGBA
	Background canvas.RGBA
}

// MochiPalette is the default MochiPink palette: sakura pinks
// for accents, soft grays for text, no harsh reds.
func MochiPalette() Palette {
	return Palette{
		Idle:       canvas.Hex("#7A7A85"),
		Initial:    canvas.Hex("#FF4D94"),
		Thinking:   canvas.Hex("#FF80B5"),
		Executing:  canvas.Hex("#FFB347"),
		Awaiting:   canvas.Hex("#7DCFFF"),
		Streaming:  canvas.Hex("#9ECE6A"),
		Success:    canvas.Hex("#9ECE6A"),
		Error:      canvas.Hex("#F7768E"),
		Label:      canvas.Hex("#565F89"),
		Value:      canvas.Hex("#C0CAF5"),
		Separator:  canvas.Hex("#414868"),
		Background: canvas.Hex("#1A1B26"),
	}
}

// New creates a status bar with the given palette.
func New(palette Palette) *Bar {
	return &Bar{
		anim:         canvas.NewAnimationEngine(50 * time.Millisecond),
		currentColor: palette.Idle,
		targetColor:  palette.Idle,
		palette:      palette,
	}
}

// SetStatus updates the entire status at once. Use this for the
// common case where many fields change together.
func (b *Bar) SetStatus(s Status) {
	b.mu.Lock()
	b.status = s
	b.mu.Unlock()
	// Trigger a color tween to the new state's color.
	b.tweenTo(s.State)
}

// SetState updates only the state and triggers a color transition.
func (b *Bar) SetState(s State) {
	b.mu.Lock()
	b.status.State = s
	b.mu.Unlock()
	b.tweenTo(s)
}

// SetTokens updates the token count.
func (b *Bar) SetTokens(n int) {
	b.mu.Lock()
	b.status.Tokens = n
	b.mu.Unlock()
}

// SetLatency updates the latency display.
func (b *Bar) SetLatency(ms int) {
	b.mu.Lock()
	b.status.LatencyMs = ms
	b.mu.Unlock()
}

// SetCost updates the cost display.
func (b *Bar) SetCost(c float64) {
	b.mu.Lock()
	b.status.Cost = c
	b.mu.Unlock()
}

// SetModel updates the model/provider labels.
func (b *Bar) SetModel(model, provider string) {
	b.mu.Lock()
	b.status.Model = model
	b.status.Provider = provider
	b.mu.Unlock()
}

// SetMessage updates the free-form message.
func (b *Bar) SetMessage(msg string) {
	b.mu.Lock()
	b.status.Message = msg
	b.mu.Unlock()
}

// tweenTo starts a color tween to the palette color for the
// given state. The tween runs over 200ms with OutQuad easing.
func (b *Bar) tweenTo(s State) {
	target := b.paletteColor(s)
	if target == b.targetColor {
		return
	}
	b.targetColor = target
	b.anim.AddColorTween("state",
		canvas.NewColorTween(b.currentColor, target, 0.2, canvas.OutQuad))
}

// paletteColor returns the palette color for a state.
func (b *Bar) paletteColor(s State) canvas.RGBA {
	switch s {
	case StateInitializing:
		return b.palette.Initial
	case StateThinking:
		return b.palette.Thinking
	case StateExecuting:
		return b.palette.Executing
	case StateAwaiting:
		return b.palette.Awaiting
	case StateStreaming:
		return b.palette.Streaming
	case StateSuccess:
		return b.palette.Success
	case StateError:
		return b.palette.Error
	default:
		return b.palette.Idle
	}
}

// Advance moves all animations forward by dt seconds. Call this
// from the UI's main tick. Returns true if a redraw is needed.
func (b *Bar) Advance(dt float64) bool {
	changed := b.anim.Advance(dt)
	if ct := b.anim.ColorTween("state"); ct != nil {
		b.currentColor = ct.Value()
	}
	b.spinnerStep += dt
	return changed || true // always need redraw for spinner
}

// Draw renders the status bar into the given framebuffer at
// (x, y) with the given width. The bar is 1 row tall.
func (b *Bar) Draw(fb *canvas.Framebuffer, x, y, width int) {
	if width <= 0 {
		return
	}
	b.mu.RLock()
	s := b.status
	b.mu.RUnlock()

	// Background fill.
	bg := canvas.Cell{Bg: b.palette.Background, Width: 1}
	fb.FillRect(x, y, width, 1, bg)

	// Spinner: 10 cycling runes in a gradient.
	spinnerWidth := 10
	spinner := b.renderSpinner(s.State, spinnerWidth)
	fb.SetString(x, y, spinner, canvas.Cell{Width: 1, Fg: b.currentColor})
	cursor := x + spinnerWidth

	// State label.
	if cursor < x+width {
		label := " " + s.State.String() + " "
		fb.SetString(cursor, y, label, canvas.Cell{Width: 1, Fg: b.palette.Label, Attrs: canvas.AttrBold})
		cursor += len(label)
	}

	// Separator.
	if cursor < x+width {
		fb.SetString(cursor, y, "│", canvas.Cell{Width: 1, Fg: b.palette.Separator})
		cursor++
	}

	// Model and provider.
	if cursor < x+width && s.Model != "" {
		modelStr := " " + s.Model
		fb.SetString(cursor, y, modelStr, canvas.Cell{Width: 1, Fg: b.palette.Value})
		cursor += len(modelStr)
		if cursor < x+width && s.Provider != "" {
			provStr := "@" + s.Provider + " "
			fb.SetString(cursor, y, provStr, canvas.Cell{Width: 1, Fg: b.palette.Label})
			cursor += len(provStr)
		}
	}

	// Right-aligned: tokens, latency, cost.
	right := b.renderRight(s, x, width)
	if right != "" {
		// Pad the middle with spaces if needed.
		gap := (x + width) - cursor - len(right)
		if gap < 0 {
			gap = 0
		}
		if gap > 0 {
			fb.SetString(cursor, y, strings.Repeat(" ", gap), canvas.Cell{Width: 1})
		}
		fb.SetString(x+width-len(right), y, right, canvas.Cell{Width: 1, Fg: b.palette.Value})
	}
}

// renderRight produces the right-aligned metrics string:
// "tok: 1,234 │ 230ms │ $0.0123"
func (b *Bar) renderRight(s Status, x, width int) string {
	var parts []string
	if s.Tokens > 0 {
		parts = append(parts, fmt.Sprintf("tok: %s", formatInt(s.Tokens)))
	}
	if s.LatencyMs > 0 {
		parts = append(parts, fmt.Sprintf("%dms", s.LatencyMs))
	}
	if s.Cost > 0 {
		parts = append(parts, fmt.Sprintf("$%.4f", s.Cost))
	}
	if len(parts) == 0 {
		return ""
	}
	return " " + strings.Join(parts, " │ ") + " "
}

// renderSpinner returns the animated spinner text for the given
// state. The spinner uses the state's color blended across the
// runes. Different states get different rune sets.
func (b *Bar) renderSpinner(s State, width int) string {
	runes := spinnerRunes(s)
	if len(runes) == 0 {
		return strings.Repeat(" ", width)
	}
	// Pick a rune based on the spinner step; gradient over width.
	stepIdx := int(b.spinnerStep*float64(len(runes))) % len(runes)
	out := make([]rune, width)
	for i := 0; i < width; i++ {
		out[i] = runes[(stepIdx+i)%len(runes)]
	}
	return string(out)
}

// spinnerRunes returns the rune pool for a given state. The pools
// are chosen to be visually distinct: dots for thinking, arrows
// for executing, question marks for awaiting, checkmarks for
// success, and the kawaii sakura set for idle/streaming.
func spinnerRunes(s State) []rune {
	switch s {
	case StateThinking:
		return []rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
	case StateExecuting:
		return []rune("░▒▓█▓▒░")
	case StateAwaiting:
		return []rune("◇◆●○")
	case StateStreaming:
		return []rune("✦✧★☆")
	case StateSuccess:
		return []rune("✓")
	case StateError:
		return []rune("✗")
	case StateInitializing:
		return []rune("◐◓◑◒")
	default:
		return []rune("✿❀✾✺")
	}
}

// formatInt inserts thousands separators. 12345 → "12,345".
func formatInt(n int) string {
	if n < 0 {
		return "-" + formatInt(-n)
	}
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	rem := len(s) % 3
	if rem > 0 {
		b.WriteString(s[:rem])
		if len(s) > rem {
			b.WriteByte(',')
		}
	}
	for i := rem; i < len(s); i += 3 {
		b.WriteString(s[i : i+3])
		if i+3 < len(s) {
			b.WriteByte(',')
		}
	}
	return b.String()
}
