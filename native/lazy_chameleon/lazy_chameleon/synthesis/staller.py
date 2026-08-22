"""
Test-time compute stalling engine for inference quality improvement.

Implements 6 real strategies that genuinely improve output quality through
additional thinking and processing at inference time:
1. Self-Consistency: Generate multiple diverse responses and pick best
2. Chain-of-Draft: Iterative refinement with critique-revise loops
3. Constitutional: Check against reasoning principles and fix violations
4. Budget-Force: Force minimum thinking token budget
5. Devils-Advocate: Adversarial critique and integration
6. Decomposer: Break into sub-tasks and synthesize

Key insight: Test-time compute scaling works—more thinking = better outputs.
"""

import re
import time
import asyncio
from dataclasses import dataclass, field
from typing import Callable, Optional, List, Dict, Tuple, Any
from enum import Enum
import statistics


@dataclass
class StallConfig:
    """Configuration for test-time stalling strategies."""
    
    strategy: str = "auto"  # auto, self_consistency, chain_of_draft, constitutional, budget_force, devils_advocate, decompose
    n_samples: int = 5  # For self_consistency: number of parallel samples
    max_iterations: int = 4  # For chain_of_draft, constitutional: refinement iterations
    min_thinking_tokens: int = 800  # For budget_force: minimum thinking tokens
    temperature_range: Tuple[float, float] = (0.3, 0.9)  # Range for temperature sampling
    convergence_threshold: float = 0.15  # Stop if improvement < this
    time_budget_seconds: float = 120.0  # Max total time for stalling
    verbose: bool = False  # Log reasoning traces
    
    def __post_init__(self):
        if self.strategy not in ["auto", "self_consistency", "chain_of_draft", "constitutional", 
                                  "budget_force", "devils_advocate", "decompose"]:
            raise ValueError(f"Unknown strategy: {self.strategy}")
        if not (0 < self.convergence_threshold < 1):
            raise ValueError("convergence_threshold must be in (0, 1)")


@dataclass
class StallResult:
    """Result from a stalling operation."""

    # ── new test-facing fields (tests use these) ────────────────────────────
    strategy: str = ""          # alias: which strategy was used
    content: str = ""           # alias: the final output text
    tokens_saved: int = 0       # tokens saved vs no-stall baseline
    confidence: float = 1.0     # confidence score [0.0, 1.0]
    passes: int = 1             # number of stall passes performed

    # ── original fields (kept for backward compat) ──────────────────────────
    final_output: str = ""      # same as content
    strategy_used: str = ""     # same as strategy
    iterations: int = 1
    samples_generated: int = 1
    quality_improvement: float = 0.0
    reasoning_trace: List[str] = field(default_factory=list)
    tokens_used: int = 0
    time_taken: float = 0.0

    def __post_init__(self):
        # Keep aliases in sync
        if self.final_output and not self.content:
            self.content = self.final_output
        if self.content and not self.final_output:
            self.final_output = self.content
        if self.strategy_used and not self.strategy:
            self.strategy = self.strategy_used
        if self.strategy and not self.strategy_used:
            self.strategy_used = self.strategy


