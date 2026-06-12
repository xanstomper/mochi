// Package styles define styling and theming for the project.
package styles

import (
	"fmt"
	"image/color"
	"strings"

	"github.com/xanstomper/mofu"
	"github.com/alecthomas/chroma/v2"
	"github.com/mochi/mochi/internal/ui/diffview"
)

type textareaStyles struct {
	Focused mofu.Style
	Blurred mofu.Style
}

type textinputStyles struct {
	Focused mofu.Style
	Blurred mofu.Style
}

type filepickerStyles struct {
	Selected mofu.Style
	Normal   mofu.Style
}

type helpStyles struct {
	Ellipsis       mofu.Style
	ShortKey       mofu.Style
	ShortDesc      mofu.Style
	ShortSeparator mofu.Style
	FullKey        mofu.Style
	FullDesc       mofu.Style
	FullSeparator  mofu.Style
}

type styleConfig struct {
	Chroma interface{}
}

type stylePrimitive struct {
	Color            *string
	BackgroundColor *string
	Italic           *bool
	Bold             *bool
	Underline        *bool
}

const (
	CheckIcon       string = "✓"
	SpinnerIcon     string = "⋯"
	LoadingIcon     string = "⟳"
	ModelIcon       string = "◇"
	HypercreditIcon string = "◆"

	ArrowRightIcon string = "→"

	ToolPending string = "●"
	ToolSuccess string = "✓"
	ToolError   string = "×"

	RadioOn  string = "◉"
	RadioOff string = "○"

	BorderThin  string = "│"
	BorderThick string = "▌"

	SectionSeparator string = "─"

	TodoCompletedIcon  string = "✓"
	TodoPendingIcon    string = "•"
	TodoInProgressIcon string = "→"

	ImageIcon string = "■"
	TextIcon  string = "≡"
	SkillIcon string = "▲"

	ScrollbarThumb string = "┃"
	ScrollbarTrack string = "│"

	LSPErrorIcon   string = "E"
	LSPWarningIcon string = "W"
	LSPInfoIcon    string = "I"
	LSPHintIcon    string = "H"
)

const (
	defaultMargin     = 2
	defaultListIndent = 2
)

