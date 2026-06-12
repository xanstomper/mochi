// Package anim provides an animated spinner.
package anim

import (
	"fmt"
	"image/color"
	"math/rand/v2"
	"strings"
	"sync/atomic"
	"time"

	"github.com/zeebo/xxh3"

	"github.com/xanstomper/mofu"
	"github.com/lucasb-eyer/go-colorful"

	"github.com/mochi/mochi/internal/csync"
)

const (
	fps           = 20
	initialChar   = '.'
	labelGap      = " "
	labelGapWidth = 1

	ellipsisAnimSpeed = 8
	maxBirthSteps     = 20
	prerenderedFrames = 10

	defaultNumCyclingChars = 10
)

var (
	defaultGradColorA = color.RGBA{R: 0xff, G: 0, B: 0, A: 0xff}
	defaultGradColorB = color.RGBA{R: 0, G: 0, B: 0xff, A: 0xff}
	defaultLabelColor = color.RGBA{R: 0xcc, G: 0xcc, B: 0xcc, A: 0xff}

	kawaiiGradColorA = color.RGBA{R: 0xFF, G: 0x4D, B: 0x94, A: 0xFF}
	kawaiiGradColorB = color.RGBA{R: 0xFF, G: 0xB3, B: 0xD1, A: 0xFF}
)

var (
	availableRunes = []rune("0123456789abcdefABCDEF~!@#$£€%^&*()+=_")
	ellipsisFrames = []string{".", "..", "...", ""}
	kawaiiRunes    = []rune("✿❀✾✺✦✧★♡♥◌◍◎·")
)

func IsKawaii() bool {
	return true
}

func RuneSet() []rune {
	if IsKawaii() {
		return kawaiiRunes
	}
	return availableRunes
}

func KawaiiGradient() (color.RGBA, color.RGBA) {
	return color.RGBA{R: 0xFF, G: 0x4D, B: 0x94, A: 0xFF},
		color.RGBA{R: 0xFF, G: 0xB3, B: 0xD1, A: 0xFF}
}

var lastID atomic.Int64

func nextID() int {
	return int(lastID.Add(1))
}

type animCache struct {
	initialFrames  [][]string
	cyclingFrames  [][]string
	width          int
	labelWidth     int
	label          []string
	ellipsisFrames []string
}

var animCacheMap = csync.NewMap[string, *animCache]()

func settingsHash(opts Settings) string {
	h := xxh3.New()
	fmt.Fprintf(h, "%d-%s-%v-%v-%v-%t",
		opts.Size, opts.Label, opts.LabelColor, opts.GradColorA, opts.GradColorB, opts.CycleColors)
	return fmt.Sprintf("%x", h.Sum(nil))
}

type StepMsg struct{ ID string }

type Settings struct {
	ID          string
	Size        int
	Label       string
	LabelColor  color.Color
	GradColorA  color.Color
	GradColorB  color.Color
	CycleColors bool
}

type Anim struct {
	width            int
	cyclingCharWidth int
	label            *csync.Slice[string]
	labelWidth       int
	labelColor       color.Color
	birthSteps       []int
	initialFrames    [][]string
	initialized      atomic.Bool
	cyclingFrames    [][]string
	step             atomic.Int64
	framesSinceStart atomic.Int64
	ellipsisStep     atomic.Int64
	ellipsisFrames   *csync.Slice[string]
	id               string
}

