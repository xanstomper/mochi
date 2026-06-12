package styles

import "github.com/xanstomper/mofu"

func ThemeForProvider(providerID string) Styles {
	switch providerID {
	case "hyper":
		return MOCHIAporia()
	default:
		return MOCHISakura()
	}
}

func CharmtonePantera() Styles {
	return MOCHISakura()
}

func HyperMOCHIObsidiana() Styles {
	return MOCHIAporia()
}

func MOCHIAporia() Styles {
	return quickStyle(quickStyleOpts{
		primary:   mofu.Hex("#00E5FF"),
		secondary: mofu.Hex("#7C3AED"),
		accent:    mofu.Hex("#F8FAFC"),
		keyword:   mofu.Hex("#22D3EE"),

		fgBase:       mofu.Hex("#E6F7FF"),
		fgMoreSubtle: mofu.Hex("#7DD3FC"),
		fgSubtle:     mofu.Hex("#A5B4FC"),
		fgMostSubtle: mofu.Hex("#475569"),

		onPrimary: mofu.Hex("#020617"),

		bgBase:         mofu.Hex("#020617"),
		bgLeastVisible: mofu.Hex("#07111F"),
		bgLessVisible:  mofu.Hex("#0B1220"),
		bgMostVisible:  mofu.Hex("#111827"),

		separator: mofu.Hex("#164E63"),

		destructive:       mofu.Hex("#FB7185"),
		error:             mofu.Hex("#F43F5E"),
		warningSubtle:     mofu.Hex("#FDE68A"),
		warning:           mofu.Hex("#F59E0B"),
		denied:            mofu.Hex("#FB7185"),
		busy:              mofu.Hex("#22D3EE"),
		info:              mofu.Hex("#BAE6FD"),
		infoMoreSubtle:    mofu.Hex("#67E8F9"),
		infoMostSubtle:    mofu.Hex("#38BDF8"),
		success:           mofu.Hex("#34D399"),
		successMoreSubtle: mofu.Hex("#10B981"),
		successMostSubtle: mofu.Hex("#064E3B"),
	})
}

func MOCHISakura() Styles {
	return quickStyle(quickStyleOpts{
		primary:   mofu.Hex("#FF4D94"),
		secondary: mofu.Hex("#FF9FC5"),
		accent:    mofu.Hex("#FFD6E5"),
		keyword:   mofu.Hex("#FF6FA8"),

		fgBase:       mofu.Hex("#FFE4F1"),
		fgMoreSubtle: mofu.Hex("#FFB3D1"),
		fgSubtle:     mofu.Hex("#E68BAB"),
		fgMostSubtle: mofu.Hex("#5C2A3D"),

		onPrimary: mofu.Hex("#0A0A0A"),

		bgBase:         mofu.Hex("#000000"),
		bgLeastVisible: mofu.Hex("#0A0A0A"),
		bgLessVisible:  mofu.Hex("#121212"),
		bgMostVisible:  mofu.Hex("#1A1A1A"),

		separator: mofu.Hex("#3D1729"),

		destructive:       mofu.Hex("#F43F5E"),
		error:             mofu.Hex("#FB7185"),
		warningSubtle:     mofu.Hex("#FDE68A"),
		warning:           mofu.Hex("#F59E0B"),
		denied:            mofu.Hex("#FB7185"),
		busy:              mofu.Hex("#FF6FA8"),
		info:              mofu.Hex("#FFB3D1"),
		infoMoreSubtle:    mofu.Hex("#FF9FC5"),
		infoMostSubtle:    mofu.Hex("#E68BAB"),
		success:           mofu.Hex("#34D399"),
		successMoreSubtle: mofu.Hex("#10B981"),
		successMostSubtle: mofu.Hex("#064E3B"),
	})
}
