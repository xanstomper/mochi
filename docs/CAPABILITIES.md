# Mochi Complete Capabilities & System Reference

Mochi is an autonomous, high-performance software engineering agent and multi-agent swarm orchestrator. It combines a compiled **zero-dependency Rust core runtime** (`native/mochi_core`) for high-throughput compute with a **rich TypeScript TUI frontend** for model I/O, tool execution, and user interaction.

---

## 1. The 16 Specialized Subagent Roles

Mochi can dynamically spawn specialized child agents via the `subagent` tool, or orchestrate multi-agent swarms using `mochi team "<goal>"`. Each role is assigned a specific model capability profile (`reasoning`, `coding`, `fast`, `review`) and a scoped tool allowlist:

| Role | Profile Name | Model Tier | Permitted Tools | Core Function & Responsibility |
| :--- | :--- | :--- | :--- | :--- |
| **`lead`** | Lead Orchestrator | `reasoning` | `read`, `search`, `glob`, `git`, `inspect`, `chameleon`, `fetch`, `web_search`, `web_crawl`, `think`, `subagent` | Decomposes complex goals into DAGs, assigns tasks, coordinates subagent swarms, resolves blockers. |
| **`coder`** | Senior Software Engineer | `coding` | `read`, `write`, `edit`, `delete`, `patch`, `shell`, `search`, `glob`, `git`, `inspect`, `chameleon`, `fetch`, `web_search`, `web_crawl`, `think`, `diff`, `tree` | Full-stack software implementation, surgical diff editing, headless test verification. |
| **`reviewer`** | Code Reviewer | `review` | `read`, `search`, `glob`, `git`, `inspect`, `diff`, `analyze_code` | Read-only PR & diff inspections, SOLID/DRY audits, edge-case analysis. No file edit permissions. |
| **`tester`** | Test Automation Engineer | `fast` | `read`, `search`, `glob`, `shell`, `inspect`, `edit`, `write`, `patch` | Unit & integration test creation, bug reproduction scripts, test suite execution. |
| **`researcher`** | Codebase Researcher | `fast` | `read`, `search`, `glob`, `get_function`, `find_callers`, `type_hierarchy`, `inspect`, `fetch`, `web_search`, `web_crawl`, `think`, `deepwiki` | AST & call-graph traversal, documentation indexing, web research. Read-only. |
| **`debugger`** | Systems Debugger | `reasoning` | `read`, `search`, `glob`, `get_function`, `find_callers`, `type_hierarchy`, `inspect`, `shell`, `edit`, `patch` | Root-cause diagnosis, hypothesis testing, temporary telemetry/logging injection. |
| **`security`** | Security Auditor | `reasoning` | `read`, `search`, `glob`, `inspect`, `analyze_code` | OWASP Top 10 auditing, data-flow threat modeling, secret & credential leakage detection. |
| **`architect`** | Principal Systems Architect | `reasoning` | `read`, `search`, `glob`, `inspect`, `get_function`, `find_callers`, `type_hierarchy`, `chameleon`, `think` | API contract design, distributed systems trade-offs, interface schemas, service boundaries. |
| **`devops`** | DevOps & SRE | `coding` | `read`, `write`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect`, `git` | Dockerfiles, Kubernetes manifests, CI/CD pipelines (GitHub Actions), Terraform scripts. |
| **`db_admin`** | Database Administrator | `reasoning` | `read`, `write`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect`, `sql_codebase`, `db_inspect` | Schema migrations, index design, query optimization, EXPLAIN plan analysis. |
| **`frontend`** | Frontend UX/UI Expert | `coding` | `read`, `write`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect`, `chameleon` | React/Vue/Svelte components, CSS Grid/Flexbox, Tailwind, a11y, state optimization. |
| **`backend`** | Backend API Engineer | `coding` | `read`, `write`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect`, `chameleon` | RESTful/GraphQL/gRPC APIs, concurrency controls, idempotency, distributed locking. |
| **`performance`**| Performance Engineer | `reasoning` | `read`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect`, `perf` | CPU hotspot profiling, memory leak detection, Big-O complexity optimization. |
| **`tech_writer`** | Technical Writer | `coding` | `read`, `write`, `edit`, `patch`, `search`, `glob`, `inspect` | Architecture Decision Records (ADRs), READMEs, Mermaid diagrams, API references. |
| **`qa_engineer`**| QA Automation Engineer | `coding` | `read`, `write`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect` | End-to-end automation (Playwright/Cypress), visual regression tests, smoke testing. |
| **`data_scientist`**| Data Scientist / ML Engineer | `reasoning`| `read`, `write`, `edit`, `patch`, `shell`, `search`, `glob`, `inspect` | Pandas/Polars wrangling, PyTorch/TensorFlow modeling, statistical evaluation. |

---