type Styles struct {
	// Header
	Header struct {
		Charm             mofu.Style // Style for "Charm™" label
		Diagonals         mofu.Style // Style for diagonal separators (╱)
		Percentage        mofu.Style // Style for context percentage
		Hypercredit       mofu.Style // Style for Hypercredit count (◆ N)
		Keystroke         mofu.Style // Style for keystroke hints (e.g., "ctrl+d")
		KeystrokeTip      mofu.Style // Style for keystroke action text (e.g., "open", "close")
		WorkingDir        mofu.Style // Style for current working directory
		Separator         mofu.Style // Style for separator dots (•)
		Wrapper           mofu.Style // Outer container for the entire header row
		LogoGradCanvas    mofu.Style // Canvas for the compact "MOCHI" gradient
		LogoGradFromColor color.Color    // "MOCHI" wordmark gradient start
		LogoGradToColor   color.Color    // "MOCHI" wordmark gradient end
	}

	CompactDetails struct {
		View    mofu.Style
		Version mofu.Style
		Title   mofu.Style
	}

	// Tool calls
	ToolCallSuccess mofu.Style

	// Text selection
	TextSelection mofu.Style

	// Markdown & Chroma
	Markdown      styleConfig
	QuietMarkdown styleConfig

	// Inputs
	TextInput textinputStyles

	// Help
	Help helpStyles

	// Diff
	Diff diffview.Style

	// FilePicker
	FilePicker filepickerStyles

	// Buttons
	Button struct {
		Focused mofu.Style
		Blurred mofu.Style
	}

	// Editor
	Editor struct {
		Textarea textareaStyles

		// Normal mode prompt (default "::: ").
		PromptNormalFocused mofu.Style
		PromptNormalBlurred mofu.Style

		// YOLO mode prompt (" ! " icon + ":::" dots).
		PromptYoloIconFocused mofu.Style
		PromptYoloIconBlurred mofu.Style
		PromptYoloDotsFocused mofu.Style
		PromptYoloDotsBlurred mofu.Style
	}

	// Radio
	Radio struct {
		On    mofu.Style
		Off   mofu.Style
		Label mofu.Style // Text next to a radio button
	}

	// Background
	Background color.Color

	// Logo
	Logo struct {
		FieldColor         color.Color
		TitleColorA        color.Color
		TitleColorB        color.Color
		CharmColor         color.Color
		VersionColor       color.Color
		SmallCharm         mofu.Style // "Charm™" label in SmallRender
		SmallDiagonals     mofu.Style // Diagonal line fill in SmallRender
		GradCanvas         mofu.Style // Blank canvas for gradient painting
		SmallGradFromColor color.Color    // Small "MOCHI" wordmark gradient start
		SmallGradToColor   color.Color    // Small "MOCHI" wordmark gradient end
	}

	// Working indicator gradient (spinners/shimmers on assistant "thinking",
	// tool-call pending, CLI generating, startup).
	WorkingGradFromColor color.Color
	WorkingGradToColor   color.Color
	WorkingLabelColor    color.Color // Label text color next to the indicator

	// Section Title
	Section struct {
		Title mofu.Style
		Line  mofu.Style
	}

	// Initialize
	Initialize struct {
		Header  mofu.Style
		Content mofu.Style
		Accent  mofu.Style
	}

	// LSP
	LSP struct {
		ErrorDiagnostic   mofu.Style
		WarningDiagnostic mofu.Style
		HintDiagnostic    mofu.Style
		InfoDiagnostic    mofu.Style
	}

	// Sidebar
	Sidebar struct {
		SessionTitle mofu.Style // Current session title at top of sidebar
		WorkingDir   mofu.Style // Working directory path (PrettyPath)
	}

	// ModelInfo (model name, provider, reasoning, token/cost summary)
	ModelInfo struct {
		Icon                 mofu.Style // Model icon (◇)
		Name                 mofu.Style // Model name text
		Provider             mofu.Style // "via <provider>" text
		ProviderFallback     mofu.Style // Provider on its own second line
		Reasoning            mofu.Style // Reasoning effort text
		TokenCount           mofu.Style // "(42K)" token count
		TokenPercentage      mofu.Style // "42%" percent of context window
		EstimatedUsagePrefix mofu.Style // "~" prefix for estimated usage
		Cost                 mofu.Style // "$0.42" cost readout
		HypercreditIcon      mofu.Style // Hypercredit icon (◆)
		HypercreditText      mofu.Style // Remaining Hypercredits text
	}

	// Resource styles the LSP/MCP/skills sidebar lists: their heading,
	// each row's status icon, name, status text, and truncation hints.
	Resource struct {
		Heading         mofu.Style // Section header ("LSPs", "MCPs", "Skills")
		Name            mofu.Style // Resource name (e.g. "gopls")
		StatusText      mofu.Style // Row status description (e.g. "starting...")
		OfflineIcon     mofu.Style // Offline/unstarted/stopped status icon
		DisabledIcon    mofu.Style // Disabled status icon
		BusyIcon        mofu.Style // Busy/starting status icon
		ErrorIcon       mofu.Style // Error status icon
		OnlineIcon      mofu.Style // Online/ready status icon
		AdditionalText  mofu.Style // "None" and "…and N more" text
		CapabilityCount mofu.Style // "N tools" / "N prompts" / "N resources"
		RowTitleBase    mofu.Style // Base style applied over row titles in common.Status
		RowDescBase     mofu.Style // Base style applied over row descriptions in common.Status
		DefaultTitleFg  color.Color    // Default title color when opt is zero
		DefaultDescFg   color.Color    // Default description color when opt is zero
	}

	// Files
	Files struct {
		Path           mofu.Style
		Additions      mofu.Style
		Deletions      mofu.Style
		SectionTitle   mofu.Style // "Modified Files" heading
		EmptyMessage   mofu.Style // "None" placeholder when no files
		TruncationHint mofu.Style // "…and N more" message
	}

	// Chat
	// Messages - chat message item styles
	Messages struct {
		UserBlurred      mofu.Style
		UserFocused      mofu.Style
		AssistantBlurred mofu.Style
		AssistantFocused mofu.Style
		NoContent        mofu.Style
		Thinking         mofu.Style
		ErrorTag         mofu.Style
		ErrorTitle       mofu.Style
		ErrorDetails     mofu.Style
		ToolCallFocused  mofu.Style
		ToolCallCompact  mofu.Style
		ToolCallBlurred  mofu.Style
		SectionHeader    mofu.Style

		// Thinking section styles
		ThinkingBox            mofu.Style // Background for thinking content
		ThinkingTruncationHint mofu.Style // "… (N lines hidden)" hint
		ThinkingFooterTitle    mofu.Style // "Thought for" text
		ThinkingFooterDuration mofu.Style // Duration value
		AssistantInfoIcon      mofu.Style
		AssistantInfoModel     mofu.Style
		AssistantInfoProvider  mofu.Style
		AssistantInfoDuration  mofu.Style
		AssistantCanceled      mofu.Style // Italic "Canceled" footer
	}

	// Tool - styles for tool call rendering
	Tool struct {
		// Icon styles with tool status
		IconPending   mofu.Style
		IconSuccess   mofu.Style
		IconError     mofu.Style
		IconCancelled mofu.Style

		// Tool name styles
		NameNormal mofu.Style // Top-level tool name
		NameNested mofu.Style // Nested child tool name (inside Agent/Agentic Fetch)

		// Parameter list styles
		ParamMain mofu.Style
		ParamKey  mofu.Style

		// Content rendering styles
		ContentLine           mofu.Style // Individual content line with background and width
		ContentTruncation     mofu.Style // Truncation message "… (N lines)"
		ContentCodeLine       mofu.Style // Code line with background and width
		ContentCodeTruncation mofu.Style // Code truncation message with bgBase
		ContentCodeBg         color.Color    // Background color for syntax highlighting
		Body                  mofu.Style // Body content padding (PaddingLeft(2))

		// Deprecated - kept for backward compatibility
		ContentBg         mofu.Style // Content background
		ContentText       mofu.Style // Content text
		ContentLineNumber mofu.Style // Line numbers in code

		// State message styles
		StateWaiting   mofu.Style // "Waiting for tool response..."
		StateCancelled mofu.Style // "Canceled."

		// Error styles
		ErrorTag     mofu.Style // ERROR tag
		ErrorMessage mofu.Style // Error message text

		// Warning styles (used for permission denied)
		WarnTag     mofu.Style // WARN tag
		WarnMessage mofu.Style // Warning message text

		// Diff styles
		DiffTruncation mofu.Style // Diff truncation message with padding

		// Multi-edit note styles
		NoteTag     mofu.Style // NOTE tag (yellow background)
		NoteMessage mofu.Style // Note message text

		// Job header styles (for bash jobs)
		JobIconPending mofu.Style // Pending job icon (green dark)
		JobIconError   mofu.Style // Error job icon (red dark)
		JobIconSuccess mofu.Style // Success job icon (green)
		JobToolName    mofu.Style // Job tool name "Bash" (blue)
		JobAction      mofu.Style // Action text (Start, Output, Kill)
		JobPID         mofu.Style // PID text
		JobDescription mofu.Style // Description text

		// Agent task styles
		AgentTaskTag mofu.Style // Agent task tag (blue background, bold)
		AgentPrompt  mofu.Style // Agent prompt text

		// Agentic fetch styles
		AgenticFetchPromptTag mofu.Style // Agentic fetch prompt tag (green background, bold)

		// Todo styles
		TodoRatio          mofu.Style // Todo ratio (e.g., "2/5")
		TodoCompletedIcon  mofu.Style // Completed todo icon
		TodoInProgressIcon mofu.Style // In-progress todo icon
		TodoPendingIcon    mofu.Style // Pending todo icon
		TodoStatusNote     mofu.Style // " · completed N" / " · starting task" trailing note
		TodoItem           mofu.Style // Default body text for todo list items
		TodoJustStarted    mofu.Style // Text of the just-started todo in tool-call bodies

		// MCP tools
		MCPName     mofu.Style // The mcp name
		MCPToolName mofu.Style // The mcp tool name
		MCPArrow    mofu.Style // The mcp arrow icon

		// Images and external resources
		ResourceLoadedText      mofu.Style
		ResourceLoadedIndicator mofu.Style
		ResourceName            mofu.Style
		ResourceSize            mofu.Style
		MediaType               mofu.Style

		// Hooks
		HookLabel        mofu.Style // "Hook" label
		HookName         mofu.Style // Hook command name
		HookMatcher      mofu.Style // Matcher regex pattern
		HookArrow        mofu.Style // Arrow indicator
		HookDetail       mofu.Style // Decision detail text
		HookOK           mofu.Style // "OK" status
		HookDenied       mofu.Style // "Denied" status
		HookDeniedLabel  mofu.Style // "Hook" label when denied
		HookDeniedReason mofu.Style // Denied reason text
		HookRewrote      mofu.Style // "Rewrote Input" indicator

		// Action verb colors for tool-call headers.
		ActionCreate  mofu.Style // Constructive actions (e.g. "Add", "Create")
		ActionDestroy mofu.Style // Destructive actions (e.g. "Remove", "Delete")

		// Tool result helpers.
		ResultEmpty      mofu.Style // "No results" placeholder
		ResultTruncation mofu.Style // "… and N more" truncation line
		ResultItemName   mofu.Style // Item name (left column in result lists)
		ResultItemDesc   mofu.Style // Item description (right column)
	}

	// Dialog styles
	Dialog struct {
		Title              mofu.Style
		TitleText          mofu.Style
		TitleError         mofu.Style
		TitleAccent        mofu.Style
		TitleLineBase      mofu.Style // Base for the gradient ╱╱╱ next to dialog titles
		TitleGradFromColor color.Color    // Default dialog title ╱╱╱ gradient start
		TitleGradToColor   color.Color    // Default dialog title ╱╱╱ gradient end
		// View is the main content area style.
		View          mofu.Style
		PrimaryText   mofu.Style
		SecondaryText mofu.Style
		// HelpView is the line that contains the help.
		HelpView mofu.Style
		Help     struct {
			Ellipsis       mofu.Style
			ShortKey       mofu.Style
			ShortDesc      mofu.Style
			ShortSeparator mofu.Style
			FullKey        mofu.Style
			FullDesc       mofu.Style
			FullSeparator  mofu.Style
		}

		NormalItem   mofu.Style
		SelectedItem mofu.Style
		InputPrompt  mofu.Style

		List mofu.Style

		Spinner mofu.Style

		// ContentPanel is used for content blocks with subtle background.
		ContentPanel mofu.Style

		// Scrollbar styles for scrollable content.
		ScrollbarThumb mofu.Style
		ScrollbarTrack mofu.Style

		// Arguments
		Arguments struct {
			Content                  mofu.Style
			Description              mofu.Style
			InputLabelBlurred        mofu.Style
			InputLabelFocused        mofu.Style
			InputRequiredMarkBlurred mofu.Style
			InputRequiredMarkFocused mofu.Style
		}

		// ListItem styles the info-text rendered alongside list items (commands,
		// models, reasoning options). Sessions have their own overrides below.
		ListItem struct {
			InfoBlurred mofu.Style
			InfoFocused mofu.Style
		}

		Models struct {
			ConfiguredText mofu.Style // "Configured" badge shown on the ModelGroup header
		}

		Permissions struct {
			KeyText   mofu.Style // Left key cell of a key/value row
			ValueText mofu.Style // Right value cell of a key/value row
			ParamsBg  color.Color    // Background color behind highlighted JSON parameters
		}

		Quit struct {
			Content mofu.Style // Wrapper for the quit dialog's inner content
			Frame   mofu.Style // Outer rounded border framing the quit dialog
		}

		APIKey struct {
			Spinner mofu.Style // Loading spinner while validating the key
		}

		OAuth struct {
			Spinner      mofu.Style // Loading spinner
			Instructions mofu.Style // Emphasized instruction text
			UserCode     mofu.Style // Prominent user code display
			Success      mofu.Style // Positive status text (e.g. "Authentication successful!")
			Link         mofu.Style // Underlined verification URL
			Enter        mofu.Style // "enter" keyword highlight in instructions
			ErrorText    mofu.Style // Error message when authentication fails
			StatusText   mofu.Style // Narrative status text ("Initializing...", "Verifying...", etc.)
			UserCodeBg   color.Color    // Background color of the centered user-code box
		}

		ImagePreview mofu.Style

		Sessions struct {
			// styles for when we are in delete mode
			DeletingView                   mofu.Style
			DeletingItemFocused            mofu.Style
			DeletingItemBlurred            mofu.Style
			DeletingTitle                  mofu.Style
			DeletingMessage                mofu.Style
			DeletingTitleGradientFromColor color.Color
			DeletingTitleGradientToColor   color.Color

			// styles for when we are in update mode
			RenamingView                   mofu.Style
			RenamingingItemFocused         mofu.Style
			RenamingItemBlurred            mofu.Style
			RenamingingTitle               mofu.Style
			RenamingingMessage             mofu.Style
			RenamingTitleGradientFromColor color.Color
			RenamingTitleGradientToColor   color.Color
			RenamingPlaceholder            mofu.Style

			InfoBlurred mofu.Style // Timestamp text on unfocused session items
			InfoFocused mofu.Style // Timestamp text on the focused session item
		}
	}

	// Status bar and help
	Status struct {
		Help mofu.Style

		ErrorIndicator   mofu.Style
		WarnIndicator    mofu.Style
		InfoIndicator    mofu.Style
		UpdateIndicator  mofu.Style
		SuccessIndicator mofu.Style

		ErrorMessage   mofu.Style
		WarnMessage    mofu.Style
		InfoMessage    mofu.Style
		UpdateMessage  mofu.Style
		SuccessMessage mofu.Style
	}

	// Completions popup styles
	Completions struct {
		Normal  mofu.Style
		Focused mofu.Style
		Match   mofu.Style
	}

	// Attachments styles
	Attachments struct {
		Normal   mofu.Style
		Image    mofu.Style
		Text     mofu.Style
		Skill    mofu.Style
		Deleting mofu.Style
	}

	// Pills styles for todo/queue pills
	Pills struct {
		Base               mofu.Style // Base pill style with padding
		Focused            mofu.Style // Focused pill with visible border
		Blurred            mofu.Style // Blurred pill with hidden border
		QueueItemPrefix    mofu.Style // Prefix for queue list items
		QueueItemText      mofu.Style // Queue list item body text
		QueueLabel         mofu.Style // "N Queued" label text
		QueueIconBase      mofu.Style // Base style for queue gradient triangles
		QueueGradFromColor color.Color    // Start color for queue indicator gradient
		QueueGradToColor   color.Color    // End color for queue indicator gradient
		TodoLabel          mofu.Style // "To-Do" label
		TodoProgress       mofu.Style // Todo ratio (e.g. "2/5")
		TodoCurrentTask    mofu.Style // Current in-progress task name
		TodoSpinner        mofu.Style // Todo spinner style
		HelpKey            mofu.Style // Keystroke hint style
		HelpText           mofu.Style // Help action text style
		Area               mofu.Style // Pills area container
	}
}

