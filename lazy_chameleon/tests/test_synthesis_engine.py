"""Extended tests for synthesis engine — covering all 12 sub-packages."""
from __future__ import annotations
import pytest
import numpy as np


class TestMerging:
    def test_slerp(self):
        from lazy_chameleon.synthesis_engine.merging.model_merger import slerp
        r = slerp({"w": np.random.randn(10,10)}, {"w": np.random.randn(10,10)}, 0.5)
        assert r.weights["w"].shape == (10,10)

    def test_ties(self):
        from lazy_chameleon.synthesis_engine.merging.model_merger import ties_merge
        r = ties_merge([{"w": np.random.randn(10,10)}, {"w": np.random.randn(10,10)}], trim_fraction=0.2)
        assert r.weights["w"].shape == (10,10)

    def test_dare(self):
        from lazy_chameleon.synthesis_engine.merging.model_merger import dare_merge
        r = dare_merge([{"w": np.random.randn(10,10)}, {"w": np.random.randn(10,10)}], drop_rate=0.3)
        assert r.weights["w"].shape == (10,10)


class TestMoE:
    def test_spawner(self):
        from lazy_chameleon.synthesis_engine.moe_evolution.expert_spawner import ExpertSpawner
        es = ExpertSpawner(num_experts=8)
        assert len(es.pool.expert_params) == 8

    def test_spawn(self):
        from lazy_chameleon.synthesis_engine.moe_evolution.expert_spawner import ExpertSpawner
        es = ExpertSpawner(num_experts=4)
        ex = es.spawn_expert(parent_ids=[0,1])
        assert isinstance(ex, int)

    def test_split(self):
        from lazy_chameleon.synthesis_engine.moe_evolution.expert_spawner import ExpertSpawner
        es = ExpertSpawner(num_experts=4)
        children = es.split_expert(expert_id=0, num_splits=2)
        assert len(children) == 2


class TestNAS:
    def test_gen_layer(self):
        from lazy_chameleon.synthesis_engine.nas.neural_arch_search import ArchitectureGenerator
        cfg = ArchitectureGenerator().generate_layer(64, 128)
        assert cfg.input_dim == 64

    def test_gen_attention(self):
        from lazy_chameleon.synthesis_engine.nas.neural_arch_search import ArchitectureGenerator
        cfg = ArchitectureGenerator().generate_attention_block(hidden_size=512, num_heads=8)
        assert hasattr(cfg, "num_heads") and cfg.num_heads == 8


class TestSynthData:
    def test_self_instruct(self):
        from lazy_chameleon.synthesis_engine.synthetic_data.data_generator import SynthDataGenerator
        ds = SynthDataGenerator().self_instruct(num_samples=3)
        assert len(ds) == 3

    def test_evol(self):
        from lazy_chameleon.synthesis_engine.synthetic_data.data_generator import SynthDataGenerator
        ds = SynthDataGenerator().evol_instruct(["solve x+2=5"], num_evolutions=2)
        assert len(ds) >= 1


class TestDistill:
    def test_logit(self):
        from lazy_chameleon.synthesis_engine.distillation.knowledge_distiller import KnowledgeDistiller
        t = {"w": np.random.randn(10,10)}
        s = {"w": np.random.randn(10,10)}
        r = KnowledgeDistiller(t,s).logit_distill(num_steps=5)
        assert len(r.distillation_losses) > 0

    def test_layer_distill(self):
        from lazy_chameleon.synthesis_engine.distillation.knowledge_distiller import KnowledgeDistiller
        t = {"w": np.random.randn(10,10)}
        s = {"w": np.random.randn(10,10)}
        r = KnowledgeDistiller(t,s).layer_distill(num_steps=5)
        assert len(r.distillation_losses) > 0


class TestMemory:
    def test_vector_store(self):
        from lazy_chameleon.synthesis_engine.memory.vector_store import VectorStore
        vs = VectorStore()
        vid = vs.add_text("hello world", metadata={"source": "test"})
        assert isinstance(vid, str)

    def test_search(self):
        from lazy_chameleon.synthesis_engine.memory.vector_store import VectorStore
        vs = VectorStore()
        vs.add_text("test data", metadata={"src": "t"})
        results = vs.search(query="test", collection="default", k=1)
        assert results is not None


class TestHyperNet:
    def test_generate(self):
        from lazy_chameleon.synthesis_engine.hypernetwork.hypernetwork import HyperNetwork
        w = HyperNetwork().generate_weights(8, 16)
        assert w is not None


