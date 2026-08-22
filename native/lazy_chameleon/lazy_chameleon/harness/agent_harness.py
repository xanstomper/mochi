"""AgentHarness — Perfect tool-calling interface for AI agents."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import time
import logging

logger = logging.getLogger(__name__)


class AgentHarness:
    def __init__(self):
        self._tools: Dict[str, Dict] = {}
        self._history: List[Dict] = []
        self._register()

    def _register(self):
        self._tools["enhance"] = {
            "name": "enhance",
            "description": "Generate synthetic parameter context for any task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "Task to enhance"},
                    "mode": {"type": "string", "enum": ["easy", "medium", "hard", "extreme"], "default": "medium"},
                    "domain": {"type": "string", "enum": ["math", "code", "reasoning", "science", "general"], "default": "general"},
                },
                "required": ["task"],
            },
        }
        self._tools["data_summary"] = {
            "name": "data_summary",
            "description": "Get summary of all 1200+ training examples.",
            "parameters": {"type": "object", "properties": {}},
        }
        self._tools["models_list"] = {
            "name": "models_list",
            "description": "List all frontier models with details.",
            "parameters": {"type": "object", "properties": {}},
        }
        self._tools["research_summary"] = {
            "name": "research_summary",
            "description": "Get summary of all research (31 entries).",
            "parameters": {"type": "object", "properties": {}},
        }
        self._tools["config"] = {
            "name": "config",
            "description": "Get Lazy Chameleon configuration.",
            "parameters": {"type": "object", "properties": {}},
        }

    def get_tools(self) -> List[Dict]:
        return [{
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            }
        } for t in self._tools.values()]

    def call_tool(self, name: str, **kwargs) -> Dict:
        t0 = time.time()
        try:
            data = self._route(name, kwargs)
            resp = {"success": True, "tool": name, "data": data, "latency_s": round(time.time() - t0, 3)}
        except Exception as e:
            resp = {"success": False, "tool": name, "error": str(e), "latency_s": round(time.time() - t0, 3)}
        self._history.append({"tool": name, "params": kwargs, "response": resp})
        return resp

    def _route(self, name: str, params: Dict) -> Any:
        from lazy_chameleon.cli.unified_cli import build_parser, _dispatch
        mapping = {
            "enhance": lambda p: f"enhance {p.get('task','')} --mode {p.get('mode','medium')} --domain {p.get('domain','general')}".split(),
            "data_summary": lambda p: "data summary".split(),
            "models_list": lambda p: "models list".split(),
            "research_summary": lambda p: "research summary".split(),
            "config": lambda p: "config show".split(),
        }
        fn = mapping.get(name)
        if not fn:
            return {"error": f"Unknown tool: {name}", "available": list(mapping.keys())}
        cmd = fn(params)
        parser = build_parser()
        args = parser.parse_args(cmd)
        return _dispatch(args)

    def get_history(self, n: int = 5) -> List[Dict]:
        return self._history[-n:]

    def get_harness_context(self) -> str:
        lines = ["LAZY CHAMELEON AGENT HARNESS v2.6"]
        lines.append(f"Tools available: {len(self._tools)}")
        for t in self._tools.values():
            lines.append(f"  - {t['name']}: {t['description']}")
        lines.append("Usage: call_tool(name, **params) returns {success, data, latency_s}")
        return "\n".join(lines)


_harness: Optional[AgentHarness] = None

def get_harness() -> AgentHarness:
    global _harness
    if _harness is None:
        _harness = AgentHarness()
    return _harness
