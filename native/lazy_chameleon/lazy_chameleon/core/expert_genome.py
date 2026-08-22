"""
ExpertGenome — DNA-based expert specialization with evolution.

Successful experts breed. Poor performers retire.
Over time the system builds a library of effective specialists.
"""
from __future__ import annotations
import json
import os
import random
import uuid
from dataclasses import dataclass, field
from typing import Optional


GENOME_TRAITS = [
    "planning_strength", "coding_strength", "math_strength",
    "creativity", "criticism", "research", "speed", "precision",
    "debugging", "communication", "synthesis", "verification",
]

_SEED_GENOMES = {
    "architect":  dict(planning_strength=0.9, coding_strength=0.7, math_strength=0.5,
                       creativity=0.8, criticism=0.6, research=0.6, speed=0.5,
                       precision=0.8, debugging=0.4, communication=0.7, synthesis=0.8, verification=0.7),
    "critic":     dict(planning_strength=0.5, coding_strength=0.6, math_strength=0.6,
                       creativity=0.4, criticism=0.95, research=0.7, speed=0.6,
                       precision=0.9, debugging=0.7, communication=0.8, synthesis=0.5, verification=0.95),
    "debug":      dict(planning_strength=0.5, coding_strength=0.9, math_strength=0.6,
                       creativity=0.5, criticism=0.8, research=0.6, speed=0.7,
                       precision=0.9, debugging=0.95, communication=0.5, synthesis=0.5, verification=0.8),
    "historian":  dict(planning_strength=0.4, coding_strength=0.3, math_strength=0.4,
                       creativity=0.6, criticism=0.7, research=0.95, speed=0.4,
                       precision=0.7, debugging=0.3, communication=0.8, synthesis=0.7, verification=0.6),
    "optimizer":  dict(planning_strength=0.7, coding_strength=0.8, math_strength=0.8,
                       creativity=0.6, criticism=0.7, research=0.5, speed=0.9,
                       precision=0.8, debugging=0.7, communication=0.5, synthesis=0.7, verification=0.7),
    "research":   dict(planning_strength=0.6, coding_strength=0.5, math_strength=0.7,
                       creativity=0.7, criticism=0.6, research=0.95, speed=0.4,
                       precision=0.7, debugging=0.4, communication=0.7, synthesis=0.8, verification=0.6),
    "scout":      dict(planning_strength=0.6, coding_strength=0.5, math_strength=0.4,
                       creativity=0.7, criticism=0.5, research=0.8, speed=0.9,
                       precision=0.5, debugging=0.5, communication=0.8, synthesis=0.6, verification=0.4),
    "simulator":  dict(planning_strength=0.7, coding_strength=0.7, math_strength=0.8,
                       creativity=0.8, criticism=0.6, research=0.6, speed=0.6,
                       precision=0.7, debugging=0.6, communication=0.6, synthesis=0.9, verification=0.7),
}


@dataclass
class ExpertGene:
    trait_name: str
    value: float          # 0.0 – 1.0
    mutation_rate: float = 0.1