class TestEvo:
    def test_cma(self):
        from lazy_chameleon.synthesis_engine.evolutionary.evolution_engine import CMAES
        sol = CMAES(genome_size=2, pop_size=5).optimize(lambda x: -sum(v**2 for v in x), num_generations=5)
        assert hasattr(sol, "genome") or isinstance(sol, (list, np.ndarray))

    def test_neat(self):
        from lazy_chameleon.synthesis_engine.evolutionary.evolution_engine import NEATEvolution
        net = NEATEvolution(input_size=2, output_size=1, pop_size=5)
        net.evolve(fitness_func=lambda x: 1.0, num_generations=2)
        assert net.generation >= 1


class TestMetaLearning:
    def test_maml_adapt(self):
        from lazy_chameleon.synthesis_engine.meta_learning.meta_learner import MAML
        maml = MAML(input_dim=8, output_dim=4)
        x = np.random.randn(5, 8)
        y = np.random.randint(0, 4, 5)
        loss = maml.adapt(x, y, num_steps=3)
        assert isinstance(loss, dict) or float(loss) >= 0.0

    def test_reptile(self):
        from lazy_chameleon.synthesis_engine.meta_learning.meta_learner import Reptile
        rep = Reptile(input_dim=8, output_dim=4)
        x = np.random.randn(5, 8)
        y = np.random.randint(0, 4, 5)
        loss = rep.adapt(x, y, num_steps=3)
        assert isinstance(loss, dict) or float(loss) >= 0.0


class TestTimeCompute:
    def test_tot(self):
        from lazy_chameleon.synthesis_engine.test_time_compute.compute_expander import TreeOfThoughts
        tot = TreeOfThoughts(thought_generator=lambda p, n: ["a"]*n, thought_evaluator=lambda t: 1.0, max_depth=2, max_branching=2)
        r = tot.solve("test")
        assert hasattr(r, "final_answer")

    def test_mcts(self):
        from lazy_chameleon.synthesis_engine.test_time_compute.compute_expander import MCTS
        mcts = MCTS(simulator=lambda s: ("result", 1.0), evaluator=lambda s: 1.0, num_simulations=5, max_depth=3)
        r = mcts.solve("test")
        assert hasattr(r, "final_answer")

    def test_reflection(self):
        from lazy_chameleon.synthesis_engine.test_time_compute.compute_expander import Reflection
        ref = Reflection(generator=lambda p: "answer", critic=lambda p, a: "good", max_iterations=2)
        r = ref.solve("test")
        assert hasattr(r, "final_answer")


class TestParamEfficiency:
    def test_lora(self):
        from lazy_chameleon.synthesis_engine.parameter_efficiency.adapter_generator import AdapterGenerator, AdapterConfig
        w = {"layer": np.random.randn(16, 32)}
        ag = AdapterGenerator().lora(w, AdapterConfig(r=4))
        assert len(ag.lora_A) > 0

    def test_qlora(self):
        from lazy_chameleon.synthesis_engine.parameter_efficiency.adapter_generator import AdapterGenerator, AdapterConfig
        w = {"layer": np.random.randn(16, 32)}
        ag = AdapterGenerator().qlora(w, AdapterConfig(r=4))
        assert len(ag.lora_A) > 0

    def test_dora(self):
        from lazy_chameleon.synthesis_engine.parameter_efficiency.adapter_generator import AdapterGenerator, AdapterConfig
        w = {"layer": np.random.randn(16, 32)}
        ag = AdapterGenerator().dora(w, AdapterConfig(r=4))
        assert len(ag.lora_A) > 0


class TestKnowledgeInject:
    def test_rag(self):
        from lazy_chameleon.synthesis_engine.knowledge_injection.knowledge_injector import RAGInjector
        rag = RAGInjector(knowledge_base={"test": "data"})
        assert rag is not None
        assert rag.knowledge_base["test"] == "data"

    def test_graph_memory(self):
        from lazy_chameleon.synthesis_engine.knowledge_injection.knowledge_injector import GraphMemory
        gm = GraphMemory(embedding_dim=8)
        assert gm is not None


class TestPipeline:
    def test_param_scale(self):
        from lazy_chameleon.synthesis_engine import ParamScaleEngine, ParamScaleConfig
        engine = ParamScaleEngine(ParamScaleConfig(base_params_b=480.0, target_params_b=1000.0))
        targets = engine.compute_scale_targets()
        assert targets.num_experts > 64

    def test_brewing_pipeline(self):
        from lazy_chameleon.synthesis_engine import ParameterBrewingPipeline
        pipeline = ParameterBrewingPipeline(target_params_b=500.0)
        pipeline.initialize(base_params_b=480.0)
        result = pipeline.run_full_pipeline(domains=["math"], params_per_domain=5)
        assert result.total_params_generated >= 0
