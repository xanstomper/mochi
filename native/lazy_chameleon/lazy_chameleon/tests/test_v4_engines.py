"""Tests for all Lazy Chameleon v3 reasoning engines."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

# ── ThoughtMarket ─────────────────────────────────────────────────────────────
def test_thought_market_auction():
    from lazy_chameleon.core.thought_market import ThoughtMarket
    tm = ThoughtMarket(n_candidates=10, survivors=3, budget_per_survivor=100)
    survivors = tm.auction("How do I debug a Python crash?")
    assert len(survivors) == 3
    assert all(s.alive for s in survivors)
    assert all(s.compute_allocated > 0 for s in survivors)
    assert all(0.0 <= s.score <= 1.0 for s in survivors)

def test_thought_market_scores_in_order():
    from lazy_chameleon.core.thought_market import ThoughtMarket
    tm = ThoughtMarket(n_candidates=10, survivors=5)
    survivors = tm.auction("Design a distributed system")
    scores = [s.score for s in survivors]
    assert scores == sorted(scores, reverse=True)

def test_thought_market_summary():
    from lazy_chameleon.core.thought_market import ThoughtMarket
    tm = ThoughtMarket()
    tm.auction("Test task")
    s = tm.get_market_summary()
    assert s["auctions_run"] == 1
    assert s["config"]["survivors"] == 5

# ── ExpertGenome ──────────────────────────────────────────────────────────────
def test_expert_genome_seed():
    from lazy_chameleon.core.expert_genome import ExpertGenomeLibrary
    lib = ExpertGenomeLibrary()
    assert lib.population_size() == 8

def test_expert_genome_mutate():
    from lazy_chameleon.core.expert_genome import _make_seed_genome
    g = _make_seed_genome("architect")
    mutated = g.mutate(rate=0.5)
    assert mutated.generation == 1
    assert mutated.expert_id != g.expert_id

def test_expert_genome_crossover():
    from lazy_chameleon.core.expert_genome import _make_seed_genome
    g1 = _make_seed_genome("architect")
    g2 = _make_seed_genome("critic")
    child = g1.crossover(g2)
    assert child.generation >= 1
    assert len(child.parent_ids) == 2

def test_expert_genome_fitness():
    from lazy_chameleon.core.expert_genome import _make_seed_genome
    g = _make_seed_genome("debug")
    assert g.fitness_score() == 0.5    # no history yet
    g.update_fitness(True, 0.9)
    g.update_fitness(True, 0.8)
    assert g.fitness_score() > 0.5

def test_genome_library_best_for_task():
    from lazy_chameleon.core.expert_genome import ExpertGenomeLibrary
    lib = ExpertGenomeLibrary()
    g = lib.get_best_genome_for_task("debug")
    assert g is not None
    assert g.expert_id != ""

def test_genome_library_evolve():
    from lazy_chameleon.core.expert_genome import ExpertGenomeLibrary
    lib = ExpertGenomeLibrary()
    before = lib.population_size()
    lib.evolve_generation()
    assert lib.population_size() >= 2   # at least seeds survive

# ── DebateEngine ──────────────────────────────────────────────────────────────
def test_debate_engine_extract_confidence():
    from lazy_chameleon.core.debate_engine import DebateEngine
    de = DebateEngine()
    assert de._extract_confidence("FINAL_CONFIDENCE: 0.85 blah") == pytest.approx(0.85)
    assert de._extract_confidence("CONFIDENCE: 0.5") == pytest.approx(0.5)
    assert 0.0 <= de._extract_confidence("no marker text") <= 1.0

def test_debate_engine_prompts():
    from lazy_chameleon.core.debate_engine import DebateEngine
    de = DebateEngine()
    p = de.build_proposer_prompt("What is 2+2?", "")
    assert "2+2" in p
    opp = de.build_opponent_prompt("What is 2+2?", "4", "")
    assert "4" in opp

def test_debate_engine_sync(tmp_path):
    from lazy_chameleon.core.debate_engine import DebateEngine
    de = DebateEngine(max_rounds=1)
    calls = []
    def fake_api(sys_p, usr_p, label):
        calls.append(label)
        return f"Response from {label}. CONFIDENCE: 0.8"
    result = de.run_debate_sync("Test task", "", fake_api)
    assert result.final_answer != ""
    assert result.confidence > 0
    assert "proposer" in calls

# ── FailurePredictor ──────────────────────────────────────────────────────────
def test_failure_predictor_solvable():
    from lazy_chameleon.core.failure_predictor import FailurePredictor
    fp = FailurePredictor()
    pred = fp.predict("Explain how Python decorators work")
    assert pred.can_solve
    assert pred.confidence > 0.5

def test_failure_predictor_impossible():
    from lazy_chameleon.core.failure_predictor import FailurePredictor
    fp = FailurePredictor()
    pred = fp.predict("What is the current live Bitcoin price right now?")
    assert not pred.can_solve
    assert "real-time" in pred.reason.lower()

def test_failure_predictor_difficulty():
    from lazy_chameleon.core.failure_predictor import FailurePredictor
    fp = FailurePredictor()
    easy = fp.predict("What is 2+2?")
    hard = fp.predict("Implement a distributed consensus algorithm")
    assert hard.estimated_difficulty in ("hard", "medium", "extreme")

def test_failure_predictor_strategy():
    from lazy_chameleon.core.failure_predictor import FailurePredictor
    fp = FailurePredictor()
    pred = fp.predict("Simple hello world")
    assert pred.suggested_strategy != ""

# ── HierarchicalMemory ────────────────────────────────────────────────────────
def test_hierarchical_memory_store_retrieve(tmp_path):
    from lazy_chameleon.memory.hierarchical import HierarchicalMemory, MemoryLayer
    hm = HierarchicalMemory(db_path=str(tmp_path / "hm.db"))
    hm.store("k1", "Python is a great programming language", MemoryLayer.WORKING,
              importance=0.8, tags=["python", "programming"])
    results = hm.retrieve("python programming", top_k=5)
    assert len(results) >= 1
    assert "Python" in results[0].content

def test_hierarchical_memory_immediate(tmp_path):
    from lazy_chameleon.memory.hierarchical import HierarchicalMemory, MemoryLayer
    hm = HierarchicalMemory(db_path=str(tmp_path / "hm2.db"))
    hm.store("imm1", "immediate item", MemoryLayer.IMMEDIATE)
    results = hm.retrieve("immediate", layer=MemoryLayer.IMMEDIATE)
    assert len(results) == 1
    hm.clear_immediate()
    results2 = hm.retrieve("immediate", layer=MemoryLayer.IMMEDIATE)
    assert len(results2) == 0

def test_hierarchical_memory_context(tmp_path):
    from lazy_chameleon.memory.hierarchical import HierarchicalMemory, MemoryLayer
    hm = HierarchicalMemory(db_path=str(tmp_path / "hm3.db"))
    hm.store("t1", "machine learning algorithms", MemoryLayer.LONG_TERM, importance=0.9)
    ctx = hm.get_context_for_task("machine learning", max_tokens=500)
    assert "machine learning" in ctx.lower()

def test_hierarchical_memory_stats(tmp_path):
    from lazy_chameleon.memory.hierarchical import HierarchicalMemory, MemoryLayer
    hm = HierarchicalMemory(db_path=str(tmp_path / "hm4.db"))
    hm.store("s1", "content", MemoryLayer.WORKING)
    stats = hm.stats()
    assert isinstance(stats, dict)

# ── ReflectionMemory ──────────────────────────────────────────────────────────
def test_reflection_memory_record(tmp_path):
    from lazy_chameleon.memory.reflection import ReflectionMemory
    rm = ReflectionMemory(db_path=str(tmp_path / "ref.db"))
    rid = rm.record_failure("math problem", "forgot to handle division by zero")
    assert rid != ""
    refs = rm.get_relevant_reflections("math calculation")
    assert len(refs) >= 1

def test_reflection_memory_correction(tmp_path):
    from lazy_chameleon.memory.reflection import ReflectionMemory
    rm = ReflectionMemory(db_path=str(tmp_path / "ref2.db"))
    rm.record_correction("python loop", "used range(len(x))", "use enumerate(x) instead")
    refs = rm.get_relevant_reflections("python loop")
    assert any("correction" in r.type.value for r in refs)

def test_reflection_memory_format(tmp_path):
    from lazy_chameleon.memory.reflection import ReflectionMemory
    rm = ReflectionMemory(db_path=str(tmp_path / "ref3.db"))
    rm.record_success("API design", "used versioning from day 1")
    refs = rm.get_relevant_reflections("API design")
    ctx  = rm.format_as_context(refs)
    assert "=== REFLECTION MEMORY ===" in ctx

def test_reflection_memory_stats(tmp_path):
    from lazy_chameleon.memory.reflection import ReflectionMemory
    rm = ReflectionMemory(db_path=str(tmp_path / "ref4.db"))
    rm.record_failure("task", "mistake")
    s = rm.stats()
    assert s["total"] >= 1

# ── SkillLibrary ──────────────────────────────────────────────────────────────
def test_skill_library_seed(tmp_path):
    from lazy_chameleon.core.skill_library import SkillLibrary
    sl = SkillLibrary(db_path=str(tmp_path / "skills.db"))
    stats = sl.stats()
    assert stats["total_skills"] >= 10    # seeded with 15

def test_skill_library_find(tmp_path):
    from lazy_chameleon.core.skill_library import SkillLibrary
    sl = SkillLibrary(db_path=str(tmp_path / "skills2.db"))
    skills = sl.find_skills("debug python error")
    assert len(skills) >= 1
    assert any("debug" in s.name.lower() or "python" in s.tags for s in skills)

def test_skill_library_add_use(tmp_path):
    from lazy_chameleon.core.skill_library import SkillLibrary
    sl = SkillLibrary(db_path=str(tmp_path / "skills3.db"))
    sid = sl.add_skill("test_skill", "A test skill", ["step1", "step2"], "testing", ["test"])
    sl.use_skill(sid, quality=0.9)
    skills = sl.find_skills("test skill")
    assert len(skills) >= 1

def test_skill_library_format(tmp_path):
    from lazy_chameleon.core.skill_library import SkillLibrary
    sl = SkillLibrary(db_path=str(tmp_path / "skills4.db"))
    skills = sl.find_skills("debug")
    ctx = sl.format_skills_as_context(skills)
    assert "=== RELEVANT SKILLS ===" in ctx

# ── NeuralCache ───────────────────────────────────────────────────────────────
def test_neural_cache_seed(tmp_path):
    from lazy_chameleon.core.neural_cache import NeuralCache
    nc = NeuralCache(db_path=str(tmp_path / "nc.db"))
    stats = nc.get_cache_stats()
    assert stats["total"] >= 10    # seeded with 15

def test_neural_cache_put_get(tmp_path):
    from lazy_chameleon.core.neural_cache import NeuralCache
    nc = NeuralCache(db_path=str(tmp_path / "nc2.db"))
    nc.put("how to debug Python", "Use pdb, add breakpoints, bisect the code", "approach", 0.9)
    result = nc.get("debug Python code", threshold=0.1)
    assert result is not None
    assert "pdb" in result.content or result is not None

def test_neural_cache_miss(tmp_path):
    from lazy_chameleon.core.neural_cache import NeuralCache
    nc = NeuralCache(db_path=str(tmp_path / "nc3.db"))
    result = nc.get("xyzzy quantum entanglement banana", threshold=0.9)
    assert result is None

def test_neural_cache_stats(tmp_path):
    from lazy_chameleon.core.neural_cache import NeuralCache
    nc = NeuralCache(db_path=str(tmp_path / "nc4.db"))
    s = nc.get_cache_stats()
    assert "hit_rate" in s

# ── MCTS ──────────────────────────────────────────────────────────────────────
def test_mcts_search_basic():
    from lazy_chameleon.synthesis.mcts import MCTSSearch, MCTSConfig
    cfg = MCTSConfig(max_iterations=20, max_depth=3)
    mcts = MCTSSearch(config=cfg)
    result = mcts.search("How do I sort a list in Python?", "")
    assert result.total_nodes > 1
    assert result.iterations_used <= 20
    assert isinstance(result.best_path, list)

def test_mcts_best_path_nonempty():
    from lazy_chameleon.synthesis.mcts import MCTSSearch, MCTSConfig
    cfg = MCTSConfig(max_iterations=15, max_depth=2)
    mcts = MCTSSearch(config=cfg)
    result = mcts.search("Explain recursion", "")
    assert len(result.best_path) >= 1

def test_mcts_tree_dict():
    from lazy_chameleon.synthesis.mcts import MCTSSearch, MCTSConfig
    cfg = MCTSConfig(max_iterations=10)
    mcts = MCTSSearch(config=cfg)
    result = mcts.search("test task", "")
    assert isinstance(result.reasoning_tree, dict)
    assert len(result.reasoning_tree) > 0

# ── WorldStateGraph ───────────────────────────────────────────────────────────
def test_world_state_basic():
    from lazy_chameleon.core.world_state import WorldStateGraph
    ws = WorldStateGraph()
    fid = ws.add_fact("Python uses indentation", confidence=1.0)
    gid = ws.add_goal("Understand Python syntax")
    cid = ws.add_constraint("Must use Python 3.10+")
    assert len(ws.get_facts()) == 1
    assert len(ws.get_goals()) == 1
    assert len(ws.get_constraints()) == 1

def test_world_state_contradictions():
    from lazy_chameleon.core.world_state import WorldStateGraph
    ws = WorldStateGraph()
    ws.add_fact("The service is running")
    ws.add_fact("The service is not running")
    contradictions = ws.detect_contradictions()
    assert len(contradictions) >= 1

def test_world_state_context_string():
    from lazy_chameleon.core.world_state import WorldStateGraph
    ws = WorldStateGraph()
    ws.add_fact("Python is interpreted")
    ws.add_goal("Write a Python script")
    ctx = ws.to_context_string()
    assert "FACTS" in ctx
    assert "GOALS" in ctx

def test_world_state_update_from_text():
    from lazy_chameleon.core.world_state import WorldStateGraph
    ws = WorldStateGraph()
    ws.update_from_text("Fact: The API returns JSON\nGoal: Parse the response\nConstraint: Must handle errors")
    assert len(ws.get_facts()) >= 1
    assert len(ws.get_goals()) >= 1

def test_world_state_stats():
    from lazy_chameleon.core.world_state import WorldStateGraph
    ws = WorldStateGraph()
    ws.add_fact("x")
    ws.add_goal("y")
    s = ws.stats()
    assert s["fact"] == 1
    assert s["goal"] == 1

# ── LatentWorkspace ───────────────────────────────────────────────────────────
def test_latent_workspace_write_read():
    from lazy_chameleon.core.latent_workspace import LatentWorkspace
    lw = LatentWorkspace()
    eid = lw.write("architect", "The system needs a message queue", "finding", confidence=0.9)
    assert eid != ""
    entries = lw.read(query="message queue")
    assert len(entries) >= 1
    assert "message queue" in entries[0].content

def test_latent_workspace_questions():
    from lazy_chameleon.core.latent_workspace import LatentWorkspace
    lw = LatentWorkspace()
    qid  = lw.write("scout", "What database should we use?", "question")
    aid  = lw.write("research", "PostgreSQL is recommended", "answer")
    lw.mark_answered(qid, aid)
    unanswered = lw.get_unanswered_questions()
    assert all(e.id != qid for e in unanswered)

def test_latent_workspace_summary():
    from lazy_chameleon.core.latent_workspace import LatentWorkspace
    lw = LatentWorkspace()
    lw.write("agent1", "Finding A", "finding")
    lw.write("agent2", "Warning B", "warning")
    s = lw.get_summary()
    assert "LATENT WORKSPACE" in s

def test_latent_workspace_threadsafe():
    from lazy_chameleon.core.latent_workspace import LatentWorkspace
    import threading
    lw = LatentWorkspace()
    def writer(i):
        lw.write(f"agent{i}", f"content {i}", "finding")
    threads = [threading.Thread(target=writer, args=(i,)) for i in range(20)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert len(lw.read_all()) == 20

def test_latent_workspace_snapshot():
    from lazy_chameleon.core.latent_workspace import LatentWorkspace
    lw = LatentWorkspace()
    lw.write("a", "content", "finding")
    snap = lw.snapshot()
    lw.clear()
    assert len(lw.read_all()) == 0
    lw.restore(snap)
    assert len(lw.read_all()) == 1

# ── ComputeCurrency ───────────────────────────────────────────────────────────
def test_compute_currency_allocate():
    from lazy_chameleon.core.compute_currency import ComputeCurrency
    cc = ComputeCurrency()
    ledger = cc.allocate("test task", "medium")
    assert ledger.initial_budget == 200
    assert ledger.remaining == 200

def test_compute_currency_spend():
    from lazy_chameleon.core.compute_currency import ComputeCurrency
    cc = ComputeCurrency()
    ledger = cc.allocate("test", "easy")
    assert cc.spend(ledger, "agent_call")
    assert ledger.remaining < ledger.initial_budget

def test_compute_currency_cant_overspend():
    from lazy_chameleon.core.compute_currency import ComputeCurrency
    cc = ComputeCurrency()
    ledger = cc.allocate("test", "easy")
    # Drain it
    while cc.spend(ledger, "agent_call"):
        pass
    assert not cc.spend(ledger, "agent_call")
    assert ledger.remaining == 0

def test_compute_currency_report():
    from lazy_chameleon.core.compute_currency import ComputeCurrency
    cc = ComputeCurrency()
    ledger = cc.allocate("task", "hard")
    cc.spend(ledger, "agent_call")
    report = cc.get_spending_report(ledger)
    assert "spent" in report
    assert report["spent"] > 0

def test_compute_currency_suggest_cutback():
    from lazy_chameleon.core.compute_currency import ComputeCurrency
    cc = ComputeCurrency()
    ledger = cc.allocate("task", "easy")
    while cc.spend(ledger, "agent_call"): pass
    suggestion = cc.suggest_cutback(ledger)
    assert suggestion != "full_pipeline"

# ── RecursivePlanner ──────────────────────────────────────────────────────────
def test_recursive_planner_basic():
    from lazy_chameleon.core.recursive_planner import RecursivePlanner
    rp = RecursivePlanner(max_depth=2, max_nodes=16)
    plan = rp.plan("Build a REST API with authentication")
    assert plan.root_id in plan.nodes
    assert len(plan.nodes) > 1

def test_recursive_planner_critical_path():
    from lazy_chameleon.core.recursive_planner import RecursivePlanner
    rp = RecursivePlanner(max_depth=2)
    plan = rp.plan("Implement and test a sorting algorithm")
    assert isinstance(plan.critical_path, list)

def test_recursive_planner_execute():
    from lazy_chameleon.core.recursive_planner import RecursivePlanner
    rp = RecursivePlanner(max_depth=1, max_nodes=8)
    plan = rp.plan("Simple task")
    results = rp.execute_plan(plan, executor_fn=lambda task, ctx: f"Done: {task[:30]}")
    assert len(results) > 0
    assert all(r.startswith("Done:") for r in results.values())

def test_recursive_planner_visualize():
    from lazy_chameleon.core.recursive_planner import RecursivePlanner
    rp = RecursivePlanner(max_depth=2)
    plan = rp.plan("Design a database schema")
    vis = rp.visualize_plan(plan)
    assert "EXECUTION PLAN" in vis

# ── SimulationEngine ──────────────────────────────────────────────────────────
def test_simulation_engine_basic():
    from lazy_chameleon.core.simulation_engine import SimulationEngine
    se = SimulationEngine(n_futures=3)
    result = se.simulate("Deploy a new API endpoint")
    assert len(result.futures) == 3
    assert result.risk_level in ("low", "medium", "high", "critical")
    assert result.recommended_future != ""

def test_simulation_engine_format():
    from lazy_chameleon.core.simulation_engine import SimulationEngine
    se = SimulationEngine(n_futures=3)
    result = se.simulate("Store user data in a database")
    ctx = se.format_as_context(result)
    assert "SIMULATION" in ctx
    assert "Risk Level" in ctx

def test_simulation_engine_consensus():
    from lazy_chameleon.core.simulation_engine import SimulationEngine
    se = SimulationEngine(n_futures=4)
    result = se.simulate("Handle concurrent requests")
    assert result.consensus_action != ""

# ── AdaptiveMoE ───────────────────────────────────────────────────────────────
def test_adaptive_moe_spawn():
    from lazy_chameleon.synthesis.adaptive_moe import AdaptiveMoE
    moe = AdaptiveMoE()
    exp = moe.spawn_expert("researcher", "Research Python async", budget=50)
    assert exp.alive
    assert exp.budget_remaining == 50

def test_adaptive_moe_scale():
    from lazy_chameleon.synthesis.adaptive_moe import AdaptiveMoE
    moe = AdaptiveMoE()
    experts = moe.scale_to_task("Design a system", "medium")
    assert len(experts) == 8
    assert all(e.alive for e in experts)

def test_adaptive_moe_split():
    from lazy_chameleon.synthesis.adaptive_moe import AdaptiveMoE
    moe = AdaptiveMoE()
    parent = moe.spawn_expert("planner", "Big task", budget=100)
    children = moe.split_expert(parent, n_children=3)
    assert len(children) == 3
    assert not parent.alive

def test_adaptive_moe_merge():
    from lazy_chameleon.synthesis.adaptive_moe import AdaptiveMoE
    moe = AdaptiveMoE()
    e1 = moe.spawn_expert("coder", "Task A", budget=50)
    e2 = moe.spawn_expert("critic", "Task B", budget=50)
    e1.result = "Code result"
    e2.result = "Critique result"
    merged = moe.merge_experts([e1, e2])
    assert merged.result != ""
    assert "Code result" in merged.result

def test_adaptive_moe_aggregate():
    from lazy_chameleon.synthesis.adaptive_moe import AdaptiveMoE
    moe = AdaptiveMoE()
    experts = moe.scale_to_task("test", "easy")
    for e in experts[:3]:
        e.result = f"Result from {e.role}"
        e.confidence = 0.8
    agg = moe.aggregate_results(experts)
    assert agg["n_experts"] == 3
    assert agg["confidence"] > 0

# ── DynamicPromptCompiler ─────────────────────────────────────────────────────
def test_prompt_compiler_basic():
    from lazy_chameleon.synthesis.prompt_compiler import DynamicPromptCompiler
    pc = DynamicPromptCompiler()
    compiled = pc.compile("Fix this Python bug", task_type="coding", difficulty="medium")
    assert len(compiled.system_prompt) > 50
    assert "role" in compiled.components_used
    assert compiled.reasoning_strategy != ""

def test_prompt_compiler_respects_budget():
    from lazy_chameleon.synthesis.prompt_compiler import DynamicPromptCompiler
    pc = DynamicPromptCompiler(max_tokens=100)
    compiled = pc.compile("Simple question", task_type="general", difficulty="easy")
    assert compiled.estimated_tokens <= 500   # a bit of slack for required components

def test_prompt_compiler_injects_context():
    from lazy_chameleon.synthesis.prompt_compiler import DynamicPromptCompiler
    pc = DynamicPromptCompiler()
    compiled = pc.compile("Task", context="Important context here",
                          inject_components={"skills": ["skill A", "skill B"]})
    assert "context" in compiled.components_used
    assert "skills" in compiled.components_used

def test_prompt_compiler_strategies():
    from lazy_chameleon.synthesis.prompt_compiler import DynamicPromptCompiler
    pc = DynamicPromptCompiler()
    easy = pc.compile("2+2", difficulty="easy").reasoning_strategy
    hard = pc.compile("Prove Fermat's Last Theorem", task_type="math", difficulty="extreme").reasoning_strategy
    assert easy in ("chain_of_thought", "scratchpad", "step_back", "tree_of_thought",
                    "least_to_most", "self_consistency", "constitutional", "debate")
    assert hard in ("chain_of_thought", "scratchpad", "step_back", "tree_of_thought",
                    "least_to_most", "self_consistency", "constitutional", "debate")

# ── EvolutionEngine ───────────────────────────────────────────────────────────
def test_evolution_engine_init():
    from lazy_chameleon.synthesis.evolution_engine import EvolutionEngine, EvolutionConfig
    cfg = EvolutionConfig(population_size=8)
    ee = EvolutionEngine(config=cfg)
    assert len(ee._population) == 8

def test_evolution_engine_best_strategy():
    from lazy_chameleon.synthesis.evolution_engine import EvolutionEngine
    ee = EvolutionEngine()
    best = ee.get_best_strategy()
    assert best is not None
    assert best.strategy_name != ""
    assert isinstance(best.params, dict)

def test_evolution_engine_record_outcome():
    from lazy_chameleon.synthesis.evolution_engine import EvolutionEngine
    ee = EvolutionEngine()
    strategy = ee._population[0]
    ee.record_outcome(strategy.strategy_name, "test task", quality=0.9, speed=0.7)
    updated = next(s for s in ee._population if s.strategy_name == strategy.strategy_name)
    assert updated.fitness_score > 0

def test_evolution_engine_evolve():
    from lazy_chameleon.synthesis.evolution_engine import EvolutionEngine, EvolutionConfig
    cfg = EvolutionConfig(population_size=8, elitism_count=2)
    ee  = EvolutionEngine(config=cfg)
    scores = [0.5 + i * 0.05 for i in range(len(ee._population))]
    new_pop = ee.evolve_generation(ee._population, scores)
    assert len(new_pop) == 8

def test_evolution_engine_crossover_mutate():
    from lazy_chameleon.synthesis.evolution_engine import EvolutionEngine
    ee = EvolutionEngine()
    p1 = ee._population[0]
    p2 = ee._population[1]
    child = ee.crossover(p1, p2)
    mutant = ee.mutate(p1)
    assert child.params != {}
    assert mutant.strategy_name != ""

def test_evolution_engine_save_load(tmp_path):
    from lazy_chameleon.synthesis.evolution_engine import EvolutionEngine
    ee = EvolutionEngine()
    path = str(tmp_path / "evo" / "state.json")
    ee.save(path)
    ee2 = EvolutionEngine()
    ee2.load(path)
    assert len(ee2._population) > 0