func New(opts Settings) *Anim {
	a := &Anim{}
	if opts.Size < 1 {
		opts.Size = defaultNumCyclingChars
	}
	if colorIsUnset(opts.GradColorA) {
		if IsKawaii() {
			opts.GradColorA = kawaiiGradColorA
		} else {
			opts.GradColorA = defaultGradColorA
		}
	}
	if colorIsUnset(opts.GradColorB) {
		if IsKawaii() {
			opts.GradColorB = kawaiiGradColorB
		} else {
			opts.GradColorB = defaultGradColorB
		}
	}
	if colorIsUnset(opts.LabelColor) {
		opts.LabelColor = defaultLabelColor
	}

	if opts.ID != "" {
		a.id = opts.ID
	} else {
		a.id = fmt.Sprintf("%d", nextID())
	}
	a.cyclingCharWidth = opts.Size
	a.labelColor = opts.LabelColor

	cacheKey := settingsHash(opts)
	cached, exists := animCacheMap.Get(cacheKey)

	if exists {
		a.width = cached.width
		a.labelWidth = cached.labelWidth
		a.label = csync.NewSliceFrom(cached.label)
		a.ellipsisFrames = csync.NewSliceFrom(cached.ellipsisFrames)
		a.initialFrames = cached.initialFrames
		a.cyclingFrames = cached.cyclingFrames
	} else {
		a.labelWidth = mofu.MeasureWidth(opts.Label)

		a.width = opts.Size
		if opts.Label != "" {
			a.width += labelGapWidth + mofu.MeasureWidth(opts.Label)
		}

		a.renderLabel(opts.Label)

		var ramp []color.Color
		numFrames := prerenderedFrames
		if opts.CycleColors {
			ramp = makeGradientRamp(a.width*3, opts.GradColorA, opts.GradColorB, opts.GradColorA, opts.GradColorB)
			numFrames = a.width * 2
		} else {
			ramp = makeGradientRamp(a.width, opts.GradColorA, opts.GradColorB)
		}

		a.initialFrames = make([][]string, numFrames)
		offset := 0
		for i := range a.initialFrames {
			a.initialFrames[i] = make([]string, a.width+labelGapWidth+a.labelWidth)
			for j := range a.initialFrames[i] {
				if j+offset >= len(ramp) {
					continue
				}

				var c color.Color
				if j <= a.cyclingCharWidth {
					c = ramp[j+offset]
				} else {
					c = opts.LabelColor
				}

				r, g, b, _ := c.RGBA()
				a.initialFrames[i][j] = mofu.DefaultStyle().
					Fg(mofu.RGB(uint8(r>>8), uint8(g>>8), uint8(b>>8))).
					Apply(string(initialChar))
			}
			if opts.CycleColors {
				offset++
			}
		}

		seed := xxh3.HashString(cacheKey)
		rng := rand.New(rand.NewPCG(seed, ^seed))
		a.cyclingFrames = make([][]string, numFrames)
		offset = 0
		for i := range a.cyclingFrames {
			a.cyclingFrames[i] = make([]string, a.width)
			for j := range a.cyclingFrames[i] {
				if j+offset >= len(ramp) {
					continue
				}

				r := availableRunes[rng.IntN(len(availableRunes))]
				cr, cg, cb, _ := ramp[j+offset].RGBA()
				a.cyclingFrames[i][j] = mofu.DefaultStyle().
					Fg(mofu.RGB(uint8(cr>>8), uint8(cg>>8), uint8(cb>>8))).
					Apply(string(r))
			}
			if opts.CycleColors {
				offset++
			}
		}

		labelSlice := make([]string, a.label.Len())
		for i, v := range a.label.Seq2() {
			labelSlice[i] = v
		}
		ellipsisSlice := make([]string, a.ellipsisFrames.Len())
		for i, v := range a.ellipsisFrames.Seq2() {
			ellipsisSlice[i] = v
		}
		cached = &animCache{
			initialFrames:  a.initialFrames,
			cyclingFrames:  a.cyclingFrames,
			width:          a.width,
			labelWidth:     a.labelWidth,
			label:          labelSlice,
			ellipsisFrames: ellipsisSlice,
		}
		animCacheMap.Set(cacheKey, cached)
	}

	birthSeed := xxh3.HashString(a.id + "|" + cacheKey)
	birthRng := rand.New(rand.NewPCG(birthSeed, ^birthSeed))
	a.birthSteps = make([]int, a.width)
	for i := range a.birthSteps {
		a.birthSteps[i] = birthRng.IntN(maxBirthSteps)
	}

	return a
}

func (a *Anim) SetLabel(newLabel string) {
	a.labelWidth = mofu.MeasureWidth(newLabel)
	a.width = a.cyclingCharWidth
	if newLabel != "" {
		a.width += labelGapWidth + a.labelWidth
	}
	a.renderLabel(newLabel)
}

