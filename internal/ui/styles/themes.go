package styles

import "charm.land/lipgloss/v2"

// ThemeForProvider returns the Styles associated with the given provider
// ID. Unknown or empty provider IDs yield the default Sakura theme:
// deep black with kawaii pink foregrounds.
func ThemeForProvider(providerID string) Styles {
	switch providerID {
	case "hyper":
		return MOCHIAporia()
	default:
		return MOCHISakura()
	}
}

// CharmtonePantera returns the default MOCHI style. Kept as
// the test-suite entry point so existing tests don't break;
// runtime callers should use ThemeForProvider.
func CharmtonePantera() Styles {
	return MOCHISakura()
}

// HyperMOCHIObsidiana returns the MOCHI hyper dark theme.
func HyperMOCHIObsidiana() Styles {
	return MOCHIAporia()
}

// MOCHIAporia is the original dark cyan/blue theme. Kept for
// callers that explicitly request it; the user-facing default
// theme is now MOCHISakura (kawaii black + pink).
func MOCHIAporia() Styles {
	return quickStyle(quickStyleOpts{
		primary:   lipgloss.Color("#00E5FF"),
		secondary: lipgloss.Color("#7C3AED"),
		accent:    lipgloss.Color("#F8FAFC"),
		keyword:   lipgloss.Color("#22D3EE"),

		fgBase:       lipgloss.Color("#E6F7FF"),
		fgMoreSubtle: lipgloss.Color("#7DD3FC"),
		fgSubtle:     lipgloss.Color("#A5B4FC"),
		fgMostSubtle: lipgloss.Color("#475569"),

		onPrimary: lipgloss.Color("#020617"),

		bgBase:         lipgloss.Color("#020617"),
		bgLeastVisible: lipgloss.Color("#07111F"),
		bgLessVisible:  lipgloss.Color("#0B1220"),
		bgMostVisible:  lipgloss.Color("#111827"),

		separator: lipgloss.Color("#164E63"),

		destructive:       lipgloss.Color("#FB7185"),
		error:             lipgloss.Color("#F43F5E"),
		warningSubtle:     lipgloss.Color("#FDE68A"),
		warning:           lipgloss.Color("#F59E0B"),
		denied:            lipgloss.Color("#FB7185"),
		busy:              lipgloss.Color("#22D3EE"),
		info:              lipgloss.Color("#BAE6FD"),
		infoMoreSubtle:    lipgloss.Color("#67E8F9"),
		infoMostSubtle:    lipgloss.Color("#38BDF8"),
		success:           lipgloss.Color("#34D399"),
		successMoreSubtle: lipgloss.Color("#10B981"),
		successMostSubtle: lipgloss.Color("#064E3B"),
	})
}

// MOCHISakura is the default user-facing theme: deep black
// backgrounds with kawaii-but-not-corny pink foregrounds. The
// primary is a hot sakura pink that's saturated enough to be
// readable on black, the secondary is a softer rose for less
// important accents, and the bg palette is true black rather
// than dark gray so the pink pops. The error/destructive
// colors stay red-rose so destructive UI still reads as danger
// rather than getting muddied with the pinks.
func MOCHISakura() Styles {
	return quickStyle(quickStyleOpts{
		// Hot sakura pink for primary actions, headers, focus.
		primary: lipgloss.Color("#FF4D94"),
		// Soft rose for secondary accents and links.
		secondary: lipgloss.Color("#FF9FC5"),
		// Almost-white pink for high-contrast headings.
		accent: lipgloss.Color("#FFD6E5"),
		// Bright pink for code keywords and identifiers.
		keyword: lipgloss.Color("#FF6FA8"),

		// Foreground ladder: white-pink at the top, getting
		// progressively muted but staying pink-tinted.
		fgBase:       lipgloss.Color("#FFE4F1"),
		fgMoreSubtle: lipgloss.Color("#FFB3D1"),
		fgSubtle:     lipgloss.Color("#E68BAB"),
		fgMostSubtle: lipgloss.Color("#5C2A3D"),

		// Text on primary buttons (saturated pink) — black so
		// it pops against the pink, not the other way around.
		onPrimary: lipgloss.Color("#0A0A0A"),

		// Background ladder: true black, with progressively
		// lighter dark surfaces for layering. No blue tint.
		bgBase:         lipgloss.Color("#000000"),
		bgLeastVisible: lipgloss.Color("#0A0A0A"),
		bgLessVisible:  lipgloss.Color("#121212"),
		bgMostVisible:  lipgloss.Color("#1A1A1A"),

		// Pink separator with low alpha feel.
		separator: lipgloss.Color("#3D1729"),

		// Destructive UI stays rose-red rather than pink so
		// danger still reads as danger. Warning stays amber.
		destructive:       lipgloss.Color("#F43F5E"),
		error:             lipgloss.Color("#FB7185"),
		warningSubtle:     lipgloss.Color("#FDE68A"),
		warning:           lipgloss.Color("#F59E0B"),
		denied:            lipgloss.Color("#FB7185"),
		busy:              lipgloss.Color("#FF6FA8"),
		info:              lipgloss.Color("#FFB3D1"),
		infoMoreSubtle:    lipgloss.Color("#FF9FC5"),
		infoMostSubtle:    lipgloss.Color("#E68BAB"),
		success:           lipgloss.Color("#34D399"),
		successMoreSubtle: lipgloss.Color("#10B981"),
		successMostSubtle: lipgloss.Color("#064E3B"),
	})
}
