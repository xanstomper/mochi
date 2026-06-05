package canvas

// Easing functions map a normalized time value t in [0, 1] to a
// progress value in [0, 1]. They are the building blocks of
// smooth animations: a linear tween feels mechanical, a cubic
// tween feels alive, an elastic tween feels playful.
//
// All easings accept and return float64. The input is expected to
// be in [0, 1] and the output is also in [0, 1], but the easing
// functions do not clamp the input. Callers that need clamped
// behavior should do so explicitly.

// Easing is a function that maps t in [0, 1] to a progress in [0, 1].
type Easing func(t float64) float64

// Linear is the identity easing: progress == t.
func Linear(t float64) float64 { return t }

// InQuad accelerates from zero velocity. Useful for entrances.
func InQuad(t float64) float64 { return t * t }

// OutQuad decelerates to zero velocity. Useful for exits.
func OutQuad(t float64) float64 { return t * (2 - t) }

// InOutQuad accelerates then decelerates. Useful for moves.
func InOutQuad(t float64) float64 {
	if t < 0.5 {
		return 2 * t * t
	}
	return -1 + (4-2*t)*t
}

// InCubic is a stronger entrance than InQuad.
func InCubic(t float64) float64 { return t * t * t }

// OutCubic is a stronger exit than OutQuad.
func OutCubic(t float64) float64 {
	u := 1 - t
	return 1 - u*u*u
}

// InOutCubic is a stronger move than InOutQuad.
func InOutCubic(t float64) float64 {
	if t < 0.5 {
		return 4 * t * t * t
	}
	u := -2*t + 2
	return 1 - u*u*u/2
}

// OutElastic is a playful overshoot. Useful for attention getters.
func OutElastic(t float64) float64 {
	if t == 0 || t == 1 {
		return t
	}
	c4 := (2 * 3.141592653589793) / 3
	return pow2(10, t-1) * sin((t-1)*c4)
}

// OutBounce produces a bouncing ball effect at the end of motion.
func OutBounce(t float64) float64 {
	n1, d1 := 7.5625, 2.75
	if t < 1/d1 {
		return n1 * t * t
	}
	if t < 2/d1 {
		t -= 1.5 / d1
		return n1*t*t + 0.75
	}
	if t < 2.5/d1 {
		t -= 2.25 / d1
		return n1*t*t + 0.9375
	}
	t -= 2.625 / d1
	return n1*t*t + 0.984375
}

// InBack overshoots slightly at the start. Pairs nicely with
// OutBack for symmetric motion.
func InBack(t float64) float64 {
	c1 := 1.70158
	c3 := c1 + 1
	return c3*t*t*t - c1*t*t
}

// OutBack mirrors InBack at the end.
func OutBack(t float64) float64 {
	c1 := 1.70158
	c3 := c1 + 1
	u := t - 1
	return 1 + c3*u*u*u + c1*u*u
}

// InOutBack is InBack then OutBack.
func InOutBack(t float64) float64 {
	c1 := 1.70158
	c2 := c1 * 1.525
	if t < 0.5 {
		return (2 * t) * (2 * t) * ((c2+1)*2*t - c2) / 2
	}
	u := 2*t - 2
	return 1 + (u*u*((c2+1)*u+c2))/2
}

// Clamp restricts t to the range [0, 1] and returns it.
func Clamp(t float64) float64 {
	if t < 0 {
		return 0
	}
	if t > 1 {
		return 1
	}
	return t
}

// pow2 returns base**exp. The math package's Pow is overkill for
// the integer exponents used by the elastic easing, so we use the
// fast path.
func pow2(base, exp float64) float64 {
	if exp == 0 {
		return 1
	}
	if exp == 1 {
		return base
	}
	if exp == 2 {
		return base * base
	}
	if exp == 3 {
		return base * base * base
	}
	result := 1.0
	for i := 0; i < int(exp); i++ {
		result *= base
	}
	return result
}

// sin is a small helper so the easing functions don't have to
// import math directly. It is a thin wrapper around the standard
// library.
func sin(x float64) float64 {
	return stdSin(x)
}