class SelfConsistency:
    """
    Generate N diverse responses at varying temperatures and select the best.
    
    For factual/extractable answers: majority vote.
    For open-ended: quality-score and select highest.
    
    This strategy leverages the fact that more diverse samples reveal robust answers.
    """
    
    def __init__(self, api_fn: Callable, config: StallConfig):
        self.api_fn = api_fn
        self.config = config
        self.traces = []
    
    def _extract_answer(self, text: str) -> Optional[str]:
        """Extract final answer using regex patterns for common formats."""
        # Try: "Final answer: <answer>"
        match = re.search(r'(?:final answer|answer)[:\s]+([^\n]+?)(?:\n|$)', text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
        
        # Try: "The answer is <answer>"
        match = re.search(r'(?:the answer is|answer is)[:\s]+([^\n]+?)(?:\n|$)', text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
        
        # Try boxed format: \boxed{answer}
        match = re.search(r'\\boxed\{([^}]+)\}', text)
        if match:
            return match.group(1).strip()
        
        # Try markdown code block
        match = re.search(r'```(?:python|javascript|java|cpp)?\n(.*?)```', text, re.DOTALL)
        if match:
            return match.group(1).strip()
        
        return None
    
    def _quality_score(self, text: str) -> float:
        """Score response quality on 5 dimensions [0, 1]."""
        if not text or len(text) < 10:
            return 0.0
        
        scores = []
        
        # 1. Length (reasonable: 50-2000 chars is good)
        text_len = len(text)
        length_score = min(1.0, text_len / 500) if text_len < 500 else min(1.0, 2000 / text_len)
        scores.append(length_score)
        
        # 2. Structure (presence of clear reasoning markers)
        structure_indicators = [
            "therefore", "because", "step", "first", "second", "next",
            "thus", "hence", "conclusion", "analysis", "reasoning", "note"
        ]
        structure_score = min(1.0, sum(1 for ind in structure_indicators if ind in text.lower()) / 3)
        scores.append(structure_score)
        
        # 3. Specificity (concrete details, numbers, examples)
        specificity_score = min(1.0, (
            len(re.findall(r'\d+', text)) / 5 +  # Numbers
            len(re.findall(r'[A-Z]{2,}', text)) / 5 +  # Acronyms/proper nouns
            (text.count('"') + text.count("'")) / 10  # Quotes
        ) / 3)
        scores.append(specificity_score)
        
        # 4. Reasoning depth (uses multiple reasoning modes)
        reasoning_score = min(1.0, (
            (1 if any(x in text.lower() for x in ["algorithm", "approach", "method"]) else 0) +
            (1 if any(x in text.lower() for x in ["evidence", "proof", "example"]) else 0) +
            (1 if any(x in text.lower() for x in ["consider", "might", "could", "alternative"]) else 0)
        ) / 3)
        scores.append(reasoning_score)
        
        # 5. Completeness (addresses question, has conclusion)
        completeness_score = min(1.0, (
            (1 if len(text) > 100 else 0) +
            (1 if any(x in text.lower() for x in ["conclusion", "summary", "overall", "finally"]) else 0) +
            (1 if re.search(r'[.!?]$', text.strip()) else 0)  # Ends with punctuation
        ) / 3)
        scores.append(completeness_score)
        
        return statistics.mean(scores)
    
    def _majority_vote(self, answers: List[str]) -> str:
        """Select most common answer."""
        if not answers:
            return ""
        
        # Count occurrences (normalize by removing punctuation/whitespace)
        normalized = {}
        for ans in answers:
            norm = re.sub(r'[^\w\s]', '', ans).lower().strip()
            if norm:
                normalized[norm] = normalized.get(norm, 0) + 1
        
        if not normalized:
            return answers[0]
        
        return max(normalized.items(), key=lambda x: x[1])[0]
    
    async def run(self, task: str, context: str = "") -> Tuple[str, List[str]]:
        """Run self-consistency strategy."""
        system_prompt = """You are a world-class reasoning AI assistant. Provide clear, detailed, and accurate responses. 
When solving problems, show your work step-by-step. For factual questions, be precise and cite your reasoning.
Focus on clarity and correctness above all else."""
        
        prompt = f"{context}\n\nTask: {task}".strip()
        
        # Generate samples at different temperatures
        temperatures = [
            self.config.temperature_range[0] + (self.config.temperature_range[1] - self.config.temperature_range[0]) * (i / (self.config.n_samples - 1))
            for i in range(self.config.n_samples)
        ]
        
        samples = []
        traces = []
        
        for i, temp in enumerate(temperatures):
            try:
                response = self.api_fn(
                    prompt=prompt,
                    system=system_prompt,
                    temperature=temp,
                    max_tokens=2048
                )
                samples.append(response)
                traces.append(f"Sample {i+1} (T={temp:.2f}): Generated {len(response.split())} words")
                
                if self.config.verbose:
                    print(f"  Sample {i+1} @ T={temp:.2f}: {len(response)} chars")
            except Exception as e:
                traces.append(f"Sample {i+1} (T={temp:.2f}): ERROR - {str(e)}")
                if self.config.verbose:
                    print(f"  Sample {i+1} failed: {e}")
        
        if not samples:
            return "", traces
        
        # Try to extract answers (for factual tasks)
        extracted = [self._extract_answer(s) for s in samples]
        extracted_valid = [e for e in extracted if e]
        
        if extracted_valid and len(extracted_valid) >= len(samples) * 0.6:  # If most have extractable answers
            best_answer = self._majority_vote(extracted_valid)
            traces.append(f"Used answer extraction and majority voting: '{best_answer}'")
            return best_answer, traces
        
        # Otherwise, quality score and pick best
        scores = [(i, self._quality_score(s)) for i, s in enumerate(samples)]
        best_idx = max(scores, key=lambda x: x[1])[0]
        best_response = samples[best_idx]
        
        traces.append(f"Quality scores: {[f'{s:.2f}' for _, s in scores]}")
        traces.append(f"Selected sample {best_idx + 1} with quality score {scores[best_idx][1]:.3f}")
        
        return best_response, traces


class ChainOfDraft:
    """
    Iterative refinement through draft-critique-revise cycles.
    
    Each iteration: generate draft → get critique → revise → check convergence.
    Converges when improvement falls below threshold or max iterations reached.
    """
    
    CRITIQUE_PROMPT = """You are an expert editor and critical reviewer. Your task is to provide specific, actionable critique of the following response.

Focus on:
1. LOGICAL CONSISTENCY: Are all claims coherent? Are there contradictions?
2. COMPLETENESS: Does it address all parts of the question? Are there gaps?
3. ACCURACY: Are factual claims correct? Are there misconceptions?
4. CLARITY: Is the writing clear and well-organized? Are there confusing sections?
5. DEPTH: Is the reasoning detailed enough? Could it go deeper?
6. EVIDENCE: Are claims supported with examples, reasoning, or evidence?

Provide 2-4 specific critiques. For each, state:
- What the issue is
- Why it matters
- How to fix it

Be constructive but rigorous. The goal is to make this response significantly better."""

    REVISION_PROMPT = """Based on the critique provided, revise the original response to address the identified issues.

Original response:
{original}

Critique:
{critique}

Instructions:
- Incorporate the feedback specifically
- Maintain what was good about the original
- Make the response more complete, clear, and well-reasoned
- Ensure internal consistency
- Expand with more detail where needed
- Do NOT just repeat the original with minor changes

Provide the REVISED response in full."""

    def __init__(self, api_fn: Callable, config: StallConfig):
        self.api_fn = api_fn
        self.config = config
    
    def _quality_score(self, text: str) -> float:
        """Estimate quality (0-1)."""
        if not text:
            return 0.0
        
        score = 0.0
        score += min(1.0, len(text.split()) / 200)  # Word count
        score += (1.0 if len(text.split()) > 50 else 0.0)  # Minimum length
        score += (1.0 if sum(1 for p in text.split('.') if len(p.split()) > 5) > 3 else 0.0)  # Complex sentences
        
        # Reasoning markers
        markers = ["because", "therefore", "analysis", "consider", "reasoning", "however", "although"]
        score += min(1.0, sum(1 for m in markers if m in text.lower()) / 3)
        
        return min(1.0, score / 4)
    
    async def run(self, task: str, context: str = "") -> Tuple[str, List[str]]:
        """Run chain-of-draft strategy."""
        system_prompt = """You are a master problem-solver and technical writer. Provide comprehensive, well-structured responses.
Your answers should be thorough, logically sound, and clearly explained."""
        
        prompt = f"{context}\n\n{task}".strip()
        
        traces = []
        
        # Step 1: Initial draft
        try:
            draft = self.api_fn(
                prompt=prompt,
                system=system_prompt,
                temperature=0.5,
                max_tokens=2048
            )
            traces.append(f"Initial draft: {len(draft.split())} words, quality={self._quality_score(draft):.3f}")
        except Exception as e:
            return "", [f"Initial draft failed: {e}"]
        
        current = draft
        prev_score = self._quality_score(draft)
        
        # Iterative refinement loop
        for iteration in range(self.config.max_iterations - 1):
            # Get critique
            try:
                critique = self.api_fn(
                    prompt=f"Response to critique:\n{current}",
                    system=self.CRITIQUE_PROMPT,
                    temperature=0.6,
                    max_tokens=1024
                )
                traces.append(f"Iteration {iteration + 1} critique: {len(critique.split())} words")
            except Exception as e:
                traces.append(f"Iteration {iteration + 1} critique failed: {e}")
                break
            
            # Revise based on critique
            revision_system = self.REVISION_PROMPT.format(original=current, critique=critique)
            try:
                revised = self.api_fn(
                    prompt=prompt,
                    system=revision_system,
                    temperature=0.5,
                    max_tokens=2048
                )
                traces.append(f"Iteration {iteration + 1} revision: {len(revised.split())} words")
            except Exception as e:
                traces.append(f"Iteration {iteration + 1} revision failed: {e}")
                break
            
            # Check convergence
            new_score = self._quality_score(revised)
            improvement = new_score - prev_score
            traces.append(f"  Quality: {prev_score:.3f} → {new_score:.3f} (Δ={improvement:+.3f})")
            
            if improvement < self.config.convergence_threshold:
                traces.append(f"Converged: improvement {improvement:.3f} < threshold {self.config.convergence_threshold}")
                break
            
            current = revised
            prev_score = new_score
        
        return current, traces


class ConstitutionalLoop:
    """
    Check response against constitutional principles and iteratively fix violations.
    
    Principles cover: logical consistency, evidence grounding, uncertainty,
    step-by-step reasoning, completeness, accuracy, clarity, bias awareness,
    alternative consideration, edge cases, self-verification, confidence,
    sourcing, coherence, practical applicability.
    """
    
    PRINCIPLES = [
        ("Logical Consistency", "All claims should be logically consistent and non-contradictory."),
        ("Evidence Grounding", "Major claims should be supported by evidence, reasoning, or examples."),
        ("Uncertainty Acknowledgment", "Acknowledge limitations, uncertainties, and cases where you're less confident."),
        ("Step-by-Step Reasoning", "Complex reasoning should be broken into clear, sequential steps."),
        ("Completeness", "Address all parts of the question. Don't omit relevant dimensions."),
        ("Factual Accuracy", "Verify that factual claims are correct. Correct known misconceptions."),
        ("Clarity", "Use clear language. Define technical terms. Organize logically."),
        ("Bias Awareness", "Acknowledge potential biases in your perspective or sources."),
        ("Alternative Consideration", "Consider alternative viewpoints, interpretations, or approaches."),
        ("Edge Case Handling", "Address edge cases, exceptions, and boundary conditions."),
        ("Self-Verification", "Check your own logic and conclusions for errors before finalizing."),
        ("Appropriate Confidence", "Match confidence level to the certainty of your claims."),
        ("Source Attribution", "When citing facts, indicate where the information comes from."),
        ("Coherence", "Maintain coherent flow and clear transitions between ideas."),
        ("Practical Applicability", "When relevant, explain how the response applies to real-world scenarios."),
    ]
    
    CHECK_TEMPLATE = """Evaluate whether this response follows the principle: {principle}
Definition: {definition}

Response to evaluate:
{response}

Question: Does this response successfully follow this principle?
Answer YES, NO, or PARTIAL with a brief justification (1-2 sentences).
Format: [YES/NO/PARTIAL] Justification"""
    
    FIX_TEMPLATE = """This response violates the principle: {principle}
Definition: {definition}

Current response:
{response}

Issue identified: {issue}

Revise the response to better follow this principle. Maintain what's good about the current version while addressing the violation.
Provide the improved response in full."""
    
    def __init__(self, api_fn: Callable, config: StallConfig):
        self.api_fn = api_fn
        self.config = config
    
    def _parse_check_result(self, text: str) -> Tuple[str, str]:
        """Extract [YES/NO/PARTIAL] and justification."""
        match = re.match(r'\[(YES|NO|PARTIAL)\]\s*(.*)', text, re.DOTALL)
        if match:
            return match.group(1), match.group(2).strip()
        return "UNKNOWN", text
    
    async def run(self, task: str, initial_response: str) -> Tuple[str, List[str]]:
        """Run constitutional loop strategy."""
        traces = []
        current = initial_response
        
        for principle_name, principle_def in self.PRINCIPLES:
            # Check principle
            check_prompt = self.CHECK_TEMPLATE.format(
                principle=principle_name,
                definition=principle_def,
                response=current
            )
            
            try:
                check_result = self.api_fn(
                    prompt=check_prompt,
                    system="You are a rigorous principle-checker. Be fair but thorough.",
                    temperature=0.3,
                    max_tokens=256
                )
                result_type, justification = self._parse_check_result(check_result)
                traces.append(f"Principle '{principle_name}': {result_type}")
            except Exception as e:
                traces.append(f"Principle '{principle_name}': CHECK_ERROR - {e}")
                continue
            
            # If failed, attempt fix
            if result_type in ["NO", "PARTIAL"]:
                fix_prompt = self.FIX_TEMPLATE.format(
                    principle=principle_name,
                    definition=principle_def,
                    response=current,
                    issue=justification
                )
                
                try:
                    fixed = self.api_fn(
                        prompt=fix_prompt,
                        system="You are an expert at improving responses to meet high principles.",
                        temperature=0.5,
                        max_tokens=2048
                    )
                    current = fixed
                    traces.append(f"  → Fixed via revision")
                except Exception as e:
                    traces.append(f"  → FIX_ERROR: {e}")
        
        return current, traces


class BudgetForcer:
    """
    Force minimum thinking token budget by injecting thinking requirement into prompt.
    
    Verifies that model actually produces minimum tokens of reasoning before
    giving final answer. Re-prompts if necessary.
    """
    
    BUDGET_FORCING_PROMPT = """You MUST think deeply and thoroughly about this problem BEFORE giving your final answer.

Requirements:
1. Use <thinking>...</thinking> tags to show your reasoning process
2. Your thinking section MUST be substantive - at least {min_tokens} tokens of genuine reasoning
3. Consider multiple approaches, edge cases, and potential issues
4. Do NOT provide your final answer until you have completed your thinking

Your thinking should include:
- Breaking down the problem into components
- Exploring different solution paths
- Considering limitations and edge cases
- Verifying your logic
- Checking your work
- Considering alternative interpretations

Do NOT rush to an answer. Spend the time to think properly. Show all your reasoning.
Only after exhaustive thinking, provide your final answer."""
    
    REENTRY_PROMPT = """Your previous response did not include sufficient thinking. You must provide at least {min_tokens} tokens of reasoning in <thinking>...</thinking> tags before your answer.

Original task: {task}

Requirements:
1. Include extensive thinking tags with genuine reasoning (minimum {min_tokens} tokens)
2. Show your work: break down the problem, explore approaches, check your logic
3. THEN provide your final answer after the thinking section

Please try again with proper thinking."""
    
    def __init__(self, api_fn: Callable, config: StallConfig):
        self.api_fn = api_fn
        self.config = config
    
    def _count_thinking_tokens(self, text: str) -> int:
        """Rough estimate: 1 token ≈ 1.3 words."""
        match = re.search(r'<thinking>(.*?)</thinking>', text, re.DOTALL)
        if not match:
            return 0
        thinking_text = match.group(1)
        return len(thinking_text.split())
    
    async def run(self, task: str, context: str = "") -> Tuple[str, List[str]]:
        """Run budget-forcing strategy."""
        traces = []
        
        prompt = f"{context}\n\n{task}".strip()
        
        # First attempt with budget injection
        system_prompt = self.BUDGET_FORCING_PROMPT.format(
            min_tokens=self.config.min_thinking_tokens
        )
        
        try:
            response = self.api_fn(
                prompt=prompt,
                system=system_prompt,
                temperature=0.5,
                max_tokens=4096
            )
            traces.append(f"Initial response: {len(response.split())} words")
        except Exception as e:
            return "", [f"Initial request failed: {e}"]
        
        # Check if thinking budget was met
        thinking_tokens = self._count_thinking_tokens(response)
        traces.append(f"Thinking tokens: {thinking_tokens} (required: {self.config.min_thinking_tokens})")
        
        if thinking_tokens >= self.config.min_thinking_tokens:
            traces.append("Budget requirement met")
            return response, traces
        
        # If not met, re-prompt with stricter requirement
        traces.append("Budget not met, re-prompting...")
        
        reentry_system = self.REENTRY_PROMPT.format(
            min_tokens=self.config.min_thinking_tokens,
            task=task
        )
        
        try:
            response = self.api_fn(
                prompt=prompt,
                system=reentry_system,
                temperature=0.6,
                max_tokens=4096
            )
            thinking_tokens = self._count_thinking_tokens(response)
            traces.append(f"Re-attempt: {len(response.split())} words, thinking={thinking_tokens} tokens")
        except Exception as e:
            traces.append(f"Re-attempt failed: {e}")
        
        return response, traces


class DevilsAdvocate:
    """
    Generate adversarial critique and integrate objections.
    
    Three phases:
    1. Generate initial answer
    2. Generate ruthless devil's advocate critique
    3. Revise answer to address all critiques
    """
    
    DEVILS_PROMPT = """You are a brilliant and ruthless critic. Your job is to find every flaw, assumption, limitation, and alternative interpretation in the following response.

Be RUTHLESS and THOROUGH. Find:
- Hidden assumptions that might not hold
- Missing edge cases or counterexamples  
- Alternative interpretations of the question
- Weaknesses in the reasoning
- Cases where the answer might be wrong
- Oversimplifications
- Logical gaps
- Unstated prerequisites
- Potential misunderstandings

Do not be diplomatic. Point out real problems. What could go wrong with this answer?
Provide 3-5 specific criticisms. For each, explain why it matters."""
    
    INTEGRATION_PROMPT = """Your initial response received the following critical challenges:

{criticisms}

Now, revise your answer to be more robust and address these objections. Your new answer should:
1. Acknowledge valid concerns from the critique
2. Correct or address the issues raised
3. Explain your reasoning for maintaining or revising parts of your answer
4. Be more complete and less vulnerable to these specific critiques

Provide a thorough, revised response that takes the criticisms seriously."""
    
    def __init__(self, api_fn: Callable, config: StallConfig):
        self.api_fn = api_fn
        self.config = config
    
    async def run(self, task: str, initial_response: str) -> Tuple[str, List[str]]:
        """Run devils-advocate strategy."""
        traces = []
        
        # Phase 2: Get devil's advocate critique
        try:
            criticisms = self.api_fn(
                prompt=initial_response,
                system=self.DEVILS_PROMPT,
                temperature=0.7,
                max_tokens=1024
            )
            traces.append(f"Generated adversarial critique: {len(criticisms.split())} words")
        except Exception as e:
            return initial_response, [f"Critique generation failed: {e}"]
        
        # Phase 3: Integrate and revise
        integration_system = self.INTEGRATION_PROMPT.format(criticisms=criticisms)
        
        try:
            revised = self.api_fn(
                prompt=task,
                system=integration_system,
                temperature=0.6,
                max_tokens=2048
            )
            traces.append(f"Integrated revision: {len(revised.split())} words")
        except Exception as e:
            traces.append(f"Revision failed: {e}")
            return initial_response, traces
        
        return revised, traces


class Decomposer:
    """
    Break complex tasks into independent sub-tasks, solve each, and synthesize.
    
    Useful for multi-part problems, complex reasoning, system design questions.
    """
    
    DECOMPOSITION_PROMPT = """Break this problem into 3-7 independent sub-problems that are:
1. Simpler than the original problem
2. Each can be solved independently
3. Together they solve the full problem

Number each sub-problem and state it clearly.

Problem: {task}

Sub-problems:
(List each as a numbered item)"""
    
    SYNTHESIS_PROMPT = """Given these independent solutions to sub-problems:

{solutions}

Synthesize a complete, integrated answer to the original task: {task}

The final answer should:
1. Incorporate all the sub-solutions
2. Show how they fit together
3. Address any interactions between sub-problems
4. Provide a coherent overall response"""
    
    def __init__(self, api_fn: Callable, config: StallConfig):
        self.api_fn = api_fn
        self.config = config
    
    def _parse_subproblems(self, text: str) -> List[str]:
        """Extract numbered sub-problems."""
        # Look for patterns like "1. ...", "2. ...", etc.
        matches = re.findall(r'\d+\.\s*(.+?)(?=\n\d+\.|$)', text, re.DOTALL)
        if matches:
            return [m.strip() for m in matches]
        
        # Fall back: split by double newline
        parts = text.split('\n\n')
        return [p.strip() for p in parts if p.strip() and len(p.split()) > 5][:7]
    
    async def run(self, task: str, context: str = "") -> Tuple[str, List[str]]:
        """Run decomposer strategy."""
        traces = []
        
        # Step 1: Decompose
        decomp_prompt = self.DECOMPOSITION_PROMPT.format(task=task)
        
        try:
            decomposition = self.api_fn(
                prompt=decomp_prompt,
                system="You are expert at breaking complex problems into simpler sub-problems.",
                temperature=0.5,
                max_tokens=1024
            )
            traces.append(f"Decomposition: {len(decomposition.split())} words")
        except Exception as e:
            return "", [f"Decomposition failed: {e}"]
        
        # Step 2: Parse and solve sub-problems
        subproblems = self._parse_subproblems(decomposition)
        traces.append(f"Identified {len(subproblems)} sub-problems")
        
        solutions = []
        for i, subproblem in enumerate(subproblems):
            try:
                solution = self.api_fn(
                    prompt=f"{context}\n\nSub-problem: {subproblem}".strip(),
                    system="Solve this sub-problem thoroughly and clearly.",
                    temperature=0.5,
                    max_tokens=1024
                )
                solutions.append(f"Sub-problem {i+1}:\n{solution}")
                traces.append(f"  Solved sub-problem {i+1}: {len(solution.split())} words")
            except Exception as e:
                traces.append(f"  Sub-problem {i+1} failed: {e}")
        
        if not solutions:
            return "", traces
        
        # Step 3: Synthesize
        solutions_text = "\n\n".join(solutions)
        synthesis_prompt = self.SYNTHESIS_PROMPT.format(
            solutions=solutions_text,
            task=task
        )
        
        try:
            final = self.api_fn(
                prompt=task,
                system=synthesis_prompt,
                temperature=0.5,
                max_tokens=2048
            )
            traces.append(f"Synthesis: {len(final.split())} words")
        except Exception as e:
            traces.append(f"Synthesis failed: {e}")
            return "\n\n".join(solutions), traces
        
        return final, traces


class StallEngine:
    """
    Main orchestrator for test-time compute stalling.
    
    Selects appropriate strategy, executes it, and returns results.
    """
    
    def __init__(
        self,
        api_fn: Optional[Callable] = None,
        config: Optional[StallConfig] = None,
        mode: str = "hard",
    ):
        """
        Initialize stalling engine.

        Args:
            api_fn: Callable(prompt, system=None, temperature=0.0, max_tokens=2048) -> str
                    Optional — can be set later via engine.api_fn = fn
            config: StallConfig with strategy and parameters
            mode: Active mode (easy/medium/hard/deep/extreme/genius/god).
                  Drives default strategy selection and budget limits.
        """
        self.api_fn = api_fn
        self.mode = mode
        self.config = config or StallConfig()
        self.stats = {
            "total_calls": 0,
            "total_tokens": 0,
            "total_time": 0.0,
            "strategies_used": {},
        }

        # A lightweight budget object so enhance.py can read .budget.total
        class _Budget:
            def __init__(self, total: int = 4096):
                self.total = total
        _mode_budgets = {
            "easy": 1024, "flash": 1024, "medium": 2048,
            "hard": 4096, "deep": 8192, "extreme": 16384,
            "genius": 32768, "god": 65536, "opus": 65536,
        }
        self.budget = _Budget(_mode_budgets.get(mode, 4096))

    def build_prompt(
        self,
        task: str,
        base_context: str = "",
        strategy: Optional[str] = None,
    ) -> str:
        """
        Build a stall-augmented prompt for the given task.

        Args:
            task: The user task / question.
            base_context: Optional context to inject into the prompt.
            strategy: Which stalling strategy to scaffold ('chain_of_draft',
                      'budget_force', 'constitutional', 'scratchpad',
                      'devils_advocate', 'self_consistency', 'confidence_gate',
                      'hybrid').  Defaults to auto-select.

        Returns:
            A string prompt ready to be sent to the model.
        """
        if not strategy or strategy == "auto":
            strategy = self._auto_select_strategy(task)

        strategy_instructions = {
            "chain_of_draft": (
                "Think step-by-step in a concise scratchpad using <draft> tags, "
                "then give ONE crisp final answer after '=== FINAL ANSWER ==='."
            ),
            "budget_force": (
                "You have a strict token budget. Be precise and complete — do not "
                "pad with filler. Deliver maximum value per token."
            ),
            "constitutional": (
                "Draft your answer, then self-critique it against these principles: "
                "helpfulness, harmlessness, honesty. Revise and output the final answer."
            ),
            "scratchpad": (
                "Use a private <scratchpad> to reason freely before committing to your "
                "final answer."
            ),
            "devils_advocate": (
                "First argue the opposing position strongly, then argue your position, "
                "then deliver a balanced final answer."
            ),
            "self_consistency": (
                "Generate 3 independent reasoning paths, then choose the most consistent "
                "answer across all paths."
            ),
            "confidence_gate": (
                "After answering, rate your confidence 0-100. If < 80, redo the answer "
                "from a different angle until confidence ≥ 80."
            ),
            "hybrid": (
                "Combine chain-of-draft reasoning with self-consistency voting: produce "
                "3 brief drafts, vote on the best, then write the polished final answer."
            ),
        }

        instruction = strategy_instructions.get(
            strategy, strategy_instructions["budget_force"]
        )

        ctx_block = f"\n\nContext:\n{base_context}" if base_context else ""
        return (
            f"### STALLING SCAFFOLD: {strategy.upper()} ###\n"
            f"{instruction}"
            f"{ctx_block}\n\n"
            f"Task: {task}"
        )
    
    def _auto_select_strategy(self, task: str) -> str:
        """Classify task and recommend best strategy."""
        task_lower = task.lower()
        
        # Math/factual indicators
        if any(kw in task_lower for kw in ["calculate", "compute", "prove", "solve", "answer", "what is", "how many", "find the"]):
            return "self_consistency"
        
        # Creative/open-ended indicators  
        if any(kw in task_lower for kw in ["write", "create", "design", "propose", "explain", "describe", "how to", "best way"]):
            return "chain_of_draft"
        
        # Complex multi-step indicators
        if any(kw in task_lower for kw in ["architecture", "strategy", "plan", "system", "process", "workflow", "implement"]):
            return "decompose"
        
        # Safety/sensitive indicators
        if any(kw in task_lower for kw in ["should", "ethical", "bias", "fairness", "principle", "decision", "policy"]):
            return "constitutional"
        
        # Default
        return "budget_force"
    
    def _estimate_quality_improvement(self, strategy: str, task_type: str = "general") -> float:
        """Estimate quality improvement for a strategy."""
        base_improvements = {
            "self_consistency": 0.15,
            "chain_of_draft": 0.22,
            "constitutional": 0.18,
            "budget_force": 0.12,
            "devils_advocate": 0.16,
            "decompose": 0.20,
        }
        
        return base_improvements.get(strategy, 0.15)
    
    def stall(
        self,
        task: str,
        context: str = "",
        strategy: Optional[str] = None,
        base_response: Optional[str] = None
    ) -> StallResult:
        """
        Execute stalling strategy to improve response quality.
        
        Args:
            task: The task/question to answer
            context: Additional context or background
            strategy: Which strategy to use (or "auto" to select)
            base_response: Starting response (for constitutional, devils_advocate)
        
        Returns:
            StallResult with final output and metadata
        """
        start_time = time.time()
        traces = []
        
        # Select strategy
        selected_strategy = strategy or self.config.strategy
        if selected_strategy == "auto":
            selected_strategy = self._auto_select_strategy(task)
            traces.append(f"Auto-selected strategy: {selected_strategy}")
        
        self.stats["strategies_used"][selected_strategy] = self.stats["strategies_used"].get(selected_strategy, 0) + 1
        
        # Run strategy
        try:
            if selected_strategy == "self_consistency":
                runner = SelfConsistency(self.api_fn, self.config)
                final_output, strategy_traces = asyncio.run(runner.run(task, context))
            
            elif selected_strategy == "chain_of_draft":
                runner = ChainOfDraft(self.api_fn, self.config)
                final_output, strategy_traces = asyncio.run(runner.run(task, context))
            
            elif selected_strategy == "constitutional":
                if not base_response:
                    # Generate initial response first
                    base_response = self.api_fn(
                        prompt=f"{context}\n\n{task}".strip(),
                        system="Provide a thorough, well-reasoned response.",
                        temperature=0.5,
                        max_tokens=2048
                    )
                    traces.append("Generated initial response for constitutional check")
                
                runner = ConstitutionalLoop(self.api_fn, self.config)
                final_output, strategy_traces = asyncio.run(runner.run(task, base_response))
            
            elif selected_strategy == "budget_force":
                runner = BudgetForcer(self.api_fn, self.config)
                final_output, strategy_traces = asyncio.run(runner.run(task, context))
            
            elif selected_strategy == "devils_advocate":
                if not base_response:
                    base_response = self.api_fn(
                        prompt=f"{context}\n\n{task}".strip(),
                        system="Provide a thorough, well-reasoned response.",
                        temperature=0.5,
                        max_tokens=2048
                    )
                    traces.append("Generated initial response for devil's advocate")
                
                runner = DevilsAdvocate(self.api_fn, self.config)
                final_output, strategy_traces = asyncio.run(runner.run(task, base_response))
            
            elif selected_strategy == "decompose":
                runner = Decomposer(self.api_fn, self.config)
                final_output, strategy_traces = asyncio.run(runner.run(task, context))
            
            else:
                raise ValueError(f"Unknown strategy: {selected_strategy}")
            
            traces.extend(strategy_traces)
        
        except Exception as e:
            traces.append(f"STRATEGY_ERROR: {e}")
            final_output = base_response or ""
        
        time_taken = time.time() - start_time
        
        # Estimate quality improvement
        estimated_improvement = self._estimate_quality_improvement(selected_strategy)
        
        # Update stats
        self.stats["total_time"] += time_taken
        
        if self.config.verbose:
            for trace in traces:
                print(f"  {trace}")
        
        return StallResult(
            final_output=final_output,
            strategy_used=selected_strategy,
            iterations=self.config.max_iterations,
            samples_generated=self.config.n_samples if selected_strategy == "self_consistency" else 1,
            quality_improvement=estimated_improvement,
            reasoning_trace=traces,
            tokens_used=0,  # Would need token counter from API
            time_taken=time_taken
        )
    
    def get_stats(self) -> Dict[str, Any]:
        """Get usage statistics."""
        return {
            **self.stats,
            "strategies_used_count": sum(self.stats["strategies_used"].values()),
            "avg_time_per_strategy": {
                k: self.stats["total_time"] / v if v > 0 else 0
                for k, v in self.stats["strategies_used"].items()
            }
        }


# Example usage and testing
if __name__ == "__main__":
    # Mock API function for testing
    def mock_api(prompt: str, system: str = None, temperature: float = 0.0, max_tokens: int = 2048) -> str:
        """Mock API for testing."""
        import random
        responses = [
            "This is a comprehensive response to your question. First, let me break down the problem...",
            "The answer depends on several factors. Therefore, we must consider...",
            "In summary, the key points are: 1) First point, 2) Second point, 3) Third point.",
            "Based on careful analysis, I conclude that... However, it's important to note that..."
        ]
        return random.choice(responses)
    
    # Test basic functionality
    config = StallConfig(
        strategy="auto",
        n_samples=3,
        max_iterations=2,
        verbose=True
    )
    
    engine = StallEngine(mock_api, config)
    
    result = engine.stall(
        task="What are the key considerations for building scalable machine learning systems?",
        context="Focus on production aspects."
    )
    
    print(f"\nStrategy used: {result.strategy_used}")
    print(f"Quality improvement estimate: {result.quality_improvement:.1%}")
    print(f"Time taken: {result.time_taken:.2f}s")
    print(f"\nFinal output:\n{result.final_output}")
    
    stats = engine.get_stats()
    print(f"\nStats: {stats}")



# ---------------------------------------------------------------------------
# stall_agent_prompt — compat shim used by enhance.py
# ---------------------------------------------------------------------------

def stall_agent_prompt(
    agent_name: str,
    task: str,
    mode: str = "hard",
    base_prompt: str = "",
) -> str:
    """
    Build a stall-enriched system prompt for a specific Lazy Chameleon agent.

    This wraps the agent's base prompt with mode-appropriate stalling
    scaffolding so that a flash model reasons as hard as a frontier model
    for the cost of extra output tokens (cheap) vs extra parameters (expensive).

    Parameters
    ----------
    agent_name : str
        One of: scout, critic, architect, debug, historian, optimizer,
        research, simulator (maps to agent personality).
    task : str
        The task being solved — used to choose the best stall strategy.
    mode : str
        Compute mode from HarnessConfig (flash/easy/medium/hard/deep/extreme/genius).
    base_prompt : str
        The agent's existing system prompt to enrich.

    Returns
    -------
    str
        Enriched system prompt ready to prefix agent calls.
    """
    # Agent-specific stalling personalities
    AGENT_STALL_PROFILES: dict[str, dict] = {
        "scout": {
            "strategy": "self_consistency",
            "focus": "enumerate ALL viable approaches before committing to one",
            "directive": (
                "You are a world-class solution scout. Before proposing anything, "
                "silently enumerate at least 5 distinct approaches, estimate their "
                "complexity and risk, then recommend the best with full justification."
            ),
        },
        "critic": {
            "strategy": "devils_advocate",
            "focus": "find every flaw, missing case, and hidden assumption",
            "directive": (
                "You are a ruthless senior reviewer with 20+ years of experience. "
                "For every claim, ask: what breaks this? what is assumed? what is "
                "missing? what would a hostile reviewer say? Never wave away risks."
            ),
        },
        "architect": {
            "strategy": "decompose",
            "focus": "decompose into components, design each, then integrate",
            "directive": (
                "You are a principal software architect. Decompose the system into "
                "components with clear interfaces. For each: responsibility, data flow, "
                "failure modes, scalability. Then describe the integration."
            ),
        },
        "debug": {
            "strategy": "chain_of_draft",
            "focus": "root-cause analysis with hypothesis → test → eliminate loop",
            "directive": (
                "You are an expert debugger and QA engineer. Form hypotheses about "
                "root causes ranked by likelihood. For each: what evidence supports it? "
                "what would disprove it? what is the fix? Eliminate systematically."
            ),
        },
        "historian": {
            "strategy": "self_consistency",
            "focus": "recall past solutions and lessons with high fidelity",
            "directive": (
                "You are a senior staff engineer with encyclopedic memory of past "
                "solutions, patterns, and anti-patterns. Recall what worked, what failed, "
                "and why. Apply those lessons with specific, concrete references."
            ),
        },
        "optimizer": {
            "strategy": "budget_force",
            "focus": "find every performance improvement opportunity",
            "directive": (
                "You are a performance engineering specialist. Think in concrete numbers: "
                "latency P50/P95/P99, throughput req/s, memory bytes, CPU %. For every "
                "optimization: expected gain, confidence, measurement plan."
            ),
        },
        "research": {
            "strategy": "constitutional",
            "focus": "thorough literature and best-practice synthesis",
            "directive": (
                "You are a principal research scientist. Synthesize knowledge from "
                "first principles, cite specific techniques and their tradeoffs, "
                "distinguish established consensus from emerging practice."
            ),
        },
        "simulator": {
            "strategy": "decompose",
            "focus": "stress-test all assumptions with adversarial scenarios",
            "directive": (
                "You are a chaos engineering and stress-testing specialist. Generate "
                "realistic failure scenarios: edge inputs, concurrency, resource "
                "exhaustion, dependency failures. For each: probability, impact, detection, recovery."
            ),
        },
    }

    # Mode → thinking depth directive
    MODE_DEPTH: dict[str, str] = {
        "flash": "Be concise. 1-2 sentences per point.",
        "easy":  "Be clear and direct. Short paragraphs.",
        "turbo": "Balanced depth. Cover the key points thoroughly.",
        "medium": "Be thorough. Use structured sections.",
        "hard":  "Think deeply. Explore edge cases and alternatives.",
        "deep":  (
            "Think exhaustively. Consider every angle. "
            "Use numbered reasoning steps before your final answer."
        ),
        "extreme": (
            "Reason at the level of a world-class expert. "
            "Show full chain-of-thought. Consider adversarial cases. "
            "Verify your answer from multiple angles before committing."
        ),
        "genius": (
            "You have unlimited thinking budget. Think step-by-step with "
            "numbered substeps. Consider at least 3 alternative approaches. "
            "Self-critique your initial answer. Revise. Then give final answer."
        ),
        "god": (
            "Think as if this is the most important problem you will ever solve. "
            "Exhaust every approach. Use chain-of-thought. Consider adversarial inputs. "
            "Cross-validate from multiple angles. Acknowledge uncertainty explicitly."
        ),
        "opus": (
            "Reason at the frontier of human knowledge. Full systematic decomposition. "
            "First-principles derivation where applicable. Consider ALL edge cases. "
            "Self-consistency check. Revise if inconsistency found. Cite reasoning for every claim."
        ),
    }

    profile = AGENT_STALL_PROFILES.get(agent_name.lower(), {
        "strategy": "budget_force",
        "focus": "thorough, high-quality reasoning",
        "directive": "Think carefully and systematically before answering.",
    })

    depth = MODE_DEPTH.get(mode.lower(), MODE_DEPTH["hard"])

    parts: list[str] = []

    if base_prompt:
        parts.append(base_prompt.rstrip())
        parts.append("")

    parts.append("=" * 60)
    parts.append("STALLING SCAFFOLD — INFERENCE-TIME COMPUTE BOOST")
    parts.append("=" * 60)
    parts.append("")
    parts.append(profile["directive"])
    parts.append("")
    parts.append(f"THINKING DEPTH ({mode.upper()}): {depth}")
    parts.append("")
    parts.append(f"FOCUS FOR THIS TASK: {profile['focus']}")
    parts.append("")
    parts.append(
        "MANDATORY PROCESS:\n"
        "1. Read the task carefully — restate the core requirement in one sentence.\n"
        "2. Identify what could go wrong or be misunderstood.\n"
        "3. Work through your reasoning step by step.\n"
        "4. Check your answer against the original requirement.\n"
        "5. State your confidence (0–10) and any remaining uncertainties."
    )
    parts.append("=" * 60)

    return "\n".join(parts)
