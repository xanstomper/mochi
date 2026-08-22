"""Data Recipes — curated dataset recipes from 480B-10T model distillation research."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


# ── Research-backed task banks ───────────────────────────────────────────────

# AIME-style competition math (DeepSeek-R1 style)
MATH_COMPETITION_TASKS = [
    "Find all integer solutions to x³ + y³ = z³ + 1 where 1 ≤ x,y,z ≤ 100.",
    "Prove that for any prime p > 3, p² - 1 is divisible by 24.",
    "A sequence satisfies a(n+1) = a(n)² - 2. If a(1) = 2.5, find the limit of a(n)/2^(2^n).",
    "In triangle ABC, the incircle touches BC at D. If BD = 3, DC = 5, and AB = 7, find AC.",
    "How many permutations of {1,...,10} have no fixed point and no two adjacent elements summing to 11?",
    "Let p(x) be a degree-5 polynomial with integer coefficients and p(0)=p(1)=p(2)=p(3)=p(4)=1. Find p(5).",
    "Find the smallest n such that n! > 10^100.",
    "Prove the AM-GM inequality for n numbers using only algebra.",
    "A fair coin is tossed until 3 consecutive heads appear. Find the expected number of tosses.",
    "Find all functions f: R → R satisfying f(x+y) + f(x-y) = 2f(x)cos(y).",
]

# GSM8K-style word problems
MATH_WORD_TASKS = [
    "A store offers a 20% discount on all items. If John buys 3 shirts at $45 each after discount, how much does he pay in total? He also has a coupon for $10 off orders over $100.",
    "A train travels from city A to city B at 60 mph and returns at 40 mph. What is the average speed for the round trip?",
    "If 8 workers can build a wall in 12 days, how many workers are needed to build the same wall in 6 days?",
    "Maria has twice as many books as Pedro. If Maria gives 15 books to Pedro, they will have the same number. How many books does each have?",
    "A rectangle's perimeter is 56 cm and its area is 192 cm². Find its dimensions.",
]

# HumanEval/Leetcode-style coding tasks
CODE_TASKS = [
    "Implement a thread-safe LRU cache in Python with O(1) get and put operations. Include proper locking.",
    "Write a function to find the longest palindromic substring in O(n) time using Manacher's algorithm.",
    "Implement a distributed rate limiter using Redis with sliding window log approach. Handle edge cases.",
    "Design a data structure that supports insert, delete, and getRandom in O(1) average time.",
    "Write a recursive descent parser for a simple expression language with +, -, *, /, (), and variables.",
    "Implement merge sort on a linked list without using extra space.",
    "Write a function that given a DAG, finds all paths from source to sink and returns them sorted by total weight.",
    "Implement a trie with autocomplete that returns the top-3 most frequent completions.",
    "Write an async Python function to fetch URLs in parallel with rate limiting and retry logic.",
    "Implement the Fisher-Yates shuffle and prove it produces a uniform distribution.",
]

# Scientific reasoning
SCIENCE_TASKS = [
    "Explain the mechanism of CRISPR-Cas9 gene editing and its limitations for in vivo applications.",
    "Derive the Schrödinger equation from first principles and explain the physical meaning of the wavefunction.",
    "Why does increasing pressure increase the boiling point of a liquid? Explain using thermodynamic principles.",
    "Explain how transformer attention mechanisms differ from recurrent neural networks for long sequences.",
    "What causes superconductivity and why does it occur only at low temperatures for most materials?",
]

# Multi-step reasoning
REASONING_TASKS = [
    "All cats are mammals. Some mammals can fly. Can we conclude that some cats can fly? Justify rigorously.",
    "A red box contains a blue box which contains a yellow box. If you shake the red box, what happens to the yellow box?",
    "Three friends each make a statement: Alice: 'I am lying'. Bob: 'Alice is telling the truth'. Carol: 'Bob is lying'. Who is telling the truth?",
    "You have 12 identical-looking coins, one of which is counterfeit (could be heavier or lighter). Find the counterfeit coin in 3 weighings on a balance scale.",
    "A snail is at the bottom of a 10m well. Each day it climbs 3m, each night it slides back 2m. How many days to escape?",
]

# Architecture/system design
ARCHITECTURE_TASKS = [
    "Design a globally distributed key-value store that handles 1M requests/second with 99.9% availability.",
    "How would you design a real-time collaborative text editor like Google Docs? Address conflict resolution.",
    "Design the data model and API for a social media feed that personalizes content for 1B users.",
    "Architect a machine learning platform that supports training, serving, and monitoring at petabyte scale.",
    "How would you migrate a monolithic e-commerce application to microservices without downtime?",
]

# Security/debugging
SECURITY_TASKS = [
    "Explain SQL injection in depth and demonstrate both the vulnerability and parameterized query mitigation.",
    "A web app has this code: `eval(request.args.get('code'))`. What are all the security implications?",
    "Explain the difference between authentication and authorization. Give examples of failures for each.",
    "How does a timing side-channel attack work? Give a concrete example with code.",
    "What makes AES-GCM secure and what conditions can break its security guarantees?",
]


# ── Recipe definitions ────────────────────────────────────────────────────────

@dataclass
class DataRecipe:
    """A curated data recipe for distillation."""
    name: str
    description: str
    task_bank: List[str]
    recommended_teacher: str = "claude-opus-4-8"
    recommended_provider: str = "anthropic"
    n_samples_per_task: int = 8
    temperature: float = 0.9
    max_tokens: int = 8192
    min_quality: float = 0.6
    difficulty_filter: str = "medium_hard"
    expected_size: str = "1K-10K samples"
    use_case: str = "general reasoning"
    references: List[str] = field(default_factory=list)


def deepseek_r1_recipe(
    n_tasks: int = 1000,
    temperature: float = 0.9,
) -> DataRecipe:
    """
    DeepSeek-R1 style recipe: cold-start SFT → RL-aligned traces.

    Reference: arxiv.org/abs/2501.12948
    Technique: Sample long chain-of-thought traces from powerful teacher,
    SFT student on traces, then apply GRPO/PPO for RL alignment.

    Best for: Mathematical reasoning, multi-step logic
    Student target: 7B-70B dense models
    Expected cost: ~$50-500 for 1K tasks from Claude Opus
    """
    # Mix competition math + word problems
    tasks = (MATH_COMPETITION_TASKS * (n_tasks // 15 + 1) +
             MATH_WORD_TASKS * (n_tasks // 10 + 1))[:n_tasks]

    return DataRecipe(
        name="deepseek_r1",
        description=(
            "Long chain-of-thought distillation for mathematical reasoning. "
            "Mimics DeepSeek-R1's training data pipeline: collect reasoning traces "
            "from powerful teacher, SFT student, then RL alignment."
        ),
        task_bank=tasks,
        recommended_teacher="claude-opus-4-8",
        recommended_provider="anthropic",
        n_samples_per_task=8,
        temperature=0.9,
        max_tokens=12000,  # long CoT
        min_quality=0.65,
        difficulty_filter="hard",
        expected_size="8K-80K samples from 1K tasks",
        use_case="Mathematical reasoning, step-by-step problem solving",
        references=[
            "https://arxiv.org/abs/2501.12948",  # DeepSeek-R1
            "https://arxiv.org/abs/2601.09088",  # Distribution-Aligned Seq Distillation
        ],
    )


def openthoughts_recipe(
    n_tasks: int = 1000,
    temperature: float = 0.9,
) -> DataRecipe:
    """
    OpenThoughts style recipe: diverse sources + high-quality teacher traces.

    Reference: arxiv.org/pdf/2506.04178
    Technique: Collect from 16 diverse problem sources, pair each with
    reasoning trace + solution from powerful teacher. Filter for diversity.

    Best for: General reasoning across domains
    Student target: 7B-32B models
    Expected cost: ~$100-1000 for 10K diverse tasks
    """
    tasks = (
        MATH_COMPETITION_TASKS +
        MATH_WORD_TASKS +
        CODE_TASKS +
        SCIENCE_TASKS +
        REASONING_TASKS +
        ARCHITECTURE_TASKS
    )
    # Repeat to hit n_tasks
    factor = max(1, n_tasks // len(tasks) + 1)
    tasks = (tasks * factor)[:n_tasks]

    return DataRecipe(
        name="openthoughts",
        description=(
            "Diverse multi-domain reasoning dataset. "
            "Collects from 16+ problem sources (math, code, science, logic). "
            "Uses teacher reasoning traces for rich supervision signal."
        ),
        task_bank=tasks,
        recommended_teacher="claude-sonnet-5",
        recommended_provider="anthropic",
        n_samples_per_task=4,
        temperature=0.85,
        max_tokens=8192,
        min_quality=0.55,
        difficulty_filter="medium_hard",
        expected_size="4K-40K samples from 1K tasks",
        use_case="General-purpose reasoning, diverse task types",
        references=[
            "https://arxiv.org/pdf/2506.04178",  # OpenThoughts
            "https://arxiv.org/abs/2501.12948",  # DeepSeek-R1
        ],
    )


def s1k_recipe(
    n_tasks: int = 1000,
    temperature: float = 0.6,
) -> DataRecipe:
    """
    S1k style recipe: 1K curated hard problems, maximum quality.

    Reference: Muennighoff et al. 2025
    Technique: Curate only the hardest 1K problems. One high-quality
    trace per problem. Filter aggressively for diversity and difficulty.
    Budget forcing: push model to think longer before answering.

    Best for: Extreme difficulty reasoning tasks
    Student target: 32B-70B models
    Expected cost: ~$10-50 for 1K problems from DeepSeek
    """
    # Only the hardest tasks
    tasks = (MATH_COMPETITION_TASKS + ARCHITECTURE_TASKS + CODE_TASKS[:5])[:n_tasks]

    return DataRecipe(
        name="s1k",
        description=(
            "1K curated extreme-difficulty problems with maximum-quality traces. "
            "Only the hardest problems, single high-quality response per problem. "
            "Budget forcing ensures deep thinking before answer."
        ),
        task_bank=tasks,
        recommended_teacher="claude-opus-4-8",
        recommended_provider="anthropic",
        n_samples_per_task=1,  # one perfect trace per problem
        temperature=0.3,       # low temp for consistency
        max_tokens=16000,      # maximum thinking budget
        min_quality=0.80,      # only the best
        difficulty_filter="hard",
        expected_size="1K samples (curated)",
        use_case="Frontier-quality mathematical and logical reasoning",
        references=[
            "https://arxiv.org/abs/2501.12948",
        ],
    )


def math_reasoning_recipe(
    n_tasks: int = 5000,
    temperature: float = 0.9,
) -> DataRecipe:
    """
    Pure mathematical reasoning recipe.
    Competition math + word problems + proofs.
    """
    tasks = (
        MATH_COMPETITION_TASKS * (n_tasks // 15 + 1) +
        MATH_WORD_TASKS * (n_tasks // 5 + 1)
    )[:n_tasks]

    return DataRecipe(
        name="math_reasoning",
        description="Pure mathematical reasoning: competition problems, word problems, proofs.",
        task_bank=tasks,
        recommended_teacher="deepseek-r1",
        recommended_provider="deepseek",
        n_samples_per_task=8,
        temperature=0.9,
        max_tokens=8192,
        min_quality=0.6,
        difficulty_filter="medium_hard",
        expected_size="40K samples from 5K tasks",
        use_case="Math-specific reasoning",
    )


def code_recipe(
    n_tasks: int = 5000,
    temperature: float = 0.8,
) -> DataRecipe:
    """
    Code generation and debugging recipe.
    HumanEval + LeetCode + real engineering problems.
    """
    tasks = (CODE_TASKS * (n_tasks // len(CODE_TASKS) + 1))[:n_tasks]

    return DataRecipe(
        name="code",
        description="Code generation, debugging, and system design problems.",
        task_bank=tasks,
        recommended_teacher="claude-sonnet-5",
        recommended_provider="anthropic",
        n_samples_per_task=6,
        temperature=0.8,
        max_tokens=8192,
        min_quality=0.6,
        difficulty_filter="medium_hard",
        expected_size="30K samples from 5K tasks",
        use_case="Code generation and software engineering",
    )


def general_recipe(
    n_tasks: int = 10000,
    temperature: float = 0.9,
) -> DataRecipe:
    """
    General-purpose recipe: all domains, balanced difficulty.
    Best for training a versatile assistant model.
    """
    all_tasks = (
        MATH_COMPETITION_TASKS +
        MATH_WORD_TASKS +
        CODE_TASKS +
        SCIENCE_TASKS +
        REASONING_TASKS +
        ARCHITECTURE_TASKS +
        SECURITY_TASKS
    )
    factor = max(1, n_tasks // len(all_tasks) + 1)
    tasks = (all_tasks * factor)[:n_tasks]

    return DataRecipe(
        name="general",
        description="Balanced mix across all domains. Best for general assistant training.",
        task_bank=tasks,
        recommended_teacher="claude-sonnet-5",
        recommended_provider="anthropic",
        n_samples_per_task=4,
        temperature=0.9,
        max_tokens=6000,
        min_quality=0.5,
        difficulty_filter="medium_hard",
        expected_size="40K samples from 10K tasks",
        use_case="General-purpose assistant model training",
    )


def security_recipe(
    n_tasks: int = 2000,
    temperature: float = 0.7,
) -> DataRecipe:
    """Security and adversarial reasoning recipe."""
    tasks = (SECURITY_TASKS * (n_tasks // len(SECURITY_TASKS) + 1))[:n_tasks]

    return DataRecipe(
        name="security",
        description="Security reasoning, vulnerability analysis, defensive coding.",
        task_bank=tasks,
        recommended_teacher="claude-opus-4-8",
        recommended_provider="anthropic",
        n_samples_per_task=4,
        temperature=0.7,
        max_tokens=6000,
        min_quality=0.65,
        difficulty_filter="medium_hard",
        expected_size="8K samples",
        use_case="Security-aware AI assistant",
    )


# ── Frontier model recipes (480B-10T teacher scale) ──────────────────────────

def deepseek_r1_671b_recipe(n_tasks: int = 1000) -> "DataRecipe":
    """
    DeepSeek-R1-671B MoE teacher recipe.

    Reproduces the official DeepSeek-R1 distillation pipeline:
    - 671B MoE (37B active) — best open reasoning model as of 2025
    - Generates long chain-of-thought traces (avg 2K-8K tokens)
    - ~$0.55/1M input + $2.19/1M output — very cost-efficient vs Claude
    - 800K scale: ~$800 (cf. DeepSeek's actual run)

    Ref: arXiv:2501.12948 — DeepSeek-R1: Incentivizing Reasoning via RL
    """
    from .mass_distillation import DOMAIN_TASK_SEEDS
    task_bank = []
    for domain in ["math_competition", "math_reasoning", "coding",
                   "logic_reasoning", "science_reasoning"]:
        task_bank.extend(DOMAIN_TASK_SEEDS.get(domain, []))
    # Pad to n_tasks with duplicates if needed
    while len(task_bank) < n_tasks:
        task_bank = task_bank * 2
    return DataRecipe(
        name="DeepSeek-R1-671B Mass Distillation",
        description=(
            "Distill the DeepSeek-R1-671B MoE teacher (37B active params) "
            "using rejection sampling. Reproduces the paper's pipeline: "
            "600K CoT reasoning + 200K instruction samples → 800K total. "
            "Students: Qwen2.5 or Llama3 7B-70B fine-tuned for 2 epochs."
        ),
        task_bank=task_bank[:n_tasks],
        recommended_teacher="deepseek-reasoner",
        recommended_provider="deepseek",
        n_samples_per_task=8,
        temperature=0.6,
        max_tokens=16384,
        min_quality=0.55,
        difficulty_filter="all",
        expected_size=f"{n_tasks * 8:,} samples (target: 800K for full run)",
        use_case=(
            "Reasoning-capable student models (math, code, logic). "
            "State-of-the-art open-source distillation as of 2025."
        ),
        references=["https://arxiv.org/abs/2501.12948"],
    )


def gemini_25_pro_recipe(n_tasks: int = 500) -> "DataRecipe":
    """
    Gemini 2.5 Pro teacher recipe with native thinking mode.

    - Strong performance on STEM, code, and multimodal reasoning
    - Native thinking mode (thinkingBudget tokens)
    - Cost-effective at $1.25/1M input + $5/1M output
    - Best for: scientific reasoning, complex analysis
    """
    from .mass_distillation import DOMAIN_TASK_SEEDS
    task_bank = []
    for domain in ["science_reasoning", "math_reasoning", "coding",
                   "analysis", "architecture"]:
        task_bank.extend(DOMAIN_TASK_SEEDS.get(domain, []))
    while len(task_bank) < n_tasks:
        task_bank = task_bank * 2
    return DataRecipe(
        name="Gemini 2.5 Pro Distillation",
        description=(
            "Distill Gemini 2.5 Pro with extended thinking mode enabled. "
            "Captures step-by-step reasoning traces in thinkingParts. "
            "Best for scientific reasoning, STEM, and complex analysis tasks."
        ),
        task_bank=task_bank[:n_tasks],
        recommended_teacher="gemini-2.5-pro",
        recommended_provider="google",
        n_samples_per_task=4,
        temperature=0.7,
        max_tokens=8192,
        min_quality=0.58,
        difficulty_filter="medium_hard",
        expected_size=f"{n_tasks * 4:,} samples",
        use_case="Scientific reasoning, STEM education, analytical tasks",
        references=["https://arxiv.org/abs/2505.09388"],
    )


def qwen3_moe_recipe(n_tasks: int = 1000) -> "DataRecipe":
    """
    Qwen3-235B-A22B MoE teacher recipe via Together AI.

    - 235B total params, 22B active (MoE architecture)
    - Strong multilingual + reasoning capabilities
    - Supports thinking mode (extended CoT)
    - Accessible via Together AI at competitive pricing
    - Best for: multilingual, general reasoning, code
    """
    from .mass_distillation import DOMAIN_TASK_SEEDS
    task_bank = []
    for domain in ["math_reasoning", "coding", "logic_reasoning",
                   "instruction_following", "analysis"]:
        task_bank.extend(DOMAIN_TASK_SEEDS.get(domain, []))
    while len(task_bank) < n_tasks:
        task_bank = task_bank * 2
    return DataRecipe(
        name="Qwen3-235B-A22B MoE Distillation",
        description=(
            "Distill Qwen3-235B-A22B (22B active MoE) via Together AI. "
            "Captures thinking traces. Strong multilingual + reasoning. "
            "DASD-style temperature scheduling: low→high→mixed stages."
        ),
        task_bank=task_bank[:n_tasks],
        recommended_teacher="Qwen/Qwen3-235B-A22B",
        recommended_provider="together",
        n_samples_per_task=6,
        temperature=0.7,
        max_tokens=8192,
        min_quality=0.55,
        difficulty_filter="all",
        expected_size=f"{n_tasks * 6:,} samples",
        use_case="Multilingual models, general reasoning, instruction-following",
        references=[
            "https://arxiv.org/abs/2505.09388",
            "https://arxiv.org/abs/2601.09088",
        ],
    )


def llama4_maverick_recipe(n_tasks: int = 1000) -> "DataRecipe":
    """
    Llama 4 Maverick (MoE) teacher recipe via Together AI.

    - 17B active params, 128 experts (MoE)
    - Meta's best open-source model (April 2025)
    - Very fast inference via Together AI
    - Best for: instruction-following, coding, general tasks
    """
    from .mass_distillation import DOMAIN_TASK_SEEDS
    task_bank = []
    for domain in ["coding", "instruction_following", "math_reasoning",
                   "architecture", "analysis"]:
        task_bank.extend(DOMAIN_TASK_SEEDS.get(domain, []))
    while len(task_bank) < n_tasks:
        task_bank = task_bank * 2
    return DataRecipe(
        name="Llama 4 Maverick MoE Distillation",
        description=(
            "Distill Llama 4 Maverick (128 experts, 17B active) via Together AI. "
            "Excellent for instruction-following and code generation. "
            "Very cost-effective at ~$0.27/1M input tokens."
        ),
        task_bank=task_bank[:n_tasks],
        recommended_teacher="meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        recommended_provider="together",
        n_samples_per_task=6,
        temperature=0.8,
        max_tokens=8192,
        min_quality=0.50,
        difficulty_filter="medium_hard",
        expected_size=f"{n_tasks * 6:,} samples",
        use_case="General-purpose assistants, code generation, instruction-following",
        references=["https://ai.meta.com/blog/llama-4-multimodal-intelligence/"],
    )


def dasd_4b_recipe(n_tasks: int = 800) -> "DataRecipe":
    """
    DASD-style recipe (Distribution-Aligned Sequence Distillation).

    Reproduces arXiv:2601.09088 pipeline:
    - Multi-stage temperature scheduling: 0.3 → 0.9 → 0.6
    - 448K samples → SOTA 4B student (88.5 AIME24, 69.3 LiveCodeBench v5)
    - Teacher: gpt-oss-120b or DeepSeek-R1
    - Student target: Qwen3-4B or similar small model

    Use this recipe when targeting sub-7B student models.
    """
    from .mass_distillation import DOMAIN_TASK_SEEDS
    task_bank = []
    for domain in ["math_competition", "coding", "science_reasoning",
                   "logic_reasoning"]:
        task_bank.extend(DOMAIN_TASK_SEEDS.get(domain, []))
    while len(task_bank) < n_tasks:
        task_bank = task_bank * 2
    return DataRecipe(
        name="DASD Distribution-Aligned Distillation",
        description=(
            "Distribution-Aligned Sequence Distillation (arXiv:2601.09088). "
            "3-stage temperature schedule: low (0.3) → high (0.9) → mixed (0.6). "
            "Produces 88.5 AIME24 on 4B student with just 448K samples. "
            "Use with MassDistillationOrchestrator for automatic scheduling."
        ),
        task_bank=task_bank[:n_tasks],
        recommended_teacher="deepseek-reasoner",
        recommended_provider="deepseek",
        n_samples_per_task=6,
        temperature=0.6,        # mean across DASD stages
        max_tokens=16384,
        min_quality=0.55,
        difficulty_filter="all",
        expected_size=f"{n_tasks * 6:,} samples (scale to 448K for paper results)",
        use_case=(
            "Small model (1B-7B) reasoning distillation. "
            "Best cost/performance ratio for math+code student models."
        ),
        references=[
            "https://arxiv.org/abs/2601.09088",
            "https://arxiv.org/abs/2501.12948",
        ],
    )


def claude_opus_frontier_recipe(n_tasks: int = 500) -> "DataRecipe":
    """
    Claude Opus 4.8 frontier recipe with extended thinking.

    - Highest quality teacher (extended thinking up to 32K tokens)
    - Best for: hard reasoning, constitutional AI, nuanced judgment
    - More expensive but produces highest-quality distillation data
    - Ideal for: 7B-34B student models targeting GPQA, MMLU-Pro, etc.
    """
    from .mass_distillation import DOMAIN_TASK_SEEDS
    task_bank = []
    for domain in ["math_competition", "logic_reasoning", "science_reasoning",
                   "security", "architecture", "analysis"]:
        task_bank.extend(DOMAIN_TASK_SEEDS.get(domain, []))
    while len(task_bank) < n_tasks:
        task_bank = task_bank * 2
    return DataRecipe(
        name="Claude Opus 4.8 Frontier Distillation",
        description=(
            "Distill Claude Opus 4.8 with extended thinking (up to 32K think tokens). "
            "Highest quality teacher for hard reasoning tasks. "
            "Captures full thinking traces for deep CoT distillation. "
            "Target: 7B-34B students for GPQA-Diamond, MMLU-Pro, LiveCodeBench."
        ),
        task_bank=task_bank[:n_tasks],
        recommended_teacher="claude-opus-4-8",
        recommended_provider="anthropic",
        n_samples_per_task=4,
        temperature=0.7,
        max_tokens=8192,
        min_quality=0.65,
        difficulty_filter="hard",
        expected_size=f"{n_tasks * 4:,} samples (premium quality)",
        use_case=(
            "Highest-quality reasoning distillation. "
            "Best for GPQA, hard math, security research, constitutional AI."
        ),
        references=["https://www.anthropic.com/claude/opus"],
    )


# ── Cost estimation table ─────────────────────────────────────────────────────

COST_ESTIMATES = {
    # Legacy estimates
    "1K tasks × 8 samples (Claude Opus)":      {"calls": 8_000,     "est_cost_usd": 160.0},
    "10K tasks × 4 samples (Claude Sonnet)":   {"calls": 40_000,    "est_cost_usd": 120.0},
    "100K tasks × 4 samples (Claude Haiku)":   {"calls": 400_000,   "est_cost_usd": 320.0},
    # DeepSeek-R1 (paper scale)
    "1K tasks × 8 samples (DeepSeek-R1)":      {"calls": 8_000,     "est_cost_usd": 8.0},
    "10K tasks × 8 samples (DeepSeek-R1)":     {"calls": 80_000,    "est_cost_usd": 80.0},
    "100K tasks × 8 samples (DeepSeek-R1)":    {"calls": 800_000,   "est_cost_usd": 800.0},
    "1M tasks × 8 samples (DeepSeek-R1) — paper scale": {
        "calls": 8_000_000, "est_cost_usd": 8_000.0},
    # DeepSeek-V3 (cheaper dense)
    "100K tasks × 4 samples (DeepSeek-V3)":    {"calls": 400_000,   "est_cost_usd": 44.0},
    # Gemini
    "1M tasks × 1 sample (Gemini Flash)":      {"calls": 1_000_000, "est_cost_usd": 80.0},
    "100K tasks × 4 samples (Gemini 2.5 Pro)": {"calls": 400_000,   "est_cost_usd": 500.0},
    # Together AI (MoE teachers)
    "10K tasks × 6 samples (Llama4 Maverick)": {"calls": 60_000,    "est_cost_usd": 16.0},
    "10K tasks × 6 samples (Qwen3-235B-A22B)": {"calls": 60_000,    "est_cost_usd": 30.0},
    # DASD target
    "75K tasks × 6 samples (DASD 448K)":       {"calls": 450_000,   "est_cost_usd": 450.0},
}

RECOMMENDED_STUDENT_SIZES = {
    "1K samples":    "1B-3B models (proof of concept)",
    "10K samples":   "3B-7B models (lightweight)",
    "100K samples":  "7B-13B models (capable)",
    "1M samples":    "13B-34B models (strong)",
    "10M samples":   "34B-70B models (frontier-capable)",
    "100M samples":  "70B+ or MoE models (near-teacher quality)",
}


def get_all_recipes() -> Dict[str, DataRecipe]:
    """Return all available recipes, including frontier teacher models."""
    return {
        # ── Classic/reference recipes ──────────────────────────────────────
        "deepseek_r1": deepseek_r1_recipe(),
        "openthoughts": openthoughts_recipe(),
        "s1k": s1k_recipe(),
        "math_reasoning": math_reasoning_recipe(),
        "code": code_recipe(),
        "general": general_recipe(),
        "security": security_recipe(),
        # ── Frontier / paper-scale recipes (new 2025) ─────────────────────
        "deepseek_r1_671b": deepseek_r1_671b_recipe(),   # paper: 800K scale
        "gemini_25_pro": gemini_25_pro_recipe(),           # Gemini with thinking
        "qwen3_moe": qwen3_moe_recipe(),                   # Qwen3-235B-A22B
        "llama4_maverick": llama4_maverick_recipe(),       # Meta MoE, cheap
        "dasd_4b": dasd_4b_recipe(),                       # DASD 3-stage schedule
        "claude_opus_frontier": claude_opus_frontier_recipe(),  # highest quality
    }


def print_recipe_summary():
    """Print a summary of all recipes."""
    recipes = get_all_recipes()
    print("\n" + "="*70)
    print("  LAZY CHAMELEON DISTILLATION RECIPES")
    print("="*70)
    for name, r in recipes.items():
        print(f"\n{'─'*60}")
        print(f"  {r.name.upper()}")
        print(f"  {r.description}")
        print(f"  Teacher: {r.recommended_provider}/{r.recommended_teacher}")
        print(f"  Tasks: {len(r.task_bank)}, n_samples={r.n_samples_per_task}")
        print(f"  Expected output: {r.expected_size}")
        print(f"  Use case: {r.use_case}")
        if r.references:
            print(f"  References: {r.references[0]}")

    print("\n" + "="*70)
    print("  COST ESTIMATES")
    print("="*70)
    for scenario, est in COST_ESTIMATES.items():
        print(f"  {scenario}: ~${est['est_cost_usd']:.2f} ({est['calls']:,} calls)")

    print("\n" + "="*70)
    print("  RECOMMENDED DATASET SIZES BY STUDENT MODEL")
    print("="*70)
    for size, rec in RECOMMENDED_STUDENT_SIZES.items():
        print(f"  {size:15s} → {rec}")
    print()


if __name__ == "__main__":
    print_recipe_summary()
