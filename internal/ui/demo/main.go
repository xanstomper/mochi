// Command demo is a standalone demonstration of the new Mochi
// TUI components: animated banner, status bar with working
// indicators, and streaming visualization with type-on effect
// and particle trail. Run with: go run ./internal/ui/demo
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/mochi/mochi/internal/ui/banner"
	"github.com/mochi/mochi/internal/ui/canvas"
	"github.com/mochi/mochi/internal/ui/statusbar"
	"github.com/mochi/mochi/internal/ui/streamviz"
)

type model struct {
	width, height int
	renderer      *canvas.Renderer
	banner        *banner.Banner
	statusbar     *statusbar.Bar
	streamer      *streamviz.Streamer
	phase         int
	phaseStart    time.Time
	startTime     time.Time
}

type tickMsg time.Time

func tick() tea.Cmd {
	return tea.Tick(16*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m *model) Init() tea.Cmd {
	return tick()
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.renderer.Resize(m.width, m.height)
		m.layout()
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "q" || msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
	case tickMsg:
		now := time.Time(msg)
		dtMs := int(now.Sub(m.startTime).Milliseconds()) - m.lastTickMs()
		m.startTime = now
		_ = dtMs
		m.advance()
		return m, tick()
	}
	return m, nil
}

func (m *model) lastTickMs() int {
	// Approximate; not exact but close enough for animation pacing.
	return 0
}

func (m *model) layout() {
	// Banner at top.
	if m.banner == nil || m.banner.Width != m.width {
		m.banner = banner.New(m.width, 6, banner.MochiWordmark, banner.MochiPalette())
	}
	// Status bar at bottom.
	if m.statusbar == nil {
		m.statusbar = statusbar.New(statusbar.MochiPalette())
		m.statusbar.SetStatus(statusbar.Status{
			State:    statusbar.StateIdle,
			Model:    "claude-3-5-sonnet",
			Provider: "anthropic",
		})
	}
	// Streamer in the middle.
	streamH := m.height - 6 - 1
	if streamH < 3 {
		streamH = 3
	}
	streamW := m.width - 4
	if streamW < 10 {
		streamW = 10
	}
	if m.streamer == nil {
		m.streamer = streamviz.New(streamW, streamH, streamviz.MochiPalette())
		m.streamer.TypeOnMs = 18
	} else {
		m.streamer.Width = streamW
		m.streamer.Height = streamH
	}
}

func (m *model) advance() {
	// Advance all components.
	if m.banner != nil {
		m.banner.Advance(16)
	}
	if m.streamer != nil {
		m.streamer.Advance(16)
	}
	if m.statusbar != nil {
		m.statusbar.Advance(0.016)
	}
	// Phase machine: banner (0-2s) → thinking (2-3s) → stream (3-8s) → done (8s+).
	elapsed := time.Since(m.startTime)
	switch {
	case elapsed < 2*time.Second:
		m.statusbar.SetState(statusbar.StateInitializing)
		m.statusbar.SetMessage("warming up...")
	case elapsed < 3*time.Second:
		m.statusbar.SetState(statusbar.StateThinking)
		m.statusbar.SetMessage("analyzing request...")
	case elapsed < 8*time.Second:
		m.statusbar.SetState(statusbar.StateStreaming)
		m.statusbar.SetMessage("generating response...")
		// Push some tokens at varying rates.
		tokens := m.tokensForPhase(elapsed)
		if len(tokens) > 0 {
			m.streamer.Push(tokens)
		}
		m.statusbar.SetTokens(int(elapsed.Seconds() * 250))
		m.statusbar.SetLatency(180 + int(elapsed.Seconds()*10)%100)
		m.statusbar.SetCost(elapsed.Seconds() * 0.005)
	case elapsed < 9*time.Second:
		m.statusbar.SetState(statusbar.StateSuccess)
		m.statusbar.SetMessage("done")
	default:
		m.streamer.Reset()
		m.startTime = time.Now()
	}
}

func (m *model) tokensForPhase(elapsed time.Duration) string {
	// Generate a chunk of streaming text per tick.
	phrases := []string{
		"Building ",
		"a better ",
		"terminal ",
		"experience. ",
		"Streaming ",
		"tokens ",
		"with ",
		"type-on ",
		"effect, ",
		"particle ",
		"trails, ",
		"and ",
		"animated ",
		"indicators. ",
		"This is ",
		"mochi. ",
		"<3 ",
		"• ",
		"★ ",
		"✦ ",
		"Smooth, ",
		"fast, ",
		"alive. ",
	}
	idx := int(elapsed.Seconds()*8) % len(phrases)
	return phrases[idx]
}

func (m *model) View() tea.View {
	// The Bubble Tea v2 View() should return a tea.View.
	// For now, use the standard View() pattern.
	return tea.View{}
}

func (m *model) renderToString() string {
	m.renderer.Clear()
	// Banner at top.
	if m.banner != nil {
		m.banner.Draw(m.renderer.Back, 0, 0)
	}
	// Streamer in middle.
	if m.streamer != nil {
		streamY := 6
		streamX := 2
		if streamX+2+m.streamer.Width > m.width {
			streamX = 0
		}
		m.streamer.Draw(m.renderer.Back, streamX, streamY)
	}
	// Status bar at bottom.
	if m.statusbar != nil {
		m.statusbar.Draw(m.renderer.Back, 0, m.height-1, m.width)
	}
	return m.renderer.Present()
}

func main() {
	useDirect := flag.Bool("direct", false, "render to stdout without Bubble Tea (for piping)")
	flag.Parse()

	// Get terminal size.
	w, h := 100, 30
	if env := os.Getenv("COLUMNS"); env != "" {
		if n, err := fmt.Sscanf(env, "%d", &w); n == 1 && err == nil {
			_ = n
		}
	}
	if env := os.Getenv("LINES"); env != "" {
		if n, err := fmt.Sscanf(env, "%d", &h); n == 1 && err == nil {
			_ = n
		}
	}
	if *useDirect {
		runDirect(w, h)
		return
	}
	// Default: use Bubble Tea v2.
	p := tea.NewProgram(&model{
		width:     w,
		height:    h,
		renderer:  canvas.NewRenderer(w, h),
		startTime: time.Now(),
	})
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runDirect(w, h int) {
	m := &model{
		width:     w,
		height:    h,
		renderer:  canvas.NewRenderer(w, h),
		startTime: time.Now(),
	}
	m.layout()
	// Hide cursor, clear screen.
	fmt.Print("\x1b[?25l\x1b[2J")
	defer fmt.Print("\x1b[?25h")
	// Run for 12 seconds.
	end := time.Now().Add(12 * time.Second)
	for time.Now().Before(end) {
		m.advance()
		fmt.Print("\x1b[H")
		fmt.Print(m.renderToString())
		time.Sleep(50 * time.Millisecond)
	}
	fmt.Print("\x1b[2J\x1b[H")
	_ = strings.Repeat // silence unused
}
