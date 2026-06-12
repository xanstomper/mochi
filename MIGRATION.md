# Mochi → MOFU Migration Plan

## Scope

- 523 Go files, 3.5MB code
- 61 files import bubbletea
- 67 files import lipgloss  
- 56 files import bubbles
- 30 files import ultraviolet
- 5 files import glamour
- 530 total Bubble Tea type references

## Phase 1: Foundation (this session)
- [x] Map all dependencies
- [ ] Add MOFU to go.mod
- [ ] Create type replacement in main model (ui.go)
- [ ] Migrate cmd/root.go entry point
- [ ] Migrate anim/, styles/, util/
- [ ] Migrate common/ infrastructure

## Phase 2: Core UI (next session)
- [ ] Migrate model/ui.go (main model, 4338 lines)
- [ ] Migrate model/chat.go
- [ ] Migrate model/sidebar.go, header.go, status.go, pills.go
- [ ] Migrate dialog/ (14 files)
- [ ] Migrate list/ (6 files)
- [ ] Migrate completions/

## Phase 3: Chat & Rendering (next session)
- [ ] Migrate chat/ (14 files)
- [ ] Migrate diffview/ (5 files)
- [ ] Migrate common/ (8 files)
- [ ] Migrate image/, logo/, notification/
- [ ] Migrate streamviz/, banner/

## Phase 4: Non-UI (next session)
- [ ] Migrate app/, cmd/, workspace/
- [ ] Migrate backend/, format/
- [ ] Replace lipgloss in all non-UI files

## Type Replacements

| Bubble Tea | MOFU |
|-----------|------|
| `tea.Model` | `mofu.Node` (embed `mofu.Minimal`) |
| `tea.Cmd` | `mofu.Cmd` |
| `tea.Msg` | `mofu.Msg` |
| `tea.Program` | `mofu.Program` |
| `tea.Batch()` | `mofu.Batch()` |
| `tea.Sequence()` | `mofu.Sequence()` |
| `tea.Tick()` | `mofu.Tick()` |
| `tea.Every()` | `mofu.Every()` |
| `tea.Quit` | `mofu.Quit()` |
| `tea.WindowSizeMsg` | `mofu.WindowSizeMsg` |
| `tea.KeyPressMsg` | `mofu.KeyEvent` |
| `tea.MouseClickMsg` | `mofu.MouseClickMsg` |
| `tea.PasteMsg` | `mofu.PasteEvent` |
| `tea.ExecProcess()` | `mofu.ExecProcessMsg` |
| `lipgloss.Style` | `mofu.Style` |
| `lipgloss.Color` | `mofu.Color` |
| `lipgloss.NewStyle()` | `mofu.DefaultStyle()` |
| `uv.ScreenBuffer` | `mofu.Renderer` |
| `bubbles/textarea.Model` | `mofu.Textarea` |
| `bubbles/spinner.Model` | `mofu.Spinner` |
| `bubbles/help.Model` | `mofu.HelpComponent` |
| `bubbles/key.Binding` | `mofu.Binding` |
| `bubbles/key.Matches()` | `keyMap.Matches()` |