## 2. Native Tools Suite

Mochi ships with 30+ built-in tools covering file operations, AST intelligence, shell execution, web crawling, and diagnostic tools:

### File & Code Editing Tools
- **`edit`**: Performs surgical, anchor-matched text replacements with whitespace tolerance.
- **`patch`**: Multi-file, unified diff patcher (`*** Begin Patch / Add File / Update File / Delete File`).
- **`write`**: Creates new files or performs full-file writes.
- **`delete`**: Safely removes files with project-root safety guards.
- **`read`**: Reads file contents with line numbers, or extracts compact AST structural skeletons (`skeleton: true`) with 85% token reduction.
- **`replace_symbol`**: AST-driven whole-function or class rewriter without anchor drift.
- **`rename_symbol`**: Project-wide atomic identifier renamer matching exact word boundaries across all codebase files.
- **`search_replace_multi`**: Atomic multi-file find-and-replace across a whole project.
- **`regex_replace`**: Pattern-based regular expression editor.

### AST & Code Intelligence Tools
- **`get_function`**: Extracts function/method definition and body by symbol name.
- **`find_callers`**: Finds all invocation sites and call hierarchies of a function.
- **`type_hierarchy`**: Resolves class/interface inheritance and implementation graphs.
- **`find_references`**: Locates all symbol references across the workspace.
- **`find_definitions`**: Navigates directly to type, variable, or interface definitions.
- **`analyze_code`**: AST complexity analysis, cyclomatic complexity, and code smell scanner.

### Shell, Execution & Inspection Tools
- **`repl`**: In-process interactive runtime evaluator for JavaScript/Node.js, Python, and Shell snippets with state persistence.
- **`shell`**: Executes commands in the workspace. Supports `background: true` for asynchronous jobs.
- **`search`**: Native N-API accelerated regex/text search over the workspace in sub-millisecond time.
- **`glob`**: Fast file finding matching glob patterns.
- **`inspect`**: Summarizes directory trees, file sizes, and language compositions.
- **`tree`**: Generates ASCII visual directory trees.
- **`diff`**: High-throughput Myers unified diff engine accelerated in native Rust.
- **`git`**: Safe git operations (branch, status, log, diff, commit).
- **`git_blame`**: Discovers author and commit history per line.
- **`git_history`**: File commit log and mutation timeline.

### Research & Web Crawling
- **`web_search`**: Searches the web for documentation, solutions, and API specs.
- **`web_crawl`**: Breadth-first web crawler with HTML-to-Markdown text extraction.
- **`fetch`**: HTTP client for raw GET/POST requests.
- **`deepwiki`**: Built-in documentation server and query tool.

### Agentic Orchestration & State
- **`subagent`**: Spawns a fresh child agent with its own context to solve an isolated subtask.
- **`skill`**: Dynamically loads specialized workflow guidelines by name.
- **`todo`**: Manages shared multi-step task checklists.
- **`memory`**: Curates durable cross-session facts and project knowledge.
- **`verify`**: Executes narrow verification checks to prove behavioral correctness.
- **`perf`**: CPU and memory profiling tool.
- **`think`**: Scratchpad for deep step-by-step reasoning.
- **`chameleon`**: Dynamic synthetic-parameter reasoning enhancer.
- **`db_inspect`**: Inspects database schemas, tables, and indices.
- **`create_pr`**: Synthesizes pull request descriptions and creates git PRs.

---

## 3. Specialized Skills Catalog

Mochi includes 30+ bundled `SKILL.md` workflows that can be invoked via the `skill` tool or command palette:

- **AI Architectures & Protocols**: `gpt-5-agent`, `o3-reasoning`, `deep-research`, `anthropic-research`, `cursor-workflow`, `devin-mode`, `github-copilot`, `vscode-copilot`, `gemini-learning`, `claude-design`, `hermes-workflow`.
- **System Integration Guides**: `mcp-setup`, `acp-setup`, `mochi-architecture`, `core-harness`, `tools-design`, `memory-design`, `replication-design`.
- **Domain Engineering Skills**: `rust-engineer`, `golang-pro`, `python-expert`, `typescript-master`, `frontend-craft`, `backend-architecture`, `docker-containerization`, `database-optimizer`, `performance-profiling`, `security-audit`, `tdd-workflow`, `code-refactoring`, `code-review`, `api-design`, `git-wizard`.

---

## 4. MCP & ACP Protocol Support

### Model Context Protocol (MCP)
Mochi can connect to any external MCP server (Postgres, GitHub, SQLite, Sentry) configured in `~/.mochi/config.json`:
```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

### Agent Client Protocol (ACP) v1
Mochi natively speaks ACP v1 over stdio, enabling IDE extensions (VSCode, Cursor, Zed) to run Mochi as a backend daemon:
```bash
mochi acp
```
