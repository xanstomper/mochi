# Mochi CLI & Interface Reference

Complete command-line interface, interactive TUI, slash commands, and hotkey reference for Mochi.

---

## 1. CLI Commands

```bash
# Interactive TUI Mode
mochi                                # Launch the interactive terminal UI
mochi "your prompt here"             # Start TUI preloaded with a prompt

# One-Shot Headless Runs
mochi "refactor auth service"        # Execute a coding task directly to completion

# Multi-Agent Swarms
mochi team "build payment gateway"   # Decompose and run across role-diverse agent swarm

# Persistent Daemon Mode
mochi daemon start --host 0.0.0.0    # Start background daemon on port 8642
mochi daemon status                  # Check running daemon status and active jobs
mochi daemon send "run test suite"   # Send task to running daemon
mochi daemon jobs                    # List all in-flight and completed jobs
mochi daemon stop                    # Stop background daemon

# Session Management
mochi session list                   # List past session transcripts
mochi session search "<query>"       # Full-text SQLite+FTS5 search across all past sessions

# Termix Split-Pane Interface
mochi termix                         # Launch split-pane agent workspace
mochi termix --sessions 3            # Launch with 3 concurrent agent panes

# ACP Editor Server
mochi acp                            # Launch Agent Client Protocol v1 stdio server

# Diagnostics & Skills
mochi doctor                         # Run health check on workspace, tools, and compilers
mochi skills                         # List all bundled and project skills
mochi trace <goalId>                 # Replay and inspect execution trace of a goal
```

---

## 2. Interactive TUI Slash Commands

When inside the Mochi terminal UI, type `/` to open the autocomplete menu:

| Command | Description |
| :--- | :--- |
| `/help` | Display interactive command cheat-sheet |
| `/clear` | Clear visible transcript lines |
| `/new` or `/clear-all` | Start a completely fresh session (clears checkpoints and state) |
| `/history` or `/sessions` | Interactive session switcher & history browser |
| `/rename` | Rename the current session |
| `/export` | Export session transcript to JSON |
| `/import` | Import and replay a saved session |
| `/model` | Interactive model & provider selector |
| `/theme` | Interactive 15-theme live preview and switcher |
| `/doctor` | Diagnose workspace configuration, tools, and permissions |
| `/usage` | Show token usage, cost, and cache efficiency |
| `/init` | Scaffold project `MOCHI.md` configuration |
| `/branch` | View active git status and branch info |
| `/commit` | Create a git checkpoint commit |
| `/run <cmd>` or `/shell <cmd>` | Execute a shell command directly in the workspace |
| `/test` | Run the project's detected test suite |
| `/review` | Run an automated code review on current diffs |
| `/diff` | Show colorized git diff of pending modifications |
| `/rollback` | Roll back to the last git checkpoint |
| `/yolo` | Toggle auto-approve mode for all tools |
| `/stop` or `/skip` | Interrupt in-flight agent turn |
| `/exit` or `/quit` | Exit Mochi |

---

## 3. Keyboard Shortcuts

| Keybinding | Action |
| :--- | :--- |
| **`Tab`** | Toggle between **Plan** mode (read-only blueprinting) and **Act** mode (execution) |
| **`Shift + Tab`** | Toggle **Auto-Approve** (bypasses approval prompts for tools) |
| **`Ctrl + C`** | Cancel current in-flight agent task / thinking stream (double-press to exit) |
| **`Esc`** | Cancel current task / close menus / clear input |
| **`Up / Down`** | Navigate prompt history or dropdown items |
| **`PageUp / PageDown`** | Scroll transcript viewport |
| **`Ctrl + L`** | Clear transcript view |