@dataclass
class ExpertGenome:
    expert_id: str
    base_type: str        # architect / critic / …
    genes: dict[str, ExpertGene] = field(default_factory=dict)
    generation: int = 0
    parent_ids: list[str] = field(default_factory=list)
    fitness_history: list[float] = field(default_factory=list)
    total_runs: int = 0
    successes: int = 0

    # ---- trait shortcuts ------------------------------------------------
    def _g(self, name: str) -> float:
        return self.genes.get(name, ExpertGene(name, 0.5)).value

    @property
    def planning_strength(self) -> float: return self._g("planning_strength")
    @property
    def coding_strength(self)   -> float: return self._g("coding_strength")
    @property
    def math_strength(self)     -> float: return self._g("math_strength")
    @property
    def creativity(self)        -> float: return self._g("creativity")
    @property
    def criticism(self)         -> float: return self._g("criticism")
    @property
    def research(self)          -> float: return self._g("research")
    @property
    def speed(self)             -> float: return self._g("speed")
    @property
    def precision(self)         -> float: return self._g("precision")

    # ---- evolution ------------------------------------------------------
    def mutate(self, rate: float = 0.1) -> "ExpertGenome":
        new_genes: dict[str, ExpertGene] = {}
        for name, gene in self.genes.items():
            effective_rate = rate * gene.mutation_rate / 0.1
            if random.random() < effective_rate:
                delta = random.gauss(0, 0.1)
                new_val = max(0.0, min(1.0, gene.value + delta))
            else:
                new_val = gene.value
            new_genes[name] = ExpertGene(name, new_val, gene.mutation_rate)
        return ExpertGenome(
            expert_id=str(uuid.uuid4())[:8],
            base_type=self.base_type,
            genes=new_genes,
            generation=self.generation + 1,
            parent_ids=[self.expert_id],
        )

    def crossover(self, other: "ExpertGenome") -> "ExpertGenome":
        new_genes: dict[str, ExpertGene] = {}
        for name in set(list(self.genes.keys()) + list(other.genes.keys())):
            g1 = self.genes.get(name)
            g2 = other.genes.get(name)
            if g1 and g2:
                val = (g1.value + g2.value) / 2 + random.gauss(0, 0.05)
                val = max(0.0, min(1.0, val))
                mr  = (g1.mutation_rate + g2.mutation_rate) / 2
            elif g1:
                val, mr = g1.value, g1.mutation_rate
            else:
                val, mr = g2.value, g2.mutation_rate
            new_genes[name] = ExpertGene(name, val, mr)
        return ExpertGenome(
            expert_id=str(uuid.uuid4())[:8],
            base_type=f"{self.base_type}x{other.base_type}",
            genes=new_genes,
            generation=max(self.generation, other.generation) + 1,
            parent_ids=[self.expert_id, other.expert_id],
        )

    def update_fitness(self, success: bool, quality: float):
        self.total_runs += 1
        if success:
            self.successes += 1
        self.fitness_history.append(quality)
        if len(self.fitness_history) > 50:
            self.fitness_history = self.fitness_history[-50:]

    def fitness_score(self) -> float:
        if not self.fitness_history:
            return 0.5
        recent = self.fitness_history[-10:]
        base = sum(recent) / len(recent)
        success_ratio = self.successes / max(self.total_runs, 1)
        return 0.7 * base + 0.3 * success_ratio

    def to_dict(self) -> dict:
        return {
            "expert_id": self.expert_id,
            "base_type": self.base_type,
            "genes": {k: {"value": v.value, "mutation_rate": v.mutation_rate}
                      for k, v in self.genes.items()},
            "generation": self.generation,
            "parent_ids": self.parent_ids,
            "fitness_history": self.fitness_history,
            "total_runs": self.total_runs,
            "successes": self.successes,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ExpertGenome":
        genes = {k: ExpertGene(k, v["value"], v.get("mutation_rate", 0.1))
                 for k, v in d.get("genes", {}).items()}
        g = cls(expert_id=d["expert_id"], base_type=d["base_type"], genes=genes,
                generation=d.get("generation", 0),
                parent_ids=d.get("parent_ids", []),
                fitness_history=d.get("fitness_history", []),
                total_runs=d.get("total_runs", 0),
                successes=d.get("successes", 0))
        return g


def _make_seed_genome(base_type: str) -> ExpertGenome:
    traits = _SEED_GENOMES.get(base_type, {t: 0.5 for t in GENOME_TRAITS})
    genes  = {t: ExpertGene(t, traits.get(t, 0.5)) for t in GENOME_TRAITS}
    return ExpertGenome(expert_id=f"seed-{base_type}", base_type=base_type, genes=genes)


class ExpertGenomeLibrary:
    """Maintains and evolves the population of expert genomes."""

    _instance: Optional["ExpertGenomeLibrary"] = None

    def __init__(self):
        self._population: dict[str, ExpertGenome] = {}
        self._init_seed_population()

    @classmethod
    def get(cls) -> "ExpertGenomeLibrary":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _init_seed_population(self):
        for base_type in _SEED_GENOMES:
            g = _make_seed_genome(base_type)
            self._population[g.expert_id] = g

    # ---- query ----------------------------------------------------------
    def get_best_genome_for_task(self, task_type: str) -> ExpertGenome:
        task_lower = task_type.lower()
        scores: list[tuple[float, ExpertGenome]] = []
        for g in self._population.values():
            fit = g.fitness_score()
            # bonus if base_type matches task hint
            if g.base_type in task_lower or task_lower in g.base_type:
                fit += 0.2
            scores.append((fit, g))
        scores.sort(key=lambda x: x[0], reverse=True)
        return scores[0][1] if scores else _make_seed_genome("architect")

    def add_genome(self, genome: ExpertGenome):
        self._population[genome.expert_id] = genome

    def population_size(self) -> int:
        return len(self._population)

    # ---- evolution ------------------------------------------------------
    def evolve_generation(self):
        pop = list(self._population.values())
        if len(pop) < 4:
            return
        pop.sort(key=lambda g: g.fitness_score(), reverse=True)

        # Retire bottom 20 %
        cutoff = max(2, int(len(pop) * 0.2))
        for g in pop[-cutoff:]:
            if not g.expert_id.startswith("seed-"):
                del self._population[g.expert_id]

        # Breed top 20 %
        top = pop[:max(2, int(len(pop) * 0.2))]
        for i in range(len(top) - 1):
            child = top[i].crossover(top[i + 1]).mutate()
            self._population[child.expert_id] = child

    # ---- persistence ----------------------------------------------------
    def save(self, path: str):
        path = os.path.expanduser(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump({k: v.to_dict() for k, v in self._population.items()}, f, indent=2)

    def load(self, path: str):
        path = os.path.expanduser(path)
        if not os.path.exists(path):
            return
        with open(path) as f:
            data = json.load(f)
        for k, v in data.items():
            self._population[k] = ExpertGenome.from_dict(v)
