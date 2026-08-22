"""EvolutionEngine — Evolutionary improvement of reasoning strategies."""
from __future__ import annotations
import json, os, random, uuid
from dataclasses import dataclass, field

_SEED_STRATEGIES = [
    {"strategy_name": "chain_of_draft",    "params": {"temperature": 0.3, "n_passes": 1, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 3}},
    {"strategy_name": "step_by_step",      "params": {"temperature": 0.2, "n_passes": 1, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 5}},
    {"strategy_name": "devils_advocate",   "params": {"temperature": 0.5, "n_passes": 2, "debate_rounds": 1, "mcts_iterations": 0, "reasoning_depth": 3}},
    {"strategy_name": "self_consistency",  "params": {"temperature": 0.7, "n_passes": 3, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 2}},
    {"strategy_name": "constitutional",    "params": {"temperature": 0.3, "n_passes": 2, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 4}},
    {"strategy_name": "budget_force",      "params": {"temperature": 0.4, "n_passes": 5, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 2}},
    {"strategy_name": "scratchpad",        "params": {"temperature": 0.5, "n_passes": 1, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 4}},
    {"strategy_name": "mcts_light",        "params": {"temperature": 0.4, "n_passes": 1, "debate_rounds": 0, "mcts_iterations": 20, "reasoning_depth": 3}},
    {"strategy_name": "mcts_debate",       "params": {"temperature": 0.4, "n_passes": 1, "debate_rounds": 2, "mcts_iterations": 30, "reasoning_depth": 4}},
    {"strategy_name": "deep_reasoning",    "params": {"temperature": 0.3, "n_passes": 3, "debate_rounds": 1, "mcts_iterations": 10, "reasoning_depth": 6}},
    {"strategy_name": "fast_direct",       "params": {"temperature": 0.1, "n_passes": 1, "debate_rounds": 0, "mcts_iterations": 0, "reasoning_depth": 1}},
    {"strategy_name": "exploratory",       "params": {"temperature": 0.8, "n_passes": 2, "debate_rounds": 0, "mcts_iterations": 15, "reasoning_depth": 3}},
]

_PARAM_BOUNDS = {
    "temperature":     (0.0, 1.0),
    "n_passes":        (1, 10),
    "debate_rounds":   (0, 4),
    "mcts_iterations": (0, 100),
    "reasoning_depth": (1, 8),
}


@dataclass
class StrategyGene:
    strategy_name: str
    params: dict
    fitness_score: float = 0.5
    generation: int = 0
    parent_strategies: list[str] = field(default_factory=list)
    outcome_history: list[dict] = field(default_factory=list)


@dataclass
class EvolutionConfig:
    population_size: int = 12
    mutation_rate: float = 0.2
    crossover_rate: float = 0.6
    elitism_count: int = 3
    tournament_size: int = 3
    max_generations: int = 50