func (a *Anim) renderLabel(label string) {
	if a.labelWidth > 0 {
		labelRunes := []rune(label)
		a.label = csync.NewSlice[string]()
		lr, lg, lb, _ := a.labelColor.RGBA()
		lc := mofu.RGB(uint8(lr>>8), uint8(lg>>8), uint8(lb>>8))
		for i := range labelRunes {
			rendered := mofu.DefaultStyle().
				Fg(lc).
				Apply(string(labelRunes[i]))
			a.label.Append(rendered)
		}

		a.ellipsisFrames = csync.NewSlice[string]()
		for _, frame := range ellipsisFrames {
			rendered := mofu.DefaultStyle().
				Fg(lc).
				Apply(frame)
			a.ellipsisFrames.Append(rendered)
		}
	} else {
		a.label = csync.NewSlice[string]()
		a.ellipsisFrames = csync.NewSlice[string]()
	}
}

func (a *Anim) Width() (w int) {
	w = a.width
	if a.labelWidth > 0 {
		w += labelGapWidth + a.labelWidth

		var widestEllipsisFrame int
		for _, f := range ellipsisFrames {
			fw := mofu.MeasureWidth(f)
			if fw > widestEllipsisFrame {
				widestEllipsisFrame = fw
			}
		}
		w += widestEllipsisFrame
	}
	return w
}

func (a *Anim) Start() mofu.Cmd {
	return a.Step()
}

func (a *Anim) Animate(msg StepMsg) mofu.Cmd {
	if msg.ID != a.id {
		return nil
	}

	step := a.step.Add(1)
	if int(step) >= len(a.cyclingFrames) {
		a.step.Store(0)
	}

	frames := a.framesSinceStart.Add(1)
	if a.initialized.Load() && a.labelWidth > 0 {
		ellipsisStep := a.ellipsisStep.Add(1)
		if int(ellipsisStep) >= ellipsisAnimSpeed*len(ellipsisFrames) {
			a.ellipsisStep.Store(0)
		}
	} else if !a.initialized.Load() && int(frames) >= maxBirthSteps {
		a.initialized.Store(true)
	}
	return a.Step()
}

func (a *Anim) Render() string {
	var b strings.Builder
	step := int(a.step.Load())
	frames := int(a.framesSinceStart.Load())
	for i := range a.width {
		switch {
		case !a.initialized.Load() && i < len(a.birthSteps) && frames < a.birthSteps[i]:
			b.WriteString(a.initialFrames[step][i])
		case i < a.cyclingCharWidth:
			b.WriteString(a.cyclingFrames[step][i])
		case i == a.cyclingCharWidth:
			b.WriteString(labelGap)
		case i > a.cyclingCharWidth:
			if labelChar, ok := a.label.Get(i - a.cyclingCharWidth - labelGapWidth); ok {
				b.WriteString(labelChar)
			}
		}
	}
	if a.initialized.Load() && a.labelWidth > 0 {
		ellipsisStep := int(a.ellipsisStep.Load())
		if ellipsisFrame, ok := a.ellipsisFrames.Get(ellipsisStep / ellipsisAnimSpeed); ok {
			b.WriteString(ellipsisFrame)
		}
	}

	return b.String()
}

func (a *Anim) Step() mofu.Cmd {
	return mofu.Tick(time.Second/time.Duration(fps), func() mofu.Msg {
		return StepMsg{ID: a.id}
	})
}

func makeGradientRamp(size int, stops ...color.Color) []color.Color {
	if len(stops) < 2 {
		return nil
	}

	points := make([]colorful.Color, len(stops))
	for i, k := range stops {
		points[i], _ = colorful.MakeColor(k)
	}

	numSegments := len(stops) - 1
	if numSegments == 0 {
		return nil
	}
	blended := make([]color.Color, 0, size)

	segmentSizes := make([]int, numSegments)
	baseSize := size / numSegments
	remainder := size % numSegments

	for i := range numSegments {
		segmentSizes[i] = baseSize
		if i < remainder {
			segmentSizes[i]++
		}
	}

	for i := range numSegments {
		c1 := points[i]
		c2 := points[i+1]
		segmentSize := segmentSizes[i]

		for j := range segmentSize {
			if segmentSize == 0 {
				continue
			}
			t := float64(j) / float64(segmentSize)
			c := c1.BlendHcl(c2, t)
			blended = append(blended, c)
		}
	}

	return blended
}

func colorIsUnset(c color.Color) bool {
	if c == nil {
		return true
	}
	_, _, _, a := c.RGBA()
	return a == 0
}
