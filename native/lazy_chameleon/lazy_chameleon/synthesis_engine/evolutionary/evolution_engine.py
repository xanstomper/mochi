"""Evolutionary computation: NEAT-style topology evolution, CMA-ES,
MAP-Elites, Genetic Programming, population management."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np


@dataclass
class Individual:
    """An individual in the evolutionary population."""
    genome: np.ndarray  # flattened parameter vector
    fitness: float = -float('inf')
    species_id: Optional[int] = None
    age: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def decode(self, shapes: Dict[str, Tuple[int, ...]]) -> Dict[str, np.ndarray]:
        """Decode genome into named parameters."""
        params: Dict[str, np.ndarray] = {}
        offset = 0
        for name, shape in shapes.items():
            size = int(np.prod(shape))
            params[name] = self.genome[offset:offset + size].reshape(shape)
            offset += size
        return params

    @classmethod
    def from_params(cls, params: Dict[str, np.ndarray],
                    fitness: float = -float('inf')) -> Individual:
        genome = np.concatenate([p.ravel() for p in params.values()])
        return cls(genome=genome, fitness=fitness)


@dataclass
class FitnessEvaluator:
    """Evaluates fitness of individuals."""
    eval_func: Optional[Callable[[Individual], float]] = None

    def evaluate(self, individual: Individual) -> float:
        """Evaluate an individual and return fitness."""
        if self.eval_func is not None:
            fitness = self.eval_func(individual)
        else:
            # Default: use genome norm as fitness
            fitness = -np.linalg.norm(individual.genome)
        individual.fitness = fitness
        return fitness

    def evaluate_population(self, population: List[Individual]) -> List[float]:
        return [self.evaluate(ind) for ind in population]


class PopulationManager:
    """Manages population selection, crossover, and mutation."""

    def __init__(self, seed: int = 42):
        self.rng = random.Random(seed)
        self.np_rng = np.random.default_rng(seed)

    def create_initial_population(
        self,
        genome_size: int,
        pop_size: int = 100,
        init_range: float = 0.1,
    ) -> List[Individual]:
        """Create initial random population."""
        return [
            Individual(genome=self.np_rng.uniform(-init_range, init_range, genome_size))
            for _ in range(pop_size)
        ]

    def tournament_select(
        self,
        population: List[Individual],
        tournament_size: int = 3,
    ) -> Individual:
        """Tournament selection."""
        tournament = self.rng.sample(population, min(tournament_size, len(population)))
        return max(tournament, key=lambda ind: ind.fitness)

    def roulette_select(self, population: List[Individual]) -> Individual:
        """Roulette wheel selection."""
        fitnesses = np.array([max(0.0, ind.fitness) for ind in population])
        total = fitnesses.sum()
        if total <= 0:
            return self.rng.choice(population)
        probs = fitnesses / total
        idx = np.random.choice(len(population), p=probs)
        return population[int(idx)]

    def crossover(
        self,
        parent_a: Individual,
        parent_b: Individual,
        method: str = "uniform",
    ) -> Tuple[Individual, Individual]:
        """Perform crossover between two parents."""
        size = len(parent_a.genome)

        if method == "uniform":
            mask = self.np_rng.random(size) < 0.5
            child1_genome = np.where(mask, parent_a.genome, parent_b.genome)
            child2_genome = np.where(mask, parent_b.genome, parent_a.genome)
        elif method == "single_point":
            point = self.rng.randint(1, size - 1)
            child1_genome = np.concatenate([parent_a.genome[:point], parent_b.genome[point:]])
            child2_genome = np.concatenate([parent_b.genome[:point], parent_a.genome[point:]])
        elif method == "arithmetic":
            alpha = self.rng.random()
            child1_genome = alpha * parent_a.genome + (1.0 - alpha) * parent_b.genome
            child2_genome = (1.0 - alpha) * parent_a.genome + alpha * parent_b.genome
        else:
            child1_genome = parent_a.genome.copy()
            child2_genome = parent_b.genome.copy()

        return (
            Individual(genome=child1_genome),
            Individual(genome=child2_genome),
        )

    def mutate(
        self,
        individual: Individual,
        mutation_rate: float = 0.1,
        mutation_scale: float = 0.05,
    ) -> Individual:
        """Mutate an individual's genome."""
        genome = individual.genome.copy()
        mask = self.np_rng.random(len(genome)) < mutation_rate
        noise = self.np_rng.normal(0.0, mutation_scale, len(genome))
        genome[mask] += noise[mask]
        return Individual(genome=genome)

    def next_generation(
        self,
        population: List[Individual],
        pop_size: int,
        elite_count: int = 2,
        mutation_rate: float = 0.1,
    ) -> List[Individual]:
        """Create next generation through selection, crossover, mutation."""
        population.sort(key=lambda ind: ind.fitness, reverse=True)

        # Elitism
        next_gen: List[Individual] = population[:elite_count]

        while len(next_gen) < pop_size:
            p1 = self.tournament_select(population)
            p2 = self.tournament_select(population)

            if self.rng.random() < 0.7:
                c1, c2 = self.crossover(p1, p2)
                children = [self.mutate(c, mutation_rate) for c in [c1, c2]]
            else:
                children = [self.mutate(p1, mutation_rate)]

            next_gen.extend(children[:pop_size - len(next_gen)])

        return next_gen


