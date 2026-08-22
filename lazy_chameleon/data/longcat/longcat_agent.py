"""LongCatAgent — Agentic coding harness adapted from LongCat-2.0 (Claude Code, Openclaw, Hermes)."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

@dataclass
class AgentAction:
    tool: str
    input: str
    output: str = ""
    success: bool = False

class LongCatAgent:
    def __init__(self):
        self._actions: List[AgentAction] = []
        self._tools: Dict[str, Callable] = {}

    def register_tool(self, name: str, fn: Callable, description: str = ""):
        self._tools[name] = fn

    def get_available_tools(self) -> List[str]:
        return list(self._tools.keys())

    def execute(self, tool: str, input_text: str) -> AgentAction:
        fn = self._tools.get(tool)
        action = AgentAction(tool=tool, input=input_text)
        if fn:
            try:
                action.output = str(fn(input_text))
                action.success = True
            except Exception as e:
                action.output = str(e)
        else:
            action.output = f"Tool '{tool}' not found"
        self._actions.append(action)
        return action

    def run_code_task(self, task: str) -> List[AgentAction]:
        actions = []
        action = self.execute("code_generation", task)
        actions.append(action)
        if action.success:
            test_action = self.execute("code_review", action.output)
            actions.append(test_action)
        return actions

    def get_history(self) -> List[AgentAction]:
        return list(self._actions)
