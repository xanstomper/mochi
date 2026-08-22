---
name: tools-design
description: Design document for tool dispatcher and schema
---

# LAZY CHAMELEON - Tool System & Plugins

## Tool-Builder Design Document

### Tool Base
class Tool:
    name: str
    description: str
    input_schema: dict
    permission_level: str  # read/write/destructive
    timeout: int = 30
    async def execute(self, params) -> ToolResult: pass

### Core Tools

1. SearchTool (ripgrep)
   Input: {query, path?, context_lines?}
   Returns: [{file, line, content, context}]
   Permission: read

2. ReadTool
   Input: {path, start_line?, end_line?}
   Returns: str (file content)
   Permission: read

3. EditTool
   Input: {path, old_string, new_string}
   Returns: {success, diff, new_lines}
   Permission: write

4. TerminalTool
   Input: {command, timeout=30, workdir?}
   Returns: {stdout, stderr, exit_code}
   Permission: write (sandboxed)

5. GitTool
   Operations: status, diff, log, commit, branch, add
   Permission: write (for commits)

6. TestTool
   Input: {framework: pytest/cargo/npm/go, path?, args?}
   Returns: {passed, failed, error, duration}
   Permission: write

7. CompileTool
   Actions: compile (gcc/clang/rustc/tsc), lint (ruff/eslint/clippy)
   Permission: write

8. PackageTool
   Actions: install, update, info
   Permission: write

### Security Sandbox (L34)
BLOCKED_PATTERNS = [rm -rf /, >/dev/sd, mkfs, dd if=, wget|sh, sudo]
ALLOWED_DIRS = [cwd, ~, /tmp]

class SecuritySandbox:
    def check_command(self, cmd):
        for pattern in BLOCKED_PATTERNS:
            if re.search(pattern, cmd):
                return BLOCKED(reason=pattern)
        return ALLOWED

    def check_file_access(self, path):
        real = os.path.realpath(path)
        return any(real.startswith(d) for d in ALLOWED_DIRS)

### Expert Router (L17)
class ExpertRouter:
    def route(self, task):
        RULES = {
            "architecture": ["arch", "design", "system", "pattern"],
            "rust": ["rust", "cargo", "unsafe"],
            "linux": ["linux", "kernel", "systemd"],
            "debug": ["bug", "fix", "crash", "error"],
            "security": ["security", "vuln", "injection", "auth"],
        }
        return [e for e, keywords in RULES.items()
                if any(k in task.lower() for k in keywords)]

### Plugin Architecture (L37)
class Plugin:
    name: str
    version: str
    tools: list[Tool] = []
    hooks: dict = {}  # event -> handler

class PluginManager:
    def __init__(self, plugin_dir):
        self.plugins = {}
        self._discover(plugin_dir)

    def load_plugin(self, path):
        spec = importlib.util.spec_from_file_location("plugin", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        p = module.Plugin()
        self.plugins[p.name] = p

    def get_all_tools(self):
        return [t for p in self.plugins.values() for t in p.tools]

    def run_hooks(self, event, context):
        for p in self.plugins.values():
            if event in p.hooks:
                p.hooks[event](context)