class NEATEvolution:
    """NEAT-style topology evolution for neural networks.
    
    Evolves both weights and network topology (connections).
    """

    def __init__(
        self,
        input_size: int = 4,
        output_size: int = 2,
        pop_size: int = 50,
        seed: int = 42,
    ):
        self.input_size = input_size
        self.output_size = output_size
        self.pop_size = pop_size
        self.rng = random.Random(seed)
        self.np_rng = np.random.default_rng(seed)
        self.population_manager = PopulationManager(seed)
        self.generation = 0

        # Innovation tracking
        self._innovation_number = 0
        self._node_innovations: Dict[Tuple[int, int], int] = {}

    def _create_genome(self) -> np.ndarray:
        """Create random genome (weights + topology encoding)."""
        # Structure: [input*output weights, bias, connection_mask]
        n_weights = self.input_size * self.output_size
        weights = self.np_rng.uniform(-1.0, 1.0, n_weights)
        biases = self.np_rng.uniform(-1.0, 1.0, self.output_size)
        # Connection mask: which connections are active
        mask = (self.np_rng.random(n_weights) < 0.5).astype(np.float32)
        return np.concatenate([weights * mask, biases])

    def create_initial_population(self) -> List[Individual]:
        return [
            Individual(genome=self._create_genome())
            for _ in range(self.pop_size)
        ]

    def mutate_topology(self, individual: Individual) -> Individual:
        """Mutate the topology (add/remove connections)."""
        genome = individual.genome.copy()
        n_weights = self.input_size * self.output_size
        weights_part = genome[:n_weights]
        bias_part = genome[n_weights:]

        # Add connection with small probability
        if self.rng.random() < 0.05:
            idx = self.rng.randint(0, n_weights - 1)
            if abs(weights_part[idx]) < 1e-6:
                weights_part[idx] = self.np_rng.uniform(-1.0, 1.0)

        # Remove connection
        if self.rng.random() < 0.05:
            idx = self.rng.randint(0, n_weights - 1)
            weights_part[idx] = 0.0

        # Mutate existing weights
        mask = self.np_rng.random(n_weights) < 0.1
        weights_part[mask] += self.np_rng.normal(0.0, 0.1, mask.sum())

        return Individual(genome=np.concatenate([weights_part, bias_part]))

    def forward(self, genome: np.ndarray, x: np.ndarray) -> np.ndarray:
        """Forward pass through the evolved network."""
        n_weights = self.input_size * self.output_size
        weights = genome[:n_weights].reshape(self.input_size, self.output_size)
        biases = genome[n_weights:]
        return np.dot(x, weights) + biases

    def evolve(
        self,
        fitness_func: Callable[[Individual], float],
        num_generations: int = 50,
    ) -> Individual:
        """Run evolution for specified generations."""
        population = self.create_initial_population()
        evaluator = FitnessEvaluator(fitness_func)

        for gen in range(num_generations):
            self.generation = gen
            evaluator.evaluate_population(population)

            population = self.population_manager.next_generation(
                population, self.pop_size, elite_count=3
            )

            # Apply topology mutations
            population = [
                self.mutate_topology(ind) if i >= 3 else ind
                for i, ind in enumerate(population)
            ]

        evaluator.evaluate_population(population)
        return max(population, key=lambda ind: ind.fitness)


