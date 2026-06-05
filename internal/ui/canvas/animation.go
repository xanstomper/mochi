package canvas

import "time"

// AnimationEngine runs a set of named animations. Each animation
// is a function that takes elapsed time in seconds and returns
// true when it is finished. The engine ticks all active animations
// at a fixed interval and removes the ones that are done.
//
// The engine is intentionally simple: it is a ticker with a
// callback. Composability is provided by passing closures that
// capture a tween or a color tween.
type AnimationEngine struct {
	tweens   map[string]*Tween
	colors   map[string]*ColorTween
	tick     time.Duration
	OnUpdate func() // called after every tick
}

// NewAnimationEngine creates an engine with the given tick rate.
// A tick rate of 16ms is roughly 60fps and is the default used
// by the rest of the UI.
func NewAnimationEngine(tick time.Duration) *AnimationEngine {
	if tick <= 0 {
		tick = 16 * time.Millisecond
	}
	return &AnimationEngine{
		tweens: make(map[string]*Tween),
		colors: make(map[string]*ColorTween),
		tick:   tick,
	}
}

// AddTween registers a tween under a name. If a tween with the
// same name already exists it is replaced.
func (e *AnimationEngine) AddTween(name string, t *Tween) {
	e.tweens[name] = t
}

// AddColorTween registers a color tween under a name.
func (e *AnimationEngine) AddColorTween(name string, c *ColorTween) {
	e.colors[name] = c
}

// Tween returns the tween with the given name, or nil if absent.
func (e *AnimationEngine) Tween(name string) *Tween {
	return e.tweens[name]
}

// ColorTween returns the color tween with the given name.
func (e *AnimationEngine) ColorTween(name string) *ColorTween {
	return e.colors[name]
}

// RemoveTween deletes a tween by name.
func (e *AnimationEngine) RemoveTween(name string) {
	delete(e.tweens, name)
}

// RemoveColorTween deletes a color tween by name.
func (e *AnimationEngine) RemoveColorTween(name string) {
	delete(e.colors, name)
}

// Advance moves every active tween forward by dt seconds and
// removes the ones that became done during this tick. It
// returns true if any tween changed state (and a redraw is
// needed).
func (e *AnimationEngine) Advance(dt float64) bool {
	changed := false
	for name, t := range e.tweens {
		old := t.Elapsed
		t.Advance(dt)
		if t.Elapsed != old {
			changed = true
		}
		if t.Done {
			delete(e.tweens, name)
		}
	}
	for name, c := range e.colors {
		old := c.Elapsed
		c.Advance(dt)
		if c.Elapsed != old {
			changed = true
		}
		if c.Done {
			delete(e.colors, name)
		}
	}
	if changed && e.OnUpdate != nil {
		e.OnUpdate()
	}
	return changed
}

// Active reports whether there are any active tweens.
func (e *AnimationEngine) Active() bool {
	return len(e.tweens) > 0 || len(e.colors) > 0
}

// Tick returns the engine's tick rate.
func (e *AnimationEngine) Tick() time.Duration { return e.tick }

// StepTicker is a thin wrapper that calls Advance on a fixed
// interval. It returns a stop function the caller can use to
// halt the ticker.
func (e *AnimationEngine) StepTicker(stop <-chan struct{}) {
	t := time.NewTicker(e.tick)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			e.Advance(e.tick.Seconds())
		}
	}
}
