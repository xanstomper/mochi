---
name: replication-design
description: Design document for agent replication/swarms
---

# LAZY CHAMELEON - Replication Engine

## Replication-Expert Design Document

### ReplicationEngine (L27)
Studying frontier models and replicating their reasoning patterns.

class ReplicationEngine:
    def __init__(self):
        self.teachers = {
            "claude": LLMClient("anthropic", "claude-opus-4.8"),
            "deepseek": LLMClient("opencode", "deepseek-v4-flash"),
            "gpt5": LLMClient("openai", "gpt-5"),
            "glm": LLMClient("zhipu", "glm-5"),
        }
        self.library = PatternLibrary()

    async def extract(self, task):
        patterns = {}
        for name, teacher in self.teachers.items():
            resp = await teacher.generate(self._extraction_prompt(task))
            patterns[name] = self._parse(resp)
        return self._synthesize(patterns)

    def _extraction_prompt(self, task):
        return f"Solve step by step. Show: 1. Analysis 2. Approaches considered 3. Verification 4. Edge cases 5. Finalization"

    def _synthesize(self, patterns):
        # Models agree -> consensus. Disagree -> find correct approach
        consensus = self._find_consensus(patterns)
        special = self._find_specializations(patterns)
        return ReasoningPattern(consensus_steps=consensus, specialized=special)

### PatternLibrary
class PatternLibrary:
    def __init__(self):
        self.patterns = {}  # category -> list of patterns
        self._load()

    def get_for_task(self, task):
        cat = self._classify(task)
        if not self.patterns.get(cat):
            return self._default(cat)
        return max(self.patterns[cat], key=lambda p: p.success_rate)

    def apply_to_harness(self, pattern):
        return HarnessConfig(
            prompt_additions=pattern.to_prompt_additions(),
            cot_structure=pattern.to_cot_structure(),
            checkpoints=pattern.to_verification_checkpoints(),
        )

### MetaReasoner (L22)
class MetaReasoner:
    async def analyze(self, task):
        prompt = f"""Analyze this task:
1. PROBLEM TYPE: coding/bug/arch/refactor/debug/docs
2. COMPLEXITY: simple/medium/hard/massive
3. EXPERTS NEEDED: [list]
4. STRATEGY: direct/exploratory/incremental
5. RISKS: [what could go wrong]
6. MISSING: [context needed]"""
        resp = await self.model.generate(prompt)
        return Analysis.parse(resp)

### ConfidenceCalibrator (L31)
class ConfidenceCalibrator:
    async def score(self, solution):
        prompt = f"""Rate each claim in this solution:
Claim | Confidence(0-1) | Evidence | Verification"""
        resp = await self.model.generate(prompt)
        return self._parse_table(resp)

### SelfCorrection (L32)
class SelfCorrection:
    async def check(self, partial):
        prompt = f"""Check if this partial output is correct:
Look for contradictions, hallucinated APIs, factual errors.
If WRONG: ERROR + explanation + correction"""
        resp = await self.model.generate(prompt)
        if resp.startswith("ERROR"):
            return Correction.parse(resp)
        return None

### SelfTrainingLoop (L26)
class SelfTrainingLoop:
    def __init__(self):
        self.failures = []

    def process(self, task, attempts, grade, config):
        self.failures.append({
            "task": task,
            "attempts": attempts,
            "grade": grade,
            "success": grade > 0.7,
            "config": config,
        })
        if not self.failures[-1]["success"]:
            self._analyze_failure()
        if len(self.failures) % 100 == 0:
            self._optimize()

    def _optimize(self):
        # Find common failure modes
        # Adjust config, prompts, and chains
        pass