class CMAES:
    """Covariance Matrix Adaptation Evolution Strategy."""

    def __init__(
        self,
        genome_size: int,
        pop_size: Optional[int] = None,
        init_sigma: float = 0.5,
        seed: int = 42,
    ):
        self.dim = genome_size
        self.pop_size = pop_size or max(10, 4 + int(3 * math.log(genome_size)))
        self.sigma = init_sigma
        self.rng = np.random.default_rng(seed)

        # Strategy parameters
        self.mean = self.rng.normal(0.0, 0.1, genome_size)
        self.C = np.eye(genome_size, dtype=np.float64)

        # Adaptation parameters
        self.p_c = np.zeros(genome_size, dtype=np.float64)
        self.p_s = np.zeros(genome_size, dtype=np.float64)
        self.mu = self.pop_size // 2
        self.mu_eff = self.mu
        self.c_c = (4.0 + self.mu_eff / self.dim) / (self.dim + 4.0 + 2.0 * self.mu_eff / self.dim)
        self.c_s = (self.mu_eff + 2.0) / (self.dim + self.mu_eff + 5.0)
        self.c_1 = 2.0 / ((self.dim + 1.3) ** 2 + self.mu_eff)
        self.c_mu = min(1.0 - self.c_1,
                        2.0 * (self.mu_eff - 2.0 + 1.0 / self.mu_eff) /
                        ((self.dim + 2.0) ** 2 + self.mu_eff))
        self.d_s = 1.0 + 2.0 * max(0.0, math.sqrt((self.mu_eff - 1.0) / (self.dim + 1.0)) - 1.0)
        self.chi = math.sqrt(self.dim) * (1.0 - 1.0 / (4.0 * self.dim) + 1.0 / (21.0 * self.dim ** 2))

        self._generation = 0
        self._best_fitness = -float('inf')

    def ask(self) -> List[Individual]:
        """Generate new population."""
        try:
            L = np.linalg.cholesky(self.C)
        except np.linalg.LinAlgError:
            L = np.eye(self.dim, dtype=np.float64)

        population: List[Individual] = []
        for _ in range(self.pop_size):
            z = self.rng.normal(0.0, 1.0, self.dim)
            genome = self.mean + self.sigma * L @ z
            population.append(Individual(genome=genome.astype(np.float32)))

        return population

    def tell(self, population: List[Individual]) -> None:
        """Update strategy using evaluated population."""
        population.sort(key=lambda ind: ind.fitness, reverse=True)

        if population[0].fitness > self._best_fitness:
            self._best_fitness = population[0].fitness

        # Select top mu individuals
        top = population[:self.mu]

        # Compute new mean
        old_mean = self.mean.copy()
        self.mean = np.mean([ind.genome for ind in top], axis=0)

        # Update evolution paths
        try:
            L = np.linalg.cholesky(self.C)
            inv_sqrt_C = np.linalg.inv(L).T
        except np.linalg.LinAlgError:
            inv_sqrt_C = np.eye(self.dim, dtype=np.float64)

        diff = (self.mean - old_mean) / self.sigma
        self.p_s = (1.0 - self.c_s) * self.p_s + math.sqrt(self.c_s * (2.0 - self.c_s) * self.mu_eff) * inv_sqrt_C @ diff
        self.p_c = (1.0 - self.c_c) * self.p_c + math.sqrt(self.c_c * (2.0 - self.c_c) * self.mu_eff) * diff

        # Update covariance matrix
        h_s = np.linalg.norm(self.p_s) / math.sqrt(1.0 - (1.0 - self.c_s) ** (2 * (self._generation + 1))) < 1.5 * self.chi
        delta = (1.0 - h_s) * self.c_c * (2.0 - self.c_c)

        rank_one = self.c_1 * np.outer(self.p_c, self.p_c)
        rank_mu = self.c_mu * sum(
            np.outer(ind.genome - old_mean, ind.genome - old_mean) / self.sigma ** 2
            for ind in top
        ) / self.mu

        self.C = (1.0 - self.c_1 - self.c_mu + delta) * self.C + rank_one + rank_mu

        # Step size adaptation
        ps_norm = np.linalg.norm(self.p_s)
        self.sigma *= math.exp((self.c_s / self.d_s) * (ps_norm / self.chi - 1.0))

        # Ensure symmetry
        self.C = (self.C + self.C.T) / 2.0
        self.C += 1e-12 * np.eye(self.dim)

        self._generation += 1

    def optimize(
        self,
        fitness_func: Callable[[np.ndarray], float],
        num_generations: int = 100,
    ) -> Individual:
        """Run CMA-ES optimization."""
        for _ in range(num_generations):
            population = self.ask()
            for ind in population:
                ind.fitness = fitness_func(ind.genome)
            self.tell(population)

        return Individual(genome=self.mean.astype(np.float32), fitness=self._best_fitness)


