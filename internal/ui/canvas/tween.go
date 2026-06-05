package canvas

import "math"

// stdSin is a thin wrapper so the easing functions can be tested
// in isolation from the math package.
func stdSin(x float64) float64 { return math.Sin(x) }

// Tween interpolates between two values of the same type over a
// fixed duration. The interpolation uses an easing function; the
// default is Linear. A tween is immutable once created; use the
// Advance method to move it forward in time.
type Tween struct {
	Start, End float64
	Duration   float64 // in seconds
	Elapsed    float64
	Easing     Easing
	Done       bool
}

// NewTween creates a tween from start to end with the given
// duration and easing. A nil easing falls back to Linear.
func NewTween(start, end, duration float64, easing Easing) *Tween {
	if easing == nil {
		easing = Linear
	}
	return &Tween{
		Start:    start,
		End:      end,
		Duration: duration,
		Easing:   easing,
	}
}

// Value returns the current interpolated value. The progress
// is clamped to [0, 1] and the result is clamped to the
// [Start, End] range so easings that overshoot (OutBack,
// OutElastic) never produce a value outside the configured
// range. Use ValueRaw if you need the unclamped value.
func (t *Tween) Value() float64 {
	if t.Duration <= 0 {
		return t.End
	}
	p := Clamp(t.Elapsed / t.Duration)
	v := t.Start + (t.End-t.Start)*t.Easing(p)
	if t.End >= t.Start {
		if v < t.Start {
			return t.Start
		}
		if v > t.End {
			return t.End
		}
	} else {
		if v > t.Start {
			return t.Start
		}
		if v < t.End {
			return t.End
		}
	}
	return v
}

// ValueRaw returns the unclamped interpolated value. Useful for
// springs, particles, and other effects where overshoot is
// intentional.
func (t *Tween) ValueRaw() float64 {
	if t.Duration <= 0 {
		return t.End
	}
	p := Clamp(t.Elapsed / t.Duration)
	return t.Start + (t.End-t.Start)*t.Easing(p)
}

// Advance moves the tween forward by dt seconds. Once elapsed
// exceeds the duration the tween is marked Done and stops moving.
func (t *Tween) Advance(dt float64) {
	if t.Done {
		return
	}
	t.Elapsed += dt
	if t.Elapsed >= t.Duration {
		t.Elapsed = t.Duration
		t.Done = true
	}
}

// Reset returns the tween to its initial state. Useful when an
// animation should replay.
func (t *Tween) Reset() {
	t.Elapsed = 0
	t.Done = false
}

// ColorTween interpolates between two colors over time. It is
// implemented as a regular tween with a typed accessor.
type ColorTween struct {
	Tween
	StartC, EndC RGBA
}

// NewColorTween creates a color tween. The duration is in seconds.
func NewColorTween(start, end RGBA, duration float64, easing Easing) *ColorTween {
	return &ColorTween{
		Tween:  Tween{Duration: duration, Easing: easing},
		StartC: start,
		EndC:   end,
	}
}

// Value returns the current interpolated color.
func (c *ColorTween) Value() RGBA {
	if c.Duration <= 0 {
		return c.EndC
	}
	p := Clamp(c.Elapsed / c.Duration)
	return c.StartC.Lerp(c.EndC, c.Easing(p))
}

// Advance moves the tween forward by dt seconds.
func (c *ColorTween) Advance(dt float64) { c.Tween.Advance(dt) }

// Reset returns the tween to its initial state.
func (c *ColorTween) Reset() { c.Tween.Reset() }
