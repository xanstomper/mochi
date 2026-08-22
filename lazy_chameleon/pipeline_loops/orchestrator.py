"""PipelineOrchestrator — Pipeline loop technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import time
import logging

class PipelineOrchestrator:
    """Multi-stage pipeline with feedback loops and iterative refinement.
    
    Pipeline stages:
    1. Research → 2. Brew → 3. Distill → 4. Generate → 5. Verify → 6. Refine
    
    Each stage can loop internally (micro-loops) and the whole pipeline
    can loop (macro-loops) for iterative improvement.
    """
    def __init__(self, max_macro_loops: int = 3):
        self.max_macro_loops = max_macro_loops
        self._stages: Dict[str, Callable] = {}
        self._loop_log: List[Dict] = []

    def register_stage(self, name: str, fn: Callable, micro_loops: int = 1):
        self._stages[name] = {"fn": fn, "micro_loops": micro_loops}

    def run(self, initial_input: Any, feedback_fn: Optional[Callable] = None) -> Dict[str, Any]:
        """Run the full pipeline with macro and micro loops."""
        current = initial_input
        macro_log = []
        for macro in range(self.max_macro_loops):
            stage_log = []
            for stage_name, stage_info in self._stages.items():
                micro_log = []
                for micro in range(stage_info["micro_loops"]):
                    t0 = time.time()
                    output = stage_info["fn"](current)
                    elapsed = time.time() - t0
                    micro_log.append({"micro_loop": micro, "latency_s": round(elapsed, 4)})
                    if micro < stage_info["micro_loops"] - 1:
                        current = output
                stage_log.append({"stage": stage_name, "micro_loops": micro_log})
                current = output
            if feedback_fn:
                feedback = feedback_fn(current, macro)
                current = feedback
            macro_log.append({"macro_loop": macro, "stages": stage_log})
        self._loop_log = macro_log
        return {"output": current, "loops": macro_log}

    def get_log(self) -> List[Dict]:
        return list(self._loop_log)


# ═════════════════════════════════════════════════════════════════════════════
# MoELoopPipeline — End-to-end looped pipeline for MoE systems
# ═════════════════════════════════════════════════════════════════════════════
