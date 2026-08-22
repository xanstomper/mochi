"""PromptSynthesizer — Generate optimized prompts for any task."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import random

class PromptSynthesizer:
    def __init__(self):
        self.rng = random.Random(42)
        self._templates = self._load_templates()

    def _load_templates(self) -> Dict[str, List[str]]:
        return {
            "math": ["Solve this problem step by step: {task}", "Calculate: {task}", "Find the answer: {task}"],
            "code": ["Write code to: {task}", "Implement: {task}", "Create a function that {task}"],
            "reasoning": ["Think through: {task}", "Reason about: {task}", "Analyze: {task}"],
            "creative": ["Write about: {task}", "Create: {task}", "Compose: {task}"],
            "general": ["Answer: {task}", "Explain: {task}", "Describe: {task}"],
        }

    def synthesize(self, task: str, domain: str = "general", style: str = None) -> str:
        templates = self._templates.get(domain, self._templates["general"])
        template = style if style else self.rng.choice(templates)
        return template.format(task=task)

    def batch_synthesize(self, tasks: List[str], domain: str = "general") -> List[str]:
        return [self.synthesize(t, domain) for t in tasks]