class MAPElites:
    """MAP-Elites: Quality Diversity search across a behavior space."""

    def __init__(
        self,
        genome_size: int,
        grid_shape: Tuple[int, ...] = (10, 10),
        behavior_dim: int = 2,
        seed: int = 42,
    ):
        self.genome_size = genome_size
        self.grid_shape = grid_shape
        self.behavior_dim = behavior_dim
        self.rng = random.Random(seed)
        self.np_rng = np.random.default_rng(seed)

        # Elite map: genome at each grid cell
        self.elites: Dict[Tuple[int, ...], Individual] = {}

    def _get_cell(self, behavior: np.ndarray) -> Tuple[int, ...]:
        """Get grid cell for a behavior descriptor."""
        normalized = np.clip((behavior + 1.0) / 2.0, 0.0, 0.999)
        cell = tuple(int(normalized[i] * self.grid_shape[i]) for i in range(self.behavior_dim))
        return cell

    def add_genome(
        self,
        genome: np.ndarray,
        fitness: float,
        behavior: np.ndarray,
    ) -> bool:
        """Add a genome to the archive if it improves the cell."""
        cell = self._get_cell(behavior)

        if cell not in self.elites or self.elites[cell].fitness < fitness:
            self.elites[cell] = Individual(genome=genome.copy(), fitness=fitness)
            return True
        return False

    def sample_random(self) -> Individual:
        """Sample random elite from archive."""
        if not self.elites:
            return Individual(genome=self.np_rng.uniform(-1.0, 1.0, self.genome_size))
        return self.rng.choice(list(self.elites.values()))

    def sample_cell(self, cell: Tuple[int, ...]) -> Optional[Individual]:
        return self.elites.get(cell)

    def search(
        self,
        fitness_func: Callable[[np.ndarray], float],
        behavior_func: Callable[[np.ndarray], np.ndarray],
        num_iterations: int = 1000,
        mutation_rate: float = 0.1,
    ) -> Dict[Tuple[int, ...], Individual]:
        """Run MAP-Elites search."""
        for _ in range(num_iterations):
            if self.rng.random() < 0.1 or len(self.elites) == 0:
                genome = self.np_rng.uniform(-1.0, 1.0, self.genome_size)
            else:
                parent = self.sample_random()
                genome = parent.genome.copy()
                mask = self.np_rng.random(self.genome_size) < mutation_rate
                genome[mask] += self.np_rng.normal(0.0, 0.1, mask.sum())

            fitness = fitness_func(genome)
            behavior = behavior_func(genome)
            self.add_genome(genome, fitness, behavior)

        return self.elites


class GeneticProgram:
    """Genetic programming for parameter optimization."""

    def __init__(self, seed: int = 42):
        self.rng = random.Random(seed)
        self.np_rng = np.random.default_rng(seed)

    def create_expression(self, max_depth: int = 3) -> str:
        """Create a random mathematical expression tree (as string)."""
        if max_depth <= 0:
            return f"x{self.rng.randint(0, 10)}"

        if self.rng.random() < 0.3 and max_depth > 1:
            op = self.rng.choice(['sin', 'cos', 'exp', 'log', 'abs'])
            arg = self.create_expression(max_depth - 1)
            return f"{op}({arg})"
        elif self.rng.random() < 0.5:
            op = self.rng.choice(['+', '-', '*'])
            left = self.create_expression(max_depth - 1)
            right = self.create_expression(max_depth - 1)
            return f"({left} {op} {right})"
        else:
            if self.rng.random() < 0.5:
                return f"x{self.rng.randint(0, 10)}"
            else:
                return f"{self.rng.uniform(-2.0, 2.0):.4f}"

    def evaluate_expression(self, expr: str, x: np.ndarray) -> np.ndarray:
        """Evaluate an expression tree on input x."""
        # Safe eval with numpy
        safe_dict = {
            'x0': x[:, 0] if x.ndim > 1 else x,
            'x1': x[:, 1] if x.ndim > 1 and x.shape[1] > 1 else x,
            'x2': x[:, 2] if x.ndim > 1 and x.shape[1] > 2 else x,
            'x3': x[:, 3] if x.ndim > 1 and x.shape[1] > 3 else x,
            'x4': x[:, 4] if x.ndim > 1 and x.shape[1] > 4 else x,
            'sin': np.sin, 'cos': np.cos, 'exp': np.exp,
            'log': lambda z: np.log(np.abs(z) + 1e-8),
            'abs': np.abs, 'sqrt': lambda z: np.sqrt(np.abs(z)),
        }
        try:
            result = eval(expr, {"__builtins__": {}}, safe_dict)
            return np.atleast_1d(np.asarray(result, dtype=np.float32))
        except Exception:
            return np.zeros(x.shape[0] if x.ndim > 1 else 1)

    def crossover_expressions(self, expr_a: str, expr_b: str) -> Tuple[str, str]:
        """Crossover two expression trees."""
        # Simple: swap random subexpressions
        if self.rng.random() < 0.5:
            return expr_a, expr_b
        return expr_b, expr_a

    def mutate_expression(self, expr: str, mutation_rate: float = 0.1) -> str:
        """Mutate an expression."""
        if self.rng.random() < mutation_rate:
            return self.create_expression(self.rng.randint(1, 3))
        return expr


def _dummy_fitness(x: np.ndarray) -> float:
    return -np.linalg.norm(x)


def _dummy_behavior(x: np.ndarray) -> np.ndarray:
    if len(x) >= 2:
        return np.array([x[0], x[1]])
    return np.array([x[0] if len(x) > 0 else 0.0, 0.0])
