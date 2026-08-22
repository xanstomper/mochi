"""MoELoopPipeline — Pipeline loop technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import time
import logging

class MoELoopPipeline:
    """Complete looped pipeline for MoE self-improvement.
    
    Combines:
    - LoopUS for recursive depth scaling
    - Universal YOCO for efficient recursive computation
    - PipelineOrchestrator for multi-stage loops
    - Feedback loops for iterative refinement
    
    The pipeline runs in cycles:
    Research → Brew → Distill → Generate Params → Verify → Refine → Repeat
    Each cycle improves based on feedback from the previous.
    """
    def __init__(self):
        self.loopus = LoopUS(num_loops=4)
        self.yoco = UniversalYOCO(num_recursions=3)
        self.orchestrator = PipelineOrchestrator(max_macro_loops=3)
        self._cycle = 0
        self._init_stages()

    def _init_stages(self):
        self.orchestrator.register_stage("research", self._stage_research, micro_loops=1)
        self.orchestrator.register_stage("brew", self._stage_brew, micro_loops=2)
        self.orchestrator.register_stage("distill", self._stage_distill, micro_loops=2)
        self.orchestrator.register_stage("generate", self._stage_generate, micro_loops=1)
        self.orchestrator.register_stage("verify", self._stage_verify, micro_loops=1)

    def _stage_research(self, input_data: Any) -> Any:
        self._cycle += 1
        try:
            from lazy_chameleon.moe_controller.moe_research import MoEResearch
            r = MoEResearch()
            topic = f"improvement_cycle_{self._cycle}"
            result = r.research(topic, "general", sources=["kb://code", "kb://science"])
            return result
        except Exception as e:
            return {"findings": [f"Research cycle {self._cycle}"], "error": str(e)}

    def _stage_brew(self, research: Dict) -> Any:
        try:
            from lazy_chameleon.moe_controller.moe_distill_pot import MoEDistillPot, MoEPotConfig
            pot = MoEDistillPot(MoEPotConfig(recipe="rich", domain="general"))
            findings = research.get("key_responses", [])[:10]
            raw = [{"instruction": f"Learn topic", "response": str(f), "domain": "general"} for f in findings if f]
            if raw:
                pot.add_raw(raw)
                return pot.brew()
            return []
        except Exception as e:
            return [{"error": str(e)}]

    def _stage_distill(self, brewed: List) -> Any:
        try:
            from lazy_chameleon.moe_controller.moe_distill_pot import MoEDistillPot, MoEPotConfig
            pot = MoEDistillPot(MoEPotConfig(recipe="special_reserve", domain="general"))
            for item in brewed:
                if hasattr(item, "content"):
                    pot.add_raw([{"instruction": item.topic, "response": item.content, "domain": item.domain}])
            return pot.brew()
        except:
            return []

    def _stage_generate(self, distilled: Any) -> Any:
        try:
            from lazy_chameleon.brewing.massive_param_generator import MassiveParameterGenerator
            mpg = MassiveParameterGenerator(num_experts=16)
            result = mpg.generate_massive(target_b=1000.0)
            return result
        except Exception as e:
            return {"error": str(e)}

    def _stage_verify(self, generated: Any) -> Any:
        generated_count = 0
        if isinstance(generated, dict):
            generated_count = generated.get("scale_plan", {}).get("values_generated", 0)
        return {"verified": generated_count > 0, "count": generated_count, "cycle": self._cycle}

    def run_cycle(self) -> Dict[str, Any]:
        """Run one complete pipeline cycle with feedback."""
        t0 = time.time()
        result = self.orchestrator.run(
            initial_input={"cycle": self._cycle},
            feedback_fn=lambda out, macro: {
                "feedback": f"Cycle {self._cycle}, macro {macro} complete",
                "previous_output": out,
            }
        )
        elapsed = time.time() - t0
        return {
            "cycle": self._cycle,
            "pipeline_output": result.get("output", {}),
            "total_time_s": round(elapsed, 2),
            "num_loops": self.loopus.num_loops,
            "num_recursions": self.yoco.num_recursions,
        }

    def run_loopus_refinement(self, hidden_state: np.ndarray, loop_fn: Callable) -> Dict:
        h, loops, history = self.loopus.loop(hidden_state, loop_fn)
        return {"output": h, "loops_used": loops, "history": history}

    def run_yoco_recursion(self, input_ids: np.ndarray) -> Dict:
        latent, history = self.yoco.recursive_refine(input_ids)
        return {"latent": latent, "recursions": len(history), "cache": self.yoco.get_cache_stats()}

    def get_stats(self) -> Dict[str, Any]:
        return {
            "cycle": self._cycle,
            "loopus": self.loopus.get_stats(),
            "yoco_cache": self.yoco.get_cache_stats(),
            "pipeline_loops": len(self.orchestrator.get_log()),
        }
