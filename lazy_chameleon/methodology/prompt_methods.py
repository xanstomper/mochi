"""PromptMethods — Advanced prompt engineering techniques."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

@dataclass
class PromptTechnique:
    name: str
    template: str
    description: str
    best_for: List[str]

class PromptMethod:
    TECHNIQUES: Dict[str, PromptTechnique] = {
        "chain_of_thought": PromptTechnique(
            name="Chain-of-Thought",
            template="Let's think step by step.\n{question}",
            description="Encourages step-by-step reasoning",
            best_for=["math", "logic", "puzzles"],
        ),
        "few_shot": PromptTechnique(
            name="Few-Shot",
            template="Examples:\n{examples}\n\nNow solve: {question}",
            description="Provide examples before asking",
            best_for=["classification", "formatting"],
        ),
        "tree_of_thought": PromptTechnique(
            name="Tree-of-Thought",
            template="Consider multiple paths:\n{paths}\n\nEvaluate each and choose the best.",
            description="Explores multiple reasoning branches",
            best_for=["planning", "strategy"],
        ),
        "reflexion": PromptTechnique(
            name="Reflexion",
            template="Attempt: {attempt}\nFeedback: {feedback}\nImproved: ",
            description="Self-critique and improve",
            best_for=["debugging", "writing"],
        ),
        "self_consistency": PromptTechnique(
            name="Self-Consistency",
            template="Solve this {n} times:\n{question}\n\nTake majority vote.",
            description="Multiple attempts with majority voting",
            best_for=["math", "reasoning"],
        ),
        "structured_output": PromptTechnique(
            name="Structured Output",
            template="Return a valid JSON object with fields: {fields}\n\n{question}",
            description="Enforce JSON/structured output",
            best_for=["data_extraction", "api_calls"],
        ),
        "rag_context": PromptTechnique(
            name="RAG Context",
            template="Context: {context}\n\nQuestion: {question}\n\nAnswer based on context.",
            description="Ground responses in provided context",
            best_for=["qa", "research"],
        ),
        "persona_role": PromptTechnique(
            name="Persona/Role",
            template="You are a {role}. {instruction}",
            description="Assign a role/persona before task",
            best_for=["creative", "expert_opinion"],
        ),
    }

    def __init__(self):
        pass

    def apply(self, technique_name: str, **kwargs) -> str:
        tech = self.TECHNIQUES.get(technique_name)
        if not tech:
            raise ValueError(f"Unknown technique: {technique_name}")
        return tech.template.format(**kwargs)

    def list_techniques(self) -> List[Dict]:
        return [{"name": t.name, "description": t.description, "best_for": t.best_for} for t in self.TECHNIQUES.values()]

    def recommend(self, domain: str) -> List[str]:
        return [name for name, t in self.TECHNIQUES.items() if domain in t.best_for]
