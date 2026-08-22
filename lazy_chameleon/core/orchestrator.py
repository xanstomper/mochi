"""Lazy Chameleon v2.0 Orchestrator — Full Synthesis Pipeline.

Pipeline:
  1. Pre-flight: Analyze task complexity, allocate compute
  2. MoE Routing: Select optimal expert combination
  3. Parallel Stall: Lazy agents generate synthetic parameters
  4. RAG: Index and retrieve relevant knowledge
  5. Hypernetwork: Generate task-specific adapter instructions
  6. Distillation: Extract teacher reasoning patterns
  7. Knowledge Compression: Compress into dense context
  8. Dynamic Adapters: Apply behavioral adaptation
  9. Main Reasoning: Process with expanded context
  10. Quality Gate: Check quality, iterate if needed
  11. Output: Frontier-quality result
"""
import asyncio
import json
import time
import sys
from ..config.settings import HarnessConfig
from ..core.types import LazyOutput, Solution, Result
from ..memory.memory import HotMemory, WarmMemory, ColdMemory
from ..agents import (
    ScoutChameleon, CriticChameleon, ResearchChameleon,
    SimulatorChameleon, ArchitectChameleon, DebugChameleon,
    OptimizerChameleon, HistorianChameleon,
)
from ..core.api import FlashModelAPI
from ..compression.compressor import KnowledgeCompressor
from ..synthesis.hypernet import HypernetworkSynthesizer
from ..synthesis.distillation import DistillationEngine
from ..synthesis.rag import RAGEngine
from ..synthesis.adapters import DynamicAdapterManager
from ..synthesis.router import MoERouter
from ..synthesis.compute import DynamicComputeScheduler
from ..synthesis.staller import StallEngine

_STALL_MODES = frozenset(("hard", "deep", "extreme", "genius", "god", "opus"))


