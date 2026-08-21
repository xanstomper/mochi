---
name: python-expert
description: Python modern best practices, asyncio, FastAPI, Pytest, Pydantic, Poetry/uv, type hints, and performance optimization.
tools: [read, write, edit, patch, shell, glob, search, verify]
---

# Python Expert Skill

## Modern Python Best Practices (Python 3.11+)
- **Type Annotations:** Use explicit type hints everywhere. Use `typing` / built-in generics (`list[str]`, `dict[str, Any]`, `X | None`).
- **AsyncIO Concurrency:** Always avoid blocking calls (e.g. `time.sleep`, synchronous `requests.get`) inside `async def` functions; use `asyncio.sleep` and `httpx.AsyncClient`.
- **Data Validation:** Use Pydantic v2 `BaseModel` and `dataclasses` for domain models and data transfer objects.
- **Dependency & Virtual Env Management:** Prefer `uv` or `poetry` for fast, reproducible lockfiles.
- **Testing:** Pytest with fixtures, `@pytest.mark.asyncio`, and `@pytest.mark.parametrize`.