class EvolutionEngine:
    def __init__(self, config: EvolutionConfig | None = None):
        self.cfg = config or EvolutionConfig()
        self._population: list[StrategyGene] = self.initialize_population()
        self._generation  = 0
        self._outcome_log: list[dict] = []

    def initialize_population(self) -> list[StrategyGene]:
        seeds = [StrategyGene(s["strategy_name"], dict(s["params"])) for s in _SEED_STRATEGIES]
        # pad to population_size with mutations of seeds
        pop = seeds[:]
        while len(pop) < self.cfg.population_size:
            parent = random.choice(seeds)
            child  = self.mutate(parent)
            pop.append(child)
        return pop[:self.cfg.population_size]

    # ---- fitness --------------------------------------------------------
    def evaluate_fitness(self, strategy: StrategyGene, task: str,
                         quality: float, speed: float) -> float:
        # Multi-objective: quality (70%) + speed (30%) - complexity cost (10%)
        complexity = (strategy.params.get("n_passes", 1) * 0.05
                      + strategy.params.get("mcts_iterations", 0) * 0.002
                      + strategy.params.get("debate_rounds", 0) * 0.1)
        fitness = 0.7 * quality + 0.3 * speed - 0.1 * min(complexity, 1.0)
        return max(0.0, min(1.0, fitness))

    # ---- selection ------------------------------------------------------
    def tournament_select(self, population: list[StrategyGene]) -> StrategyGene:
        contestants = random.sample(population, min(self.cfg.tournament_size, len(population)))
        return max(contestants, key=lambda s: s.fitness_score)

    # ---- crossover + mutation ------------------------------------------
    def crossover(self, p1: StrategyGene, p2: StrategyGene) -> StrategyGene:
        new_params: dict = {}
        for key in set(list(p1.params.keys()) + list(p2.params.keys())):
            v1 = p1.params.get(key, 0)
            v2 = p2.params.get(key, 0)
            lo, hi = _PARAM_BOUNDS.get(key, (0, 1))
            blended = (v1 + v2) / 2 + random.gauss(0, (hi - lo) * 0.05)
            new_params[key] = max(lo, min(hi, type(v1)(blended)))
        name = f"{p1.strategy_name}x{p2.strategy_name}"[:30]
        return StrategyGene(name, new_params, generation=max(p1.generation, p2.generation) + 1,
                            parent_strategies=[p1.strategy_name, p2.strategy_name])

    def mutate(self, strategy: StrategyGene) -> StrategyGene:
        new_params = dict(strategy.params)
        for key, (lo, hi) in _PARAM_BOUNDS.items():
            if key in new_params and random.random() < self.cfg.mutation_rate:
                delta = random.gauss(0, (hi - lo) * 0.1)
                raw   = new_params[key] + delta
                if isinstance(new_params[key], int):
                    new_params[key] = max(int(lo), min(int(hi), int(round(raw))))
                else:
                    new_params[key] = max(lo, min(hi, raw))
        return StrategyGene(
            strategy_name=strategy.strategy_name + "_m",
            params=new_params,
            generation=strategy.generation + 1,
            parent_strategies=[strategy.strategy_name],
        )

    # ---- generation step -----------------------------------------------
    def evolve_generation(self, population: list[StrategyGene],
                          fitness_scores: list[float]) -> list[StrategyGene]:
        for s, f in zip(population, fitness_scores):
            s.fitness_score = f
        population.sort(key=lambda s: s.fitness_score, reverse=True)
        elites   = population[:self.cfg.elitism_count]
        new_pop  = list(elites)
        while len(new_pop) < self.cfg.population_size:
            if random.random() < self.cfg.crossover_rate and len(population) >= 2:
                p1 = self.tournament_select(population)
                p2 = self.tournament_select(population)
                child = self.crossover(p1, p2)
            else:
                parent = self.tournament_select(population)
                child  = self.mutate(parent)
            new_pop.append(child)
        self._population = new_pop[:self.cfg.population_size]
        self._generation += 1
        return self._population

    # ---- query ----------------------------------------------------------
    def get_best_strategy(self, task_type: str | None = None) -> StrategyGene:
        pop = self._population
        if task_type:
            task_low = task_type.lower()
            scored = sorted(pop,
                key=lambda s: s.fitness_score + (0.2 if task_low in s.strategy_name else 0),
                reverse=True)
            return scored[0] if scored else pop[0]
        return max(pop, key=lambda s: s.fitness_score)

    def record_outcome(self, strategy_name: str, task: str,
                       quality: float, speed: float):
        entry = {"strategy": strategy_name, "task": task[:60],
                 "quality": quality, "speed": speed}
        self._outcome_log.append(entry)
        for s in self._population:
            if s.strategy_name == strategy_name:
                s.fitness_score = self.evaluate_fitness(s, task, quality, speed)
                s.outcome_history.append(entry)
                break

    # ---- persistence ----------------------------------------------------
    def save(self, path: str):
        path = os.path.expanduser(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump({"generation": self._generation,
                       "population": [{"name": s.strategy_name, "params": s.params,
                                       "fitness": s.fitness_score, "gen": s.generation}
                                      for s in self._population]}, f, indent=2)

    def load(self, path: str):
        path = os.path.expanduser(path)
        if not os.path.exists(path):
            return
        with open(path) as f:
            data = json.load(f)
        self._generation  = data.get("generation", 0)
        self._population  = [StrategyGene(p["name"], p["params"],
                                          p.get("fitness", 0.5), p.get("gen", 0))
                             for p in data.get("population", [])]