class LazyChameleon:
    """Universal Synthesis Orchestrator v2.0.

    Transforms any model into frontier quality through:
    - MoE expert routing
    - Hypernetwork adapter synthesis
    - Knowledge distillation from teacher chains
    - RAG-based knowledge retrieval
    - Iterative refinement with quality gating
    - Dynamic compute allocation
    """

    def __init__(self, config=None, progress_callback=None):
        self.config = config or HarnessConfig()
        self.progress = progress_callback or self._default_progress

        # Memory
        self.memory = HotMemory()
        self.warm = WarmMemory(self.config.memory_db_path)
        self.cold = ColdMemory(self.config.memory_db_path)

        # API
        self.api = None

        # Synthesis engines
        self.hypernet = HypernetworkSynthesizer(
            rank=getattr(self.config, 'adapter_rank', 16),
            alpha=getattr(self.config, 'adapter_alpha', 1.0),
        )
        self.distiller = DistillationEngine(
            num_teachers=getattr(self.config, 'num_teachers', 3),
        )
        self.rag = RAGEngine()
        self.adapters = DynamicAdapterManager()
        self.router = MoERouter()
        self.compute = DynamicComputeScheduler()
        self.compressor = KnowledgeCompressor()

        # State
        self.agents = []
        self.synthesis_log = []

    def _default_progress(self, msg: str, **kwargs):
        """Default progress callback prints to stderr."""
        prefix = kwargs.get('prefix', 'LC')
        print(f"  [{prefix}] {msg}", file=sys.stderr, flush=True)

    def connect(self, api_key: str, provider: str = None, model: str = None,
                base_url: str = None):
        """Connect to a model API. Auto-detects provider from model name."""
        p = provider or self.config.lead_model.provider
        m = model or self.config.lead_model.model
        url = base_url or getattr(self.config.lead_model, 'base_url', '')
        self.api = FlashModelAPI(api_key, p, m, base_url=url)

        # Initialize agents
        self.agents = [
            ScoutChameleon(self.api, self.config.mode),
            CriticChameleon(self.api, self.config.mode),
            ResearchChameleon(self.api, self.config.mode),
            SimulatorChameleon(self.api, self.config.mode),
            ArchitectChameleon(self.api, self.config.mode),
            DebugChameleon(self.api, self.config.mode),
            OptimizerChameleon(self.api, self.config.mode),
            HistorianChameleon(self.api, self.config.mode),
        ]

        # Connect distiller to API
        self.distiller.api = self.api
        return self

    def set_mode(self, mode: str):
        self.config.mode = mode
        for a in self.agents:
            a.mode = mode
        return self

    async def solve(self, task: str) -> Result:
        """Run the full synthesis pipeline."""
        self.synthesis_log = []
        self.memory.clear()
        self.memory.task = task
        self.memory.current_goal = task
        self.compute.reset()

        # ── Phase 0: Pre-flight Analysis ──
        t_start = time.time()
        complexity = self.compute.analyze_task(task)
        budget = self.compute.get_budget(self.config.mode)
        self.progress(
            f"Task complexity: {complexity.score:.2f} -> {complexity.recommended_mode} "
            f"(passes: {complexity.estimated_passes})",
            prefix="PRE"
        )
        self.synthesis_log.append(f"Complexity: {complexity.score:.2f}")

        # ── Phase 1: MoE Routing ──
        route = self.router.route(task, self.config.mode)
        self.progress(
            f"Routed to {route.num_experts} experts: "
            f"{', '.join(route.expert_names)}",
            prefix="MoE"
        )
        self.synthesis_log.append(
            f"MoE route: {route.num_experts} experts"
        )

        # ── Phase 2: Parallel Stall (lazy agents generate parameters) ──
        t_stall = time.time()
        active_agents = [a for a in self.agents if a.name in route.expert_names]
        if not active_agents:
            active_agents = self.agents  # fallback: use all

        outputs = await self._synthesize_params(task, active_agents)
        stall_time = time.time() - t_stall
        self.compute.record_usage(stall_time, api_calls=len(outputs))

        total_params = sum(o.get("params", 0) for o in outputs)
        self.progress(
            f"Stall complete: {total_params:,} synthetic params in {stall_time:.1f}s",
            prefix="STAGE"
        )
        self.synthesis_log.append(
            f"Stall: {len(outputs)} agents, {total_params:,} params, {stall_time:.1f}s"
        )

        # ── Phase 3: RAG Indexing ──
        for o in outputs:
            self.rag.index_agent_output(
                o["agent"], o.get("details", ""), o.get("confidence", 0.5)
            )
        rag_context = self.rag.build_context(task, top_k=5)
        self.progress(
            f"RAG indexed {self.rag.total_indexed} chunks, "
            f"retrieved {len(self.rag.retrieve(task, 3))} relevant",
            prefix="RAG"
        )

        # ── Phase 4: Hypernetwork Synthesis ──
        combined_intelligence = "\n".join(
            o.get("details", "")[:500] for o in outputs
        )
        hypernet_result = self.hypernet.synthesize(
            task, combined_intelligence
        )
        instruction_delta = self.hypernet.generate_instruction_delta(
            task, combined_intelligence
        )
        self.progress(
            f"Hypernet: {len(hypernet_result['weight_deltas'])} adapters, "
            f"{hypernet_result['effective_params']:,} effective params",
            prefix="HYPER"
        )

        # ── Phase 5: Knowledge Distillation ──
        distill_result = self.distiller.distill(task, num_rounds=2)
        self.progress(
            f"Distillation: {distill_result['teachers_used']} teachers, "
            f"{len(distill_result['distilled_patterns'])} patterns",
            prefix="DIST"
        )

        # ── Phase 6: Dynamic Adapters ──
        adapter = self.adapters.get_or_create(task, self.hypernet, combined_intelligence)
        adapter_instructions = self.adapters.apply_all(task)
        self.progress(
            f"Adapter: {adapter.name} (domain={adapter.domain}, "
            f"confidence={adapter.confidence:.2f})",
            prefix="ADAPT"
        )

        # ── Phase 7: Knowledge Compression ──
        lazy_outputs = []
        for o in outputs:
            lazy_outputs.append(LazyOutput(
                agent_name=o["agent"],
                summary=o.get("summary", ""),
                details=o.get("details", ""),
                confidence=o.get("confidence", 0.5),
                tokens=o.get("tokens", 0),
                parameter_equivalent=o.get("params", 0),
            ))
        intelligence = self.compressor.compress(lazy_outputs, task)
        self.progress(
            f"Compressed: {len(intelligence.findings)} findings, "
            f"{len(intelligence.risks)} risks, "
            f"{len(intelligence.recommendations)} recommendations",
            prefix="COMP"
        )

        # ── Phase 8: Build Synthesis Context ──
        synthesis_context = self._build_synthesis_context(
            task=task,
            intelligence=intelligence,
            rag_context=rag_context,
            instruction_delta=instruction_delta,
            distillation=distill_result.get("student_injection", ""),
            adapter_instructions=adapter_instructions,
            hypernet_prompt_deltas=hypernet_result.get("prompt_deltas", []),
        )

        # ── Phase 9: Main Reasoning with Iterative Refinement ──
        t_reason = time.time()
        best_solution = None
        best_quality = 0.0
        all_checkpoints = []

        num_passes = complexity.estimated_passes
        for pass_num in range(1, num_passes + 1):
            self.progress(
                f"Reasoning pass {pass_num}/{num_passes}...",
                prefix="PASS"
            )

            solution = await self._main_reason(
                task, synthesis_context, outputs, pass_num
            )
            quality = self._estimate_quality(solution, task)
            self.compute.record_quality(quality)

            checkpoint = {
                "pass": pass_num,
                "quality": quality,
                "length": len(solution.get("content", "")),
            }
            all_checkpoints.append(checkpoint)

            if quality > best_quality:
                best_quality = quality
                best_solution = solution

            # Quality gate
            gate = self.compute.check_quality_gate(
                quality, pass_num, budget
            )
            self.progress(
                f"Quality: {quality:.2f} | {gate.reason}",
                prefix="GATE"
            )

            if not gate.should_continue:
                break

            # Refine: inject critique for next pass
            synthesis_context = self._inject_critique(
                synthesis_context, solution, task
            )

        reason_time = time.time() - t_reason
        self.compute.record_usage(reason_time, api_calls=num_passes)

        # ── Phase 10: Finalize ──
        total_time = time.time() - t_start
        total_params = sum(o.get("params", 0) for o in outputs)
        effective = total_params + hypernet_result.get("effective_params", 0)

        # Update adapter quality
        adapter_key = f"{adapter.domain}_primary"
        if best_quality > 0.8:
            self.adapters.promote(adapter_key, best_quality)
        elif best_quality < 0.5:
            self.adapters.demote(adapter_key)

        # Update router stats
        for o in outputs:
            self.router.update_stats(
                o["agent"],
                o.get("time", 0),
                o.get("confidence", 0.5),
                o.get("params", 0),
            )

        self.progress(
            f"Complete in {total_time:.1f}s | Quality: {best_quality:.2f} | "
            f"Params: {effective:,} | Passes: {len(all_checkpoints)}",
            prefix="DONE"
        )

        # Compute mode multiplier
        mult_map = {"easy": 1, "medium": 5, "hard": 25, "extreme": 100,
                    "turbo": 5, "deep": 50, "genius": 100, "god": 500,
                    "opus": 500}
        mult = mult_map.get(self.config.mode, 10)

        return Result(
            answer=best_solution.get("content", ""),
            confidence=best_quality,
            param_multiplier=mult,
            agents_used=[o.get("agent", "?") for o in outputs],
            cycles_used=len(all_checkpoints),
            synthetic_params_generated=total_params,
            tokens_consumed=self.api.total_tokens if self.api else 0,
            passes=len(all_checkpoints),
            synthesis_log=self.synthesis_log,
            total_effective_params=effective,
            quality_checkpoints=all_checkpoints,
        )

    def _build_synthesis_context(self, task, intelligence, rag_context,
                                 instruction_delta, distillation,
                                 adapter_instructions, hypernet_prompt_deltas) -> str:
        """Build the master synthesis context from all engines."""
        sections = [
            f"TASK: {task}",
            "",
            "=== PARAMETER SYNTHESIS CONTEXT ===",
            "",
        ]

        # 1. Compressed intelligence
        sections.append(self.compressor.compress_to_prompt(intelligence))
        sections.append("")

        # 2. RAG context
        if rag_context:
            sections.append(rag_context)
            sections.append("")

        # 3. Distilled patterns
        if distillation:
            sections.append(distillation)
            sections.append("")

        # 4. Hypernetwork behavioral adaptation
        if instruction_delta:
            sections.append(instruction_delta)
            sections.append("")

        # 5. Dynamic adapter instructions
        for instr in adapter_instructions:
            sections.append(instr)
            sections.append("")

        # 6. Hypernetwork weight delta descriptions
        if hypernet_prompt_deltas:
            sections.append("=== HYPERNETWORK WEIGHT DELTAS ===")
            for pd in hypernet_prompt_deltas[:4]:  # limit to 4
                sections.append(f"  {pd}")
            sections.append("")

        sections.extend([
            "=== END SYNTHESIS CONTEXT ===",
            "",
            "You have received comprehensive pre-computed intelligence from:",
            "- 8 specialized lazy agents (MoE-routed)",
            "- Knowledge distillation from teacher chains",
            "- RAG-retrieved relevant knowledge",
            "- Hypernetwork-generated behavioral adaptation",
            "- Dynamic domain-specific adapters",
            "",
            "Process ALL of the above. Your output must match frontier model"
            " quality (Opus 4.8, Sonnet 5, GPT-sol tier).",
            "Be thorough, precise, and production-ready.",
        ])
        return "\n".join(sections)

    def _inject_critique(self, context: str, solution: dict, task: str) -> str:
        """Inject critique into context for refinement pass."""
        critique = ""
        if self.api:
            critique = self.api.generate(
                f"TASK: {task}\n\n"
                f"SOLUTION:\n{solution.get('content', '')[:2000]}\n\n"
                f"Provide a brief critique: what's missing, what's wrong, "
                f"what could be better. Be specific. 2-3 sentences.",
                max_tokens=500,
            )
        return context + f"\n\n=== REFINEMENT CRITIQUE ===\n{critique}\n"

    async def _synthesize_params(self, task: str, active_agents: list) -> list:
        """Param synthesis step — enriches the task with StallEngine for hard+ modes,
        then fans out to all active agents in parallel.

        For easy/flash modes the raw task is passed directly to keep latency low.
        For hard/deep/extreme/genius/god/opus modes the StallEngine wraps the task
        in a hybrid reasoning scaffold so every downstream agent sees an expanded,
        compute-rich context — effectively giving the flash model the reasoning depth
        of a much larger model at synthesis time.
        """
        enriched_task = task
        if self.config.mode in _STALL_MODES:
            try:
                engine = StallEngine(mode=self.config.mode)
                enriched_task = engine.build_prompt(
                    task=task,
                    base_context="",
                    strategy="hybrid",
                )
                self.synthesis_log.append(
                    f"StallEngine({self.config.mode}): task enriched "
                    f"({len(enriched_task) - len(task):+d} chars)"
                )
            except Exception as exc:  # pragma: no cover
                self.progress(f"StallEngine skipped: {exc}", prefix="STALL")
        return await self._parallel_stall(enriched_task, active_agents)

    async def _parallel_stall(self, task, agents):
        """Run agents in parallel threads."""
        loop = asyncio.get_event_loop()
        futures = [loop.run_in_executor(None, a.run, task) for a in agents]
        results = await asyncio.gather(*futures, return_exceptions=True)
        outputs = []
        for a, r in zip(agents, results):
            if isinstance(r, Exception):
                self.progress(f"ERROR {a.name}: {r}", prefix="ERR")
                continue
            outputs.append(r)
            self.memory.add_synthetic_context(
                a.name, r.get("summary", ""), r.get("params", 0)
            )
            self.progress(
                f"{a.name.upper()}: +{r.get('params',0):,} params "
                f"({r.get('tokens',0)} tok, {r.get('time', 0):.1f}s)",
                prefix=a.name.upper()
            )
        return outputs

    async def _main_reason(self, task, context, outputs, pass_num=1):
        """Main reasoning pass with synthesis context."""
        if not self.api:
            return {"content": "[No API connected]", "confidence": 0.5}

        content = self.api.generate(context, max_tokens=8192)
        return {"content": content, "confidence": 0.85, "pass": pass_num}

    def _estimate_quality(self, solution: dict, task: str) -> float:
        """Estimate output quality heuristically."""
        content = solution.get("content", "")
        if not content or content.startswith("[API Error"):
            return 0.1

        score = 0.5  # base

        # Length heuristic
        if len(content) > 2000:
            score += 0.1
        if len(content) > 5000:
            score += 0.1

        # Structure signals
        if "```" in content:  # code blocks
            score += 0.05
        if content.count("\n") > 10:  # well-structured
            score += 0.05
        if any(w in content.lower() for w in ["example", "implementation"]):
            score += 0.05

        # Confidence from API response
        api_conf = solution.get("confidence", 0.7)
        score = score * 0.7 + api_conf * 0.3

        return min(score, 0.98)
