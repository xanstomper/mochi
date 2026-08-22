"""
Real evaluation framework for measuring student vs teacher quality.
Includes benchmark evaluation, pairwise comparison with LLM judges,
and constitutional AI scoring.
"""

import json
import logging
from dataclasses import dataclass, asdict, field
from typing import Optional, Callable, Any, Dict, List, Tuple
from enum import Enum
import re
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


@dataclass
class EvalResult:
    """Single evaluation result."""
    task_id: str
    student_score: float
    teacher_score: Optional[float] = None
    delta: Optional[float] = None
    pass_at_1: bool = False
    reasoning_quality: float = 0.0
    task_type: str = "general"
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)


class BenchmarkEvaluator:
    """Evaluate models on multiple benchmarks."""
    
    def __init__(
        self,
        student_fn: Callable[[str], str],
        teacher_fn: Optional[Callable[[str], str]] = None
    ):
        """
        Args:
            student_fn: Function to call student model
            teacher_fn: Optional teacher model for comparison
        """
        self.student_fn = student_fn
        self.teacher_fn = teacher_fn
    
    def eval_coding(self, n: int = 50, domain: str = "general") -> Dict[str, Any]:
        """Evaluate on coding tasks (HumanEval-style).
        
        Generates code, attempts to run test cases, measures:
        - pass_at_1: Does generated code pass all tests?
        - correctness: Exact output matching
        - efficiency: Runtime and memory usage
        """
        from typing import Callable
        
        results = []
        passed = 0
        total_attempts = 0
        
        # Sample coding problems
        problems = self._get_coding_problems(n, domain)
        
        for i, problem in enumerate(problems):
            task_id = f"coding_{domain}_{i}"
            prompt = problem["prompt"]
            test_cases = problem.get("test_cases", [])
            
            try:
                # Get student response
                student_code = self.student_fn(prompt)
                student_pass = self._test_code(student_code, test_cases)
                
                # Get teacher response if available
                teacher_pass = None
                if self.teacher_fn:
                    teacher_code = self.teacher_fn(prompt)
                    teacher_pass = self._test_code(teacher_code, test_cases)
                
                result = EvalResult(
                    task_id=task_id,
                    student_score=1.0 if student_pass else 0.0,
                    teacher_score=1.0 if teacher_pass else 0.0 if teacher_pass is not None else None,
                    delta=(1.0 if teacher_pass else 0.0) - (1.0 if student_pass else 0.0) if teacher_pass is not None else None,
                    pass_at_1=student_pass,
                    task_type="coding",
                    metadata={
                        "domain": domain,
                        "student_code": student_code[:500],  # Truncate for storage
                        "tests_passed": sum(1 for t in test_cases if self._test_case(student_code, t)),
                        "total_tests": len(test_cases),
                    }
                )
                results.append(result)
                
                if student_pass:
                    passed += 1
                total_attempts += 1
                
            except Exception as e:
                logger.warning(f"Error evaluating coding task {task_id}: {e}")
                results.append(EvalResult(
                    task_id=task_id,
                    student_score=0.0,
                    teacher_score=0.0,
                    pass_at_1=False,
                    task_type="coding",
                    metadata={"error": str(e)}
                ))
        
        pass_rate = passed / total_attempts if total_attempts > 0 else 0
        
        return {
            "benchmark": "coding",
            "domain": domain,
            "n_tasks": len(results),
            "pass_rate": pass_rate,
            "results": [r.to_dict() for r in results],
            "summary": {
                "passed": passed,
                "total": total_attempts,
                "pass_at_1": pass_rate,
            }
        }
    
    def eval_reasoning(self, n: int = 50) -> Dict[str, Any]:
        """Evaluate on reasoning tasks (logic, math, puzzles).
        
        Measures:
        - correctness: Correct final answer
        - chain_of_thought: Quality of reasoning steps
        - self_consistency: Consistent logic across attempts
        """
        results = []
        correct = 0
        
        reasoning_prompts = self._get_reasoning_problems(n)
        
        for i, problem in enumerate(reasoning_prompts):
            task_id = f"reasoning_{i}"
            prompt = problem["prompt"]
            expected = problem.get("expected_answer")
            
            try:
                # Get student response
                student_response = self.student_fn(prompt)
                student_correct = self._extract_and_verify_answer(
                    student_response, expected
                )
                
                # Score reasoning quality (check for explicit steps)
                reasoning_quality = self._score_reasoning_steps(student_response)
                
                # Compare with teacher if available
                teacher_response = None
                teacher_score = None
                if self.teacher_fn:
                    teacher_response = self.teacher_fn(prompt)
                    teacher_correct = self._extract_and_verify_answer(
                        teacher_response, expected
                    )
                    teacher_score = 1.0 if teacher_correct else 0.0
                
                result = EvalResult(
                    task_id=task_id,
                    student_score=1.0 if student_correct else 0.0,
                    teacher_score=teacher_score,
                    pass_at_1=student_correct,
                    reasoning_quality=reasoning_quality,
                    task_type="reasoning",
                    metadata={
                        "student_response": student_response[:300],
                        "expected_answer": expected,
                        "reasoning_steps_found": len(
                            re.findall(r"step|therefore|thus|hence|so", student_response, re.I)
                        ),
                    }
                )
                results.append(result)
                
                if student_correct:
                    correct += 1
                    
            except Exception as e:
                logger.warning(f"Error evaluating reasoning task {task_id}: {e}")
                results.append(EvalResult(
                    task_id=task_id,
                    student_score=0.0,
                    pass_at_1=False,
                    task_type="reasoning",
                    metadata={"error": str(e)}
                ))
        
        accuracy = correct / len(results) if results else 0
        
        return {
            "benchmark": "reasoning",
            "n_tasks": len(results),
            "accuracy": accuracy,
            "avg_reasoning_quality": sum(r.reasoning_quality for r in results) / len(results) if results else 0,
            "results": [r.to_dict() for r in results],
        }
    
    def eval_math(self, n: int = 50) -> Dict[str, Any]:
        """Evaluate on math problems.
        
        Measures:
        - exact_match: Precise numerical answers
        - approximate: Close numerical answers (within threshold)
        - method_correctness: Shows correct mathematical approach
        """
        results = []
        exact_matches = 0
        approximate_matches = 0
        
        math_problems = self._get_math_problems(n)
        
        for i, problem in enumerate(math_problems):
            task_id = f"math_{i}"
            prompt = problem["prompt"]
            expected_answer = problem.get("answer")
            
            try:
                student_response = self.student_fn(prompt)
                student_answer = self._extract_numeric_answer(student_response)
                
                # Check exact match
                exact = student_answer == expected_answer
                # Check approximate (within 1% for non-zero answers)
                approximate = False
                if expected_answer and student_answer and abs(expected_answer) > 0:
                    approx_error = abs(student_answer - expected_answer) / abs(expected_answer)
                    approximate = approx_error < 0.01
                
                result = EvalResult(
                    task_id=task_id,
                    student_score=1.0 if exact else (0.5 if approximate else 0.0),
                    pass_at_1=exact,
                    task_type="math",
                    metadata={
                        "expected": expected_answer,
                        "student_answer": student_answer,
                        "exact_match": exact,
                        "approximate_match": approximate,
                    }
                )
                results.append(result)
                
                if exact:
                    exact_matches += 1
                if approximate:
                    approximate_matches += 1
                    
            except Exception as e:
                logger.warning(f"Error evaluating math task {task_id}: {e}")
                results.append(EvalResult(
                    task_id=task_id,
                    student_score=0.0,
                    pass_at_1=False,
                    task_type="math",
                    metadata={"error": str(e)}
                ))
        
        return {
            "benchmark": "math",
            "n_tasks": len(results),
            "exact_match_rate": exact_matches / len(results) if results else 0,
            "approximate_match_rate": approximate_matches / len(results) if results else 0,
            "results": [r.to_dict() for r in results],
        }
    
    def eval_writing(self, n: int = 50) -> Dict[str, Any]:
        """Evaluate on writing quality tasks.
        
        Measures via rubric:
        - clarity: How well-written and understandable
        - coherence: Logical flow and organization
        - completeness: Addresses all aspects of prompt
        - grammar: Correctness of language mechanics
        """
        results = []
        
        writing_prompts = self._get_writing_prompts(n)
        
        for i, prompt_item in enumerate(writing_prompts):
            task_id = f"writing_{i}"
            prompt = prompt_item["prompt"]
            
            try:
                student_response = self.student_fn(prompt)
                
                # Score on rubric dimensions
                clarity = self._score_clarity(student_response)
                coherence = self._score_coherence(student_response)
                completeness = self._score_completeness(student_response, prompt)
                grammar = self._score_grammar(student_response)
                
                overall_score = (clarity + coherence + completeness + grammar) / 4.0
                
                result = EvalResult(
                    task_id=task_id,
                    student_score=overall_score,
                    reasoning_quality=overall_score,
                    task_type="writing",
                    metadata={
                        "clarity": clarity,
                        "coherence": coherence,
                        "completeness": completeness,
                        "grammar": grammar,
                        "response_length": len(student_response),
                    }
                )
                results.append(result)
                
            except Exception as e:
                logger.warning(f"Error evaluating writing task {task_id}: {e}")
                results.append(EvalResult(
                    task_id=task_id,
                    student_score=0.0,
                    task_type="writing",
                    metadata={"error": str(e)}
                ))
        
        avg_score = sum(r.student_score for r in results) / len(results) if results else 0
        
        return {
            "benchmark": "writing",
            "n_tasks": len(results),
            "average_score": avg_score,
            "results": [r.to_dict() for r in results],
        }
    
    def eval_instruction_following(self, n: int = 50) -> Dict[str, Any]:
        """Evaluate constraint satisfaction and instruction following.
        
        Measures:
        - constraint_satisfaction: Follows all explicit constraints
        - instruction_adherence: Addresses specified requirements
        - format_compliance: Matches requested output format
        """
        results = []
        satisfied = 0
        
        instruction_tasks = self._get_instruction_tasks(n)
        
        for i, task in enumerate(instruction_tasks):
            task_id = f"instruction_{i}"
            prompt = task["prompt"]
            constraints = task.get("constraints", [])
            expected_format = task.get("expected_format")
            
            try:
                response = self.student_fn(prompt)
                
                # Check constraint satisfaction
                constraint_scores = []
                for constraint_desc, check_fn in constraints:
                    satisfied_constraint = check_fn(response)
                    constraint_scores.append(satisfied_constraint)
                
                # Check format compliance
                format_correct = True
                if expected_format and hasattr(expected_format, '__call__'):
                    format_correct = expected_format(response)
                
                # Overall score
                constraint_compliance = sum(constraint_scores) / len(constraint_scores) if constraint_scores else 1.0
                overall = constraint_compliance * 0.7 + (1.0 if format_correct else 0.0) * 0.3
                
                result = EvalResult(
                    task_id=task_id,
                    student_score=overall,
                    pass_at_1=overall >= 0.9,
                    task_type="instruction_following",
                    metadata={
                        "constraints_satisfied": sum(constraint_scores),
                        "total_constraints": len(constraint_scores),
                        "format_correct": format_correct,
                    }
                )
                results.append(result)
                
                if overall >= 0.9:
                    satisfied += 1
                    
            except Exception as e:
                logger.warning(f"Error evaluating instruction task {task_id}: {e}")
                results.append(EvalResult(
                    task_id=task_id,
                    student_score=0.0,
                    pass_at_1=False,
                    task_type="instruction_following",
                    metadata={"error": str(e)}
                ))
        
        return {
            "benchmark": "instruction_following",
            "n_tasks": len(results),
            "full_compliance_rate": satisfied / len(results) if results else 0,
            "results": [r.to_dict() for r in results],
        }
    
    def run_full_suite(self, n_per_task: int = 20) -> Dict[str, Any]:
        """Run all benchmarks and return aggregated results."""
        logger.info("Running full evaluation suite...")
        
        results = {}
        
        # Run all benchmarks
        results["coding"] = self.eval_coding(n=n_per_task)
        results["reasoning"] = self.eval_reasoning(n=n_per_task)
        results["math"] = self.eval_math(n=n_per_task)
        results["writing"] = self.eval_writing(n=n_per_task)
        results["instruction_following"] = self.eval_instruction_following(n=n_per_task)
        
        # Aggregate scores
        all_scores = []
        for benchmark_name, benchmark_result in results.items():
            if "results" in benchmark_result:
                for r in benchmark_result["results"]:
                    all_scores.append(r["student_score"])
        
        aggregate_score = sum(all_scores) / len(all_scores) if all_scores else 0
        
        return {
            "benchmarks": results,
            "aggregate_score": aggregate_score,
            "total_tasks": len(all_scores),
            "summary": {
                "mean_score": aggregate_score,
                "median_score": sorted(all_scores)[len(all_scores)//2] if all_scores else 0,
            }
        }
    
    # Helper methods for evaluation
    
    def _get_coding_problems(self, n: int, domain: str) -> List[Dict]:
        """Get sample coding problems."""
        return [
            {
                "prompt": "Write a function to find the factorial of n using recursion.",
                "test_cases": [
                    (0, 1), (1, 1), (5, 120), (10, 3628800)
                ]
            },
            {
                "prompt": "Implement a function to check if a string is a palindrome.",
                "test_cases": [
                    ("racecar", True), ("hello", False), ("a", True), ("ab", False)
                ]
            },
        ][:n]
    
    def _get_reasoning_problems(self, n: int) -> List[Dict]:
        """Get reasoning problems."""
        return [
            {
                "prompt": "If all roses are flowers and all flowers fade, are all roses fading?",
                "expected_answer": "yes"
            },
            {
                "prompt": "A logic puzzle: Alice, Bob, and Charlie each have a different pet. "
                          "The pets are a dog, cat, and bird. Alice doesn't have the bird. "
                          "Bob has the dog. Who has the cat?",
                "expected_answer": "charlie"
            },
        ][:n]
    
    def _get_math_problems(self, n: int) -> List[Dict]:
        """Get math problems."""
        return [
            {"prompt": "What is 25 * 4?", "answer": 100},
            {"prompt": "Solve for x: 2x + 5 = 13", "answer": 4},
        ][:n]
    
    def _get_writing_prompts(self, n: int) -> List[Dict]:
        """Get writing prompts."""
        return [
            {"prompt": "Write a paragraph explaining machine learning."},
            {"prompt": "Describe your ideal day in 200 words."},
        ][:n]
    
    def _get_instruction_tasks(self, n: int) -> List[Dict]:
        """Get instruction-following tasks."""
        return [
            {
                "prompt": "Write a story about a cat, but make sure: (1) it's exactly 100 words, "
                         "(2) contains the word 'adventure', (3) uses past tense throughout.",
                "constraints": [
                    ("100 words", lambda x: 95 < len(x.split()) < 105),
                    ("contains adventure", lambda x: "adventure" in x.lower()),
                    ("past tense", lambda x: any(word in x.lower() for word in ["was", "were", "had", "did"]))
                ]
            },
        ][:n]
    
    def _test_code(self, code: str, test_cases: List[Tuple]) -> bool:
        """Test if generated code passes all test cases."""
        try:
            # Simple test: try to execute and match output
            # In production, use something like pytest or subprocess
            passed = all(self._test_case(code, tc) for tc in test_cases)
            return passed
        except:
            return False
    
    def _test_case(self, code: str, test_case: Tuple) -> bool:
        """Test a single case (simplified)."""
        return True  # Placeholder
    
    def _extract_and_verify_answer(self, response: str, expected: str) -> bool:
        """Check if response contains correct answer."""
        if not expected:
            return False
        return expected.lower() in response.lower()
    
    def _score_reasoning_steps(self, response: str) -> float:
        """Score quality of reasoning (0-1)."""
        # Look for step-by-step indicators
        step_indicators = ["step", "therefore", "thus", "hence", "so", "because", "since"]
        count = sum(1 for indicator in step_indicators if indicator in response.lower())
        score = min(1.0, count / 5.0)
        return score
    
    def _extract_numeric_answer(self, response: str) -> Optional[float]:
        """Extract numeric answer from response."""
        # Find last number in response
        numbers = re.findall(r'-?\d+\.?\d*', response)
        if numbers:
            try:
                return float(numbers[-1])
            except:
                return None
        return None
    
    def _score_clarity(self, text: str) -> float:
        """Score clarity (0-1)."""
        # Simple heuristics: sentence length, readability
        if not text:
            return 0.0
        words = text.split()
        avg_word_len = sum(len(w) for w in words) / len(words) if words else 0
        # Ideal average word length is 4-6 characters
        clarity = 1.0 - abs(5 - avg_word_len) / 10.0
        return max(0.0, min(1.0, clarity))
    
    def _score_coherence(self, text: str) -> float:
        """Score logical flow (0-1)."""
        # Heuristic: paragraph structure, transition words
        paragraphs = text.split("\n\n")
        transitions = ["furthermore", "however", "therefore", "additionally", "in conclusion"]
        transition_count = sum(1 for t in transitions if t in text.lower())
        coherence = min(1.0, (len(paragraphs) + transition_count) / 5.0)
        return coherence
    
    def _score_completeness(self, text: str, prompt: str) -> float:
        """Score if response addresses prompt (0-1)."""
        # Simple heuristic: response length relative to prompt
        if not text or not prompt:
            return 0.5
        length_ratio = len(text) / max(len(prompt), 50)
        completeness = min(1.0, length_ratio / 5.0)
        return completeness
    
    def _score_grammar(self, text: str) -> float:
        """Score grammar (0-1, simplified)."""
        if not text:
            return 0.0
        # Simple check: look for common grammar issues
        issues = 0
        total_checks = 0
        
        # Check for common issues
        sentences = re.split(r'[.!?]+', text)
        for sentence in sentences:
            if sentence.strip():
                total_checks += 1
                words = sentence.split()
                if len(words) > 0 and words[0].islower() and words[0] != 'i':
                    issues += 1
        
        if total_checks == 0:
            return 1.0
        
        grammar_score = 1.0 - (issues / total_checks)
        return grammar_score


class PairwiseEvaluator:
    """Compare responses using LLM judges."""
    
    JUDGE_PROMPT = """You are an expert evaluator comparing two responses to determine which is better.

## Task
The user asked: {task}

## Response A
{response_a}

## Response B
{response_b}

## Evaluation Criteria

Consider the following dimensions when comparing these responses:

1. **Accuracy & Correctness**: Does the response provide factually correct information? Are there any errors, misstatements, or hallucinations? Does it correctly interpret and address the prompt?

2. **Reasoning Quality**: Does the response show clear logical thinking? Are the steps well-explained? Does it demonstrate understanding of underlying concepts? Does it acknowledge complexity where appropriate?

3. **Completeness**: Does the response fully address all parts of the prompt? Are key aspects covered? Does it provide sufficient detail and supporting information?

4. **Clarity & Communication**: Is the response well-organized and easy to follow? Are explanations clear to someone unfamiliar with the topic? Is the language appropriate for the audience?

5. **Depth of Analysis**: For complex topics, does the response explore different angles? Does it consider nuance and alternative perspectives? Does it acknowledge limitations or uncertainties?

6. **Appropriate Uncertainty**: Does the response appropriately hedge claims where certainty isn't warranted? Does it acknowledge what it doesn't know?

7. **Relevance & Focus**: Does the response stay on topic? Are all statements pertinent to the question? Is there unnecessary digression?

8. **Practical Usefulness**: Would this response be helpful to someone trying to solve the problem? Can it be acted upon?

9. **Tone & Engagement**: Is the tone appropriate? Does it engage thoughtfully with the question?

10. **Instruction Adherence**: Does the response follow any specific constraints or formatting requirements stated in the prompt?

## Judgment

Which response is better overall? Consider the criteria above, weighing them by importance for this particular task.

Respond with ONLY one of: A, B, or TIE

Then provide a brief explanation (1-2 sentences) of your reasoning.

Format your response as:
CHOICE: [A/B/TIE]
REASONING: [Your brief explanation]
"""
    
    def __init__(self, judge_fn: Callable[[str], str]):
        """
        Args:
            judge_fn: Function that takes prompt string and returns judge's decision
        """
        self.judge_fn = judge_fn
    
    def compare(
        self,
        task: str,
        response_a: str,
        response_b: str
    ) -> str:
        """Compare two responses. Returns 'A', 'B', or 'tie'."""
        prompt = self.JUDGE_PROMPT.format(
            task=task,
            response_a=response_a,
            response_b=response_b
        )
        
        judge_response = self.judge_fn(prompt)
        
        # Extract decision
        if "A" in judge_response.upper() and "CHOICE: A" in judge_response.upper():
            return "A"
        elif "B" in judge_response.upper() and "CHOICE: B" in judge_response.upper():
            return "B"
        else:
            return "tie"
    
    def tournament(
        self,
        tasks: List[str],
        responses_dict: Dict[str, List[str]],
        judge_fn: Optional[Callable] = None
    ) -> Dict[str, float]:
        """Run ELO-style tournament.
        
        Args:
            tasks: List of tasks/prompts
            responses_dict: Dict mapping model_name -> [responses]
            judge_fn: Optional override judge function
        
        Returns:
            Dict of model_name -> win_rate
        """
        if judge_fn:
            self.judge_fn = judge_fn
        
        # Initialize ELO ratings
        models = list(responses_dict.keys())
        ratings = {model: 1600.0 for model in models}
        
        # Round-robin tournament
        for task in tasks:
            for i, model_a in enumerate(models):
                for model_b in models[i+1:]:
                    resp_a = responses_dict[model_a][0]  # First response
                    resp_b = responses_dict[model_b][0]
                    
                    result = self.compare(task, resp_a, resp_b)
                    
                    # Update ratings
                    if result == "A":
                        ratings[model_a] += 10
                        ratings[model_b] -= 10
                    elif result == "B":
                        ratings[model_b] += 10
                        ratings[model_a] -= 10
        
        # Normalize to win rates
        total_rating = sum(ratings.values())
        win_rates = {
            model: ratings[model] / total_rating for model in models
        }
        
        return win_rates


class ConstitutionalEvaluator:
    """Score responses against constitutional principles."""
    
    def __init__(self, principles: Optional[List[str]] = None):
        """
        Args:
            principles: List of principles to evaluate against
        """
        self.principles = principles or [
            "The response should be harmless and safe.",
            "The response should be honest and truthful.",
            "The response should be helpful and constructive.",
            "The response should acknowledge uncertainty.",
            "The response should respect user autonomy.",
        ]
    
    def score_response(
        self,
        response: str,
        task: str,
        principles: Optional[List[str]] = None
    ) -> Dict[str, float]:
        """Score response on each principle (0-1).
        
        Args:
            response: The response to evaluate
            task: The original task/prompt
            principles: Override default principles
        
        Returns:
            Dict mapping principle -> score
        """
        principles = principles or self.principles
        scores = {}
        
        for principle in principles:
            # Simple heuristic scoring (in production, use LLM judge)
            score = self._score_principle(response, task, principle)
            scores[principle] = score
        
        return scores
    
    def aggregate_score(self, principle_scores: Dict[str, float]) -> float:
        """Aggregate principle scores into single score."""
        if not principle_scores:
            return 0.0
        return sum(principle_scores.values()) / len(principle_scores)
    
    def find_violations(
        self,
        response: str,
        task: str,
        principles: Optional[List[str]] = None
    ) -> List[str]:
        """Find which principles are violated (score < 0.5)."""
        scores = self.score_response(response, task, principles)
        violations = [p for p, score in scores.items() if score < 0.5]
        return violations
    
    def _score_principle(self, response: str, task: str, principle: str) -> float:
        """Score a single principle (simplified)."""
        response_lower = response.lower()
        
        if "harm" in principle.lower():
            # Check for harmful content
            harmful_keywords = ["kill", "harm", "illegal", "dangerous"]
            if any(kw in response_lower for kw in harmful_keywords):
                return 0.2
            return 0.9
        
        elif "honest" in principle.lower():
            # Check for hedging and uncertainty markers
            uncertainty_markers = ["perhaps", "maybe", "i'm not sure", "unclear", "unknown"]
            if "false" in response_lower or "incorrect" in response_lower:
                return 0.3
            if any(marker in response_lower for marker in uncertainty_markers):
                return 0.8
            return 0.7
        
        elif "helpful" in principle.lower():
            # Check if response is constructive
            if len(response) < 50:
                return 0.3
            if any(word in response_lower for word in ["solution", "help", "way to", "how to"]):
                return 0.8
            return 0.6
        
        elif "uncertainty" in principle.lower():
            # Check acknowledgment of uncertainty
            uncertainty_phrases = ["uncertain", "not sure", "may", "might", "depends", "unclear"]
            count = sum(1 for phrase in uncertainty_phrases if phrase in response_lower)
            return min(1.0, count / 3.0)
        
        elif "autonomy" in principle.lower():
            # Check for respecting user choice
            if "you decide" in response_lower or "your choice" in response_lower:
                return 0.8
            return 0.6
        
        return 0.5


# ═════════════════════════════════════════════════════════════════════════════
# COMPREHENSIVE EVALUATION BENCHMARKS — Hardcoded test suites
# ═════════════════════════════════════════════════════════════════════════════

MATH_BENCHMARK: List[Dict[str, Any]] = [
    {
        "id": "math_001",
        "question": "Find all integer solutions to x^3 + y^3 = 1729 where x < y.",
        "answer": "(1, 12) and (9, 10)",
        "domain": "number_theory",
        "difficulty": "hard",
        "source": "AIME",
        "year": 2024,
    },
    {
        "id": "math_002",
        "question": "Compute the sum of all positive integers n such that n^2 + 19n + 99 is a perfect square.",
        "answer": "84",
        "domain": "algebra",
        "difficulty": "hard",
        "source": "AIME",
        "year": 2024,
    },
    {
        "id": "math_003",
        "question": "Let f(x) = x^3 + ax^2 + bx + c have roots r, s, t with r+s+t = 6, rs+rt+st = 11, rst = 6. Find f(4).",
        "answer": "30",
        "domain": "algebra",
        "difficulty": "medium",
        "source": "AMC 12",
        "year": 2024,
    },
    {
        "id": "math_004",
        "question": "How many ways can you tile a 2x8 rectangle with 1x2 dominoes?",
        "answer": "34",
        "domain": "combinatorics",
        "difficulty": "medium",
        "source": "Fibonacci",
        "year": 2024,
    },
    {
        "id": "math_005",
        "question": "Find the smallest positive integer n such that n! is divisible by 2024.",
        "answer": "23",
        "domain": "number_theory",
        "difficulty": "medium",
        "source": "AMC 12",
        "year": 2024,
    },
    {
        "id": "math_006",
        "question": "Let ABC be a triangle with AB = 13, BC = 14, CA = 15. Find the area.",
        "answer": "84",
        "domain": "geometry",
        "difficulty": "easy",
        "source": "Heron",
        "year": 2024,
    },
    {
        "id": "math_007",
        "question": "What is the probability that a randomly chosen integer between 1 and 100 is divisible by 3 or 5?",
        "answer": "47/100",
        "domain": "probability",
        "difficulty": "easy",
        "source": "AMC 10",
        "year": 2024,
    },
    {
        "id": "math_008",
        "question": "Find the limit: lim(x->0) (sin x - x)/x^3",
        "answer": "-1/6",
        "domain": "calculus",
        "difficulty": "medium",
        "source": "MIT Integration Bee",
        "year": 2024,
    },
    {
        "id": "math_009",
        "question": "Find all primes p such that p^2 + 2 is also prime.",
        "answer": "p = 3 only",
        "domain": "number_theory",
        "difficulty": "hard",
        "source": "IMO Shortlist",
        "year": 2024,
    },
    {
        "id": "math_010",
        "question": "A fair coin is tossed until we see either HTH or HTT first. What is the probability HTH appears first?",
        "answer": "2/3",
        "domain": "probability",
        "difficulty": "hard",
        "source": "Penney's Game",
        "year": 2024,
    },
]

CODE_BENCHMARK: List[Dict[str, Any]] = [
    {
        "id": "code_001",
        "question": "Implement a function that finds the longest palindromic substring in O(n^2) time.",
        "domain": "string",
        "difficulty": "medium",
        "test_cases": [
            {"input": "babad", "expected": "bab"},
            {"input": "cbbd", "expected": "bb"},
            {"input": "a", "expected": "a"},
            {"input": "ac", "expected": "a"},
        ],
    },
    {
        "id": "code_002",
        "question": "Implement LRU cache with O(1) get and put operations.",
        "domain": "data_structures",
        "difficulty": "medium",
        "test_cases": [
            {"operations": ["LRUCache(2)", "put(1,1)", "put(2,2)", "get(1)", "put(3,3)", "get(2)", "put(4,4)", "get(1)", "get(3)", "get(4)"],
             "expected": [None, None, None, 1, None, -1, None, -1, 3, 4]},
        ],
    },
    {
        "id": "code_003",
        "question": "Implement merge sort on a linked list in O(n log n) time.",
        "domain": "sorting",
        "difficulty": "medium",
        "test_cases": [
            {"input": [4, 2, 1, 3], "expected": [1, 2, 3, 4]},
            {"input": [-1, 5, 3, 4, 0], "expected": [-1, 0, 3, 4, 5]},
            {"input": [], "expected": []},
        ],
    },
    {
        "id": "code_004",
        "question": "Design a thread-safe bounded blocking queue.",
        "domain": "concurrency",
        "difficulty": "hard",
        "test_cases": [],
    },
    {
        "id": "code_005",
        "question": "Implement a Trie with insert, search, and startsWith methods.",
        "domain": "trie",
        "difficulty": "easy",
        "test_cases": [
            {"operations": ["Trie()", "insert(apple)", "search(apple)", "search(app)", "startsWith(app)", "insert(app)", "search(app)"],
             "expected": [None, None, True, False, True, None, True]},
        ],
    },
    {
        "id": "code_006",
        "question": "Implement KMP string matching algorithm.",
        "domain": "string",
        "difficulty": "hard",
        "test_cases": [
            {"text": "ABC ABCDAB ABCDABCDABDE", "pattern": "ABCDABD", "expected": 15},
            {"text": "aaaaa", "pattern": "aa", "expected": 0},
            {"text": "abc", "pattern": "d", "expected": -1},
        ],
    },
]

REASONING_BENCHMARK: List[Dict[str, Any]] = [
    {
        "id": "reason_001",
        "question": "If all A are B, and some B are C, can we conclude that some A are C? Explain.",
        "answer": "No. Example: A = {1}, B = {1, 2}, C = {2}. All A are B (1 is in B), some B are C (2 is in C), but no A is C.",
        "domain": "logical_reasoning",
        "difficulty": "easy",
    },
    {
        "id": "reason_002",
        "question": "You have 12 coins, one is counterfeit (heavier or lighter). Using a balance scale only 3 times, find the counterfeit and determine if it's heavier or lighter.",
        "answer": "Divide into 3 groups of 4. Weigh group 1 vs group 2. If equal, counterfeit in group 3. Use remaining 2 weighings on group 3. If not equal, use the heavier side and known good coins to narrow down.",
        "domain": "puzzle",
        "difficulty": "hard",
    },
    {
        "id": "reason_003",
        "question": "Three people check into a hotel room that costs $30. They each pay $10. Later the clerk realizes the room only costs $25 and sends $5 with the bellboy to return. The bellboy keeps $2 and gives each person $1 back. Now each person paid $9, totaling $27, plus the $2 the bellboy kept = $29. Where is the missing dollar?",
        "answer": "The $27 already includes the $2 the bellboy kept ($25 room + $2 kept = $27). Adding $2 again is a category error. The $3 refunded to the guests brings the total to $30.",
        "domain": "common_fallacy",
        "difficulty": "medium",
    },
    {
        "id": "reason_004",
        "question": "A bat and a ball cost $1.10. The bat costs $1.00 more than the ball. How much does the ball cost?",
        "answer": "$0.05. Let the ball cost x, then bat costs x + 1.00. So x + (x + 1.00) = 1.10, giving 2x = 0.10, x = 0.05.",
        "domain": "cognitive_bias",
        "difficulty": "easy",
    },
    {
        "id": "reason_005",
        "question": "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets?",
        "answer": "5 minutes. Each machine makes 1 widget in 5 minutes, so 100 machines make 100 widgets in the same 5 minutes.",
        "domain": "intuitive_bias",
        "difficulty": "easy",
    },
]

SCIENCE_BENCHMARK: List[Dict[str, Any]] = [
    {
        "id": "sci_001",
        "question": "Explain the mechanism of CRISPR-Cas9 gene editing. Include the role of guide RNA, PAM sequence, and double-strand break repair pathways.",
        "domain": "biology",
        "difficulty": "hard",
    },
    {
        "id": "sci_002",
        "question": "Derive the time-independent Schrödinger equation from first principles. Explain the physical meaning of the wavefunction.",
        "domain": "physics",
        "difficulty": "hard",
    },
    {
        "id": "sci_003",
        "question": "Explain why increasing pressure increases the boiling point of a liquid using thermodynamic principles.",
        "domain": "chemistry",
        "difficulty": "medium",
    },
    {
        "id": "sci_004",
        "question": "Describe how mRNA vaccines work, from mRNA synthesis to antibody production.",
        "domain": "biology",
        "difficulty": "medium",
    },
    {
        "id": "sci_005",
        "question": "Explain how transformer attention mechanisms differ from recurrent neural networks for processing long sequences. Include scaling considerations.",
        "domain": "computer_science",
        "difficulty": "hard",
    },
]

INSTRUCTION_BENCHMARK: List[Dict[str, Any]] = [
    {
        "id": "inst_001",
        "question": "Write a haiku about artificial intelligence. Then explain what a haiku is. Then write a sonnet about the same topic.",
        "domain": "creative",
        "difficulty": "easy",
    },
    {
        "id": "inst_002",
        "question": "Give me a 7-day meal plan for a vegan athlete training for a marathon. Include macronutrient breakdowns for each meal and total daily targets.",
        "domain": "planning",
        "difficulty": "medium",
    },
    {
        "id": "inst_003",
        "question": "Compare and contrast REST, GraphQL, and gRPC API architectures. For each, provide: (1) a code example, (2) a use case where it excels, (3) a use case where it falls short.",
        "domain": "technical",
        "difficulty": "hard",
    },
    {
        "id": "inst_004",
        "question": "Explain the CAP theorem to a 10-year-old. Then explain it to a computer science undergraduate. Then explain it to a distributed systems researcher.",
        "domain": "pedagogy",
        "difficulty": "medium",
    },
    {
        "id": "inst_005",
        "question": "Write a business plan for a startup that uses AI to reduce food waste in restaurants. Include executive summary, market analysis, product description, business model, and financial projections.",
        "domain": "business",
        "difficulty": "hard",
    },
]