// ChromaTheme converts the current markdown chroma styles to a chroma
// StyleEntries map.
func (s *Styles) ChromaTheme() chroma.StyleEntries {
	rules := s.Markdown.CodeBlock

	return chroma.StyleEntries{
		chroma.Text:                chromaStyle(rules.Chroma.Text),
		chroma.Error:               chromaStyle(rules.Chroma.Error),
		chroma.Comment:             chromaStyle(rules.Chroma.Comment),
		chroma.CommentPreproc:      chromaStyle(rules.Chroma.CommentPreproc),
		chroma.Keyword:             chromaStyle(rules.Chroma.Keyword),
		chroma.KeywordReserved:     chromaStyle(rules.Chroma.KeywordReserved),
		chroma.KeywordNamespace:    chromaStyle(rules.Chroma.KeywordNamespace),
		chroma.KeywordType:         chromaStyle(rules.Chroma.KeywordType),
		chroma.Operator:            chromaStyle(rules.Chroma.Operator),
		chroma.Punctuation:         chromaStyle(rules.Chroma.Punctuation),
		chroma.Name:                chromaStyle(rules.Chroma.Name),
		chroma.NameBuiltin:         chromaStyle(rules.Chroma.NameBuiltin),
		chroma.NameTag:             chromaStyle(rules.Chroma.NameTag),
		chroma.NameAttribute:       chromaStyle(rules.Chroma.NameAttribute),
		chroma.NameClass:           chromaStyle(rules.Chroma.NameClass),
		chroma.NameConstant:        chromaStyle(rules.Chroma.NameConstant),
		chroma.NameDecorator:       chromaStyle(rules.Chroma.NameDecorator),
		chroma.NameException:       chromaStyle(rules.Chroma.NameException),
		chroma.NameFunction:        chromaStyle(rules.Chroma.NameFunction),
		chroma.NameOther:           chromaStyle(rules.Chroma.NameOther),
		chroma.Literal:             chromaStyle(rules.Chroma.Literal),
		chroma.LiteralNumber:       chromaStyle(rules.Chroma.LiteralNumber),
		chroma.LiteralDate:         chromaStyle(rules.Chroma.LiteralDate),
		chroma.LiteralString:       chromaStyle(rules.Chroma.LiteralString),
		chroma.LiteralStringEscape: chromaStyle(rules.Chroma.LiteralStringEscape),
		chroma.GenericDeleted:      chromaStyle(rules.Chroma.GenericDeleted),
		chroma.GenericEmph:         chromaStyle(rules.Chroma.GenericEmph),
		chroma.GenericInserted:     chromaStyle(rules.Chroma.GenericInserted),
		chroma.GenericStrong:       chromaStyle(rules.Chroma.GenericStrong),
		chroma.GenericSubheading:   chromaStyle(rules.Chroma.GenericSubheading),
		chroma.Background:          chromaStyle(rules.Chroma.Background),
	}
}

// DialogHelpStyles returns the styles for dialog help.
func (s *Styles) DialogHelpStyles() helpStyles {
	return helpStyles(s.Dialog.Help)
}

// hex returns a pointer to the "#rrggbb" representation of c. It's used to
// satisfy glamour's string-pointer API when configuring markdown colors
// from the theme palette.
func hex(c color.Color) *string {
	r, g, b, _ := c.RGBA()
	s := fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
	return &s
}

func chromaStyle(style stylePrimitive) string {
	var s strings.Builder

	if style.Color != nil {
		s.WriteString(*style.Color)
	}
	if style.BackgroundColor != nil {
		if s.Len() > 0 {
			s.WriteString(" ")
		}
		s.WriteString("bg:")
		s.WriteString(*style.BackgroundColor)
	}
	if style.Italic != nil && *style.Italic {
		if s.Len() > 0 {
			s.WriteString(" ")
		}
		s.WriteString("italic")
	}
	if style.Bold != nil && *style.Bold {
		if s.Len() > 0 {
			s.WriteString(" ")
		}
		s.WriteString("bold")
	}
	if style.Underline != nil && *style.Underline {
		if s.Len() > 0 {
			s.WriteString(" ")
		}
		s.WriteString("underline")
	}

	return s.String()
}
