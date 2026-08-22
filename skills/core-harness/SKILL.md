---
name: core-harness
description: Design document for core harness architecture
---

# LAZY CHAMELEON - Core Harness Architecture

## Forge-Architect Design Document

### Overview
The core harness is a multi-pass reasoning loop wrapping any LLM API.
Instead of a single call, it cycles the model through planning, debate,
critique, verification, and refinement stages.

### Main Orchestrator

class LazyChameleonOrchestrator:
    def __init__(self, model_api, config):
        self.model = model_api
        self.config = config
        self.memory = MemorySystem()
        self.tools = ToolSystem()
        self.planner = Planner(model_api)
        self.search = TreeSearch(model_api)
        self.critic = AdversarialCritic(model_api)
        self.verifier = Verifier(model_api, self.tools)
        self.refiner = Refiner(model_api)
        self.gate = ConfidenceGate(config)
        self.synthesizer = AnswerSynthesizer(model_api)
        self.budget = ThinkingBudget()

    async def solve(self, task, context=None):
        self.memory.store_task(task)
        budget = self.budget.compute(task)
        plan = await self.planner.plan(task)
        self.memory.store_plan(plan)
        candidates = await self.search.search(plan, width=3, depth=budget)
        for candidate in candidates:
            for i in range(budget):
                critique = await self.critic.critique(candidate, task)
                ver = await self.verifier.verify(candidate, plan)
                if critique.ok and ver.passed:
                    break
                candidate = await self.refiner.refine(candidate, critique, ver)
                if self.gate.should_stop(candidate, plan, i, budget):
                    break
        final = await self.synthesizer.synthesize(candidates, plan)
        confidence = self.gate.score(final)
        if confidence < self.config.min_confidence:
            final = await self._deep_reason(final, plan, budget*2)
        self.memory.store_result(task, final)
        return Result(answer=final, confidence=confidence, passes=budget)

### Components
- Planner (L1): Task -> GOAL, SUBTASKS, CONSTRAINTS, RISKS, UNKNOWNS
- TreeSearch (L14): Multiple paths via conservative/creative/minimal
- AdversarialCritic (L3/L12): Finds bugs, hallucinations, missing reqs
- Verifier (L4/L15): Checks reqs + compile + test + lint
- Refiner (L5): Solution + critique + verification -> improved
- ThinkingBudget (L7/L21): TINY=1, MEDIUM=3, HARD=8, MASSIVE=20+
- ConfidenceGate (L10/L13): Scores outputs, triggers more passes
- Synthesizer (L30): Merges best from multiple candidates

### Flow
User -> Planner -> TreeSearch -> [Critic->Verifier->Refiner]^N -> Gate -> Output
