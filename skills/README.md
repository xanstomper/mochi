# Mochi Built-in Skills Catalog

This directory contains Mochi's bundled skills (`SKILL.md` files). Skills are YAML-frontmattered markdown files that provide the agent with specialized instructions, protocols, and architectural knowledge on demand. 

Because we've unlocked the limit for `deepseek-v4-flash`, the model is natively aware of *all* these skills and can pull them into context precisely when needed using the `skill` tool.

## Advanced Agent Knowledge & Protocols
We have ported leaked internal system prompts, architectures, and design constraints from state-of-the-art AI systems to give Mochi the same deductive reasoning and execution capabilities:
- **`cursor-workflow`**: Cursor IDE coding behaviors.
- **`github-copilot`**: GitHub Copilot Workspace code synthesis.
- **`devin-mode`**: Devin CLI autonomous agent execution procedures.
- **`gpt-5-agent`**: GPT-5 advanced autonomous agent reasoning protocols.
- **`o3-reasoning`**: OpenAI o3 step-by-step logic and verification instructions.
- **`claude-design`**: Anthropic Claude system design constraints.
- **`gemini-learning`**: Google Gemini 2.5 guided learning behaviors.
- **`deep-research`**: OpenAI Deep Research instructions and methodology.
- **`anthropic-research`**: Anthropic research protocols & file search behaviors.
- **`openai-canvas-canmore`**: OpenAI Canvas code editing protocols.
- **`openai-advanced-memory`**: OpenAI advanced memory tool behaviors.

## System Architecture & Integration Guides
- **`mcp-setup`**: How to configure Model Context Protocol (MCP) servers to extend Mochi with Postgres, GitHub, and other tools.
- **`acp-setup`**: How to connect editors (VSCode, Zed) to Mochi using the Agent Client Protocol (ACP) v1.
- **`mochi-architecture`**: Mochi's internal architecture design.
- **`core-harness`**: Design document for core LLM harnesses.
- **`tools-design`**: Design document for tool dispatchers and schemas.
- **`memory-design`**: Advanced agentic memory handling architectures.
- **`replication-design`**: Blueprints for agent swarms and replication.

## Language & Framework Mastery
(Also includes 25+ language/framework specific workflows like `rust-engineer`, `golang-pro`, `frontend-craft`, `docker-containerization`, etc.)

## Usage
Simply type `skill list` in the Mochi TUI, or ask the agent directly to "use the deep-research skill" when tackling complex tasks!
