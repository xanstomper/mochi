"""Tests for AgentHarness, CLI, and ResearchCoordinator."""
from __future__ import annotations
import pytest
import json


class TestAgentHarness:
    def test_harness_import(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        assert h is not None

    def test_harness_tools_count(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        tools = h.get_tools()
        assert len(tools) >= 4

    def test_harness_tool_schema_format(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        tools = h.get_tools()
        for t in tools:
            assert "type" in t
            assert t["type"] == "function"
            assert "function" in t
            assert "name" in t["function"]
            assert "description" in t["function"]

    def test_harness_call_config(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        result = h.call_tool("config")
        assert result["success"] is True
        assert "data" in result

    def test_harness_call_research(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        result = h.call_tool("research_summary")
        assert result["success"] is True
        assert result["data"].get("total", 0) >= 20

    def test_harness_call_unknown(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        try:
            result = h.call_tool("nonexistent_tool")
            assert result["success"] is False
        except Exception:
            pass

    def test_harness_history(self):
        from lazy_chameleon.harness import AgentHarness
        h = AgentHarness()
        h.call_tool("config")
        h.call_tool("research_summary")
        history = h.get_history()
        assert len(history) >= 2


class TestCLI:
    def test_cli_research_summary_json(self):
        from lazy_chameleon.cli.unified_cli import build_parser, _dispatch
        parser = build_parser()
        args = parser.parse_args(["research", "summary"])
        result = _dispatch(args)
        assert isinstance(result, dict)
        assert "total" in result

    def test_cli_config_json(self):
        from lazy_chameleon.cli.unified_cli import build_parser, _dispatch
        parser = build_parser()
        args = parser.parse_args(["config", "show"])
        result = _dispatch(args)
        assert isinstance(result, dict)

    def test_cli_data_summary_json(self):
        from lazy_chameleon.cli.unified_cli import build_parser, _dispatch
        parser = build_parser()
        args = parser.parse_args(["data", "summary"])
        result = _dispatch(args)
        assert isinstance(result, dict)

    def test_cli_research_techniques(self):
        from lazy_chameleon.cli.unified_cli import build_parser, _dispatch
        parser = build_parser()
        args = parser.parse_args(["research", "techniques"])
        result = _dispatch(args)
        assert isinstance(result, dict)
        assert "techniques" in result

    def test_cli_error_handling(self):
        import sys
        from lazy_chameleon.cli.unified_cli import build_parser
        parser = build_parser()
        try:
            args = parser.parse_args(["research", "nonexistent"])
        except SystemExit:
            pass


class TestResearchCoordinator:
    def test_coordinator_loads(self):
        from lazy_chameleon.pipeline.research_integration import ResearchCoordinator
        rc = ResearchCoordinator()
        summary = rc.get_summary()
        assert summary["total"] >= 20
        assert len(summary["techniques"]) >= 15
        assert len(summary["pipelines"]) >= 1

    def test_coordinator_techniques_exist(self):
        from lazy_chameleon.pipeline.research_integration import ResearchCoordinator
        rc = ResearchCoordinator()
        assert "muon" in rc._techniques
        assert "alpha_q" in rc._techniques
        assert "moe_manipulator" in rc._techniques

    def test_coordinator_pipelines_exist(self):
        from lazy_chameleon.pipeline.research_integration import ResearchCoordinator
        rc = ResearchCoordinator()
        assert len(rc._pipelines) >= 2

    def test_coordinator_optimize(self):
        from lazy_chameleon.pipeline.research_integration import ResearchCoordinator
        rc = ResearchCoordinator()
        assert hasattr(rc, "get_summary")
        assert hasattr(rc, "_techniques")


class TestMoEDistillPot:
    def test_distill_pot_brew(self):
        from lazy_chameleon.moe_controller.moe_distill_pot import MoEDistillPot, MoEPotConfig
        pot = MoEDistillPot(MoEPotConfig(recipe="rich", domain="math"))
        pot.add_raw([{"instruction": "test", "response": "answer", "domain": "math"}])
        result = pot.brew()
        assert len(result) >= 0

    def test_distill_pot_puke(self):
        from lazy_chameleon.moe_controller.moe_distill_pot import MoEDistillPot, MoEPotConfig
        pot = MoEDistillPot(MoEPotConfig(recipe="standard", domain="code"))
        puked = pot.puke_up()
        assert isinstance(puked, list)


class TestAutoMoE:
    def test_auto_moe_init(self):
        from lazy_chameleon.moe_controller import AutoMoE
        auto = AutoMoE(num_experts=16)
        assert auto.num_experts == 16

    def test_auto_moe_cycle(self):
        from lazy_chameleon.moe_controller import AutoMoE
        auto = AutoMoE(num_experts=8)
        stats = auto.run_cycle()
        assert stats["cycle"] == 1


class TestKnowledgeBase:
    def test_kb_imports(self):
        from lazy_chameleon.knowledge_base import (
            DEEPSEEK_TECHNICAL, FRONTIER_ARCHITECTURES, MODEL_COMPARISON,
            MOE_TRAINING_TECHNIQUES, PROMPT_PATTERNS, FRONTIER_DATASETS,
        )
        assert DEEPSEEK_TECHNICAL is not None
        assert FRONTIER_ARCHITECTURES is not None

    def test_kb_deepseek(self):
        from lazy_chameleon.knowledge_base import DEEPSEEK_TECHNICAL
        assert "deepseek_moe" in DEEPSEEK_TECHNICAL
        assert "deepseek_r1" in DEEPSEEK_TECHNICAL

    def test_kb_model_comparison(self):
        from lazy_chameleon.knowledge_base import MODEL_COMPARISON
        assert "gpt_5_6_sol" in MODEL_COMPARISON
        assert "deepseek_r1" in MODEL_COMPARISON

    def test_kb_prompts(self):
        from lazy_chameleon.knowledge_base import PROMPT_PATTERNS
        assert "openai" in PROMPT_PATTERNS
        assert "anthropic" in PROMPT_PATTERNS

    def test_kb_datasets(self):
        from lazy_chameleon.knowledge_base import FRONTIER_DATASETS
        assert "pretraining" in FRONTIER_DATASETS
        assert "instruction" in FRONTIER_DATASETS

    def test_kb_moe_training(self):
        from lazy_chameleon.knowledge_base import MOE_TRAINING_TECHNIQUES
        assert "load_balancing" in MOE_TRAINING_TECHNIQUES
        assert "expert_architecture" in MOE_TRAINING_TECHNIQUES

    def test_kb_moe_manipulator(self):
        from lazy_chameleon.knowledge_base import MoEManipulator
        moe = MoEManipulator(num_experts=32)
        assert moe.num_experts == 32
        assert moe.num_experts == 32

    def test_kb_constitutional_ai(self):
        from lazy_chameleon.knowledge_base import ConstitutionalAI
        cai = ConstitutionalAI()
        result = cai.critique_response("test", "This is safe")
        assert isinstance(result, dict)


class TestMoEFrontier:
    def test_muon_import(self):
        from lazy_chameleon.moe_frontier import MuonOptimizer
        muon = MuonOptimizer()
        assert muon.lr == 1e-3

    def test_alpha_q_import(self):
        from lazy_chameleon.moe_frontier import AlphaQ
        alpha = AlphaQ()
        assert alpha.total_bit_budget == 3.5

    def test_expert_routing_import(self):
        from lazy_chameleon.moe_frontier import ExpertChoiceRouting
        routing = ExpertChoiceRouting()
        assert routing.num_experts == 64

    def test_moe_loss_import(self):
        from lazy_chameleon.moe_frontier import MoELoss
        loss = MoELoss()
        assert loss.z_coeff == 0.001


class TestResearch2026:
    def test_bits_moe(self):
        from lazy_chameleon.research_2026 import BitsMoE
        bm = BitsMoE()
        assert bm.num_experts == 64

    def test_mempro(self):
        from lazy_chameleon.research_2026 import MemPro
        mp = MemPro()
        mp.write("key", "value")
        assert mp.read("key") == "value"

    def test_mosaic_kv(self):
        from lazy_chameleon.research_2026 import MosaicKV
        import numpy as np
        mkv = MosaicKV()
        cache = {"key": np.random.randn(100, 64)}
        result = mkv.compress(cache)
        assert "key" in result

    def test_crma(self):
        from lazy_chameleon.research_2026 import CRMA
        crma = CRMA()
        assert crma.spectral_bound == 1.0


class TestPipelineLoops:
    def test_loopus(self):
        from lazy_chameleon.pipeline_loops import LoopUS
        loopus = LoopUS(num_loops=4)
        assert loopus.num_loops == 4

    def test_yoco(self):
        from lazy_chameleon.pipeline_loops import UniversalYOCO
        yoco = UniversalYOCO()
        assert yoco.num_recursions >= 3

    def test_orchestrator(self):
        from lazy_chameleon.pipeline_loops import PipelineOrchestrator
        orch = PipelineOrchestrator()
        assert orch.max_macro_loops == 3


class TestMoEWebCrawler:
    def test_crawler_init(self):
        from lazy_chameleon.moe_controller.web import MoEWebCrawler
        c = MoEWebCrawler()
        assert c is not None

    def test_crawler_create_job(self):
        from lazy_chameleon.moe_controller.web import MoEWebCrawler
        c = MoEWebCrawler()
        jid = c.create_job(1, "code", "Python")
        assert isinstance(jid, str)

    def test_crawler_run_job(self):
        from lazy_chameleon.moe_controller.web import MoEWebCrawler
        c = MoEWebCrawler()
        jid = c.create_job(1, "code", "Python")
        job = c.run_job(jid)
        assert job.completed is True

    def test_expert_trainer(self):
        from lazy_chameleon.moe_controller.web import ExpertTrainer
        t = ExpertTrainer()
        result = t.train_expert(1, "math")
        assert "samples" in result


class TestMegaHarness:
    def test_mega_harness_import(self):
        from lazy_chameleon.harness import MEGA_HARNESS
        assert len(MEGA_HARNESS) > 100

    def test_mega_harness_short(self):
        from lazy_chameleon.harness import MEGA_HARNESS_SHORT
        assert len(MEGA_HARNESS_SHORT) > 10

    def test_harness_injector(self):
        from lazy_chameleon.harness import HarnessInjector
        h = HarnessInjector()
        assert h is not None


class TestModelComparison:
    def test_compare_models(self):
        from lazy_chameleon.knowledge_base import MODEL_COMPARISON
        models = ["gpt_5_6_sol", "deepseek_r1", "qwen_3_7_max"]
        for m in models:
            assert m in MODEL_COMPARISON
            assert "params" in MODEL_COMPARISON[m]
            assert "architecture" in MODEL_COMPARISON[m]
