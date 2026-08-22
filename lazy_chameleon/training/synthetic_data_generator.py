"""
Synthetic Training Data Generator for fine-tuning DeepSeek Flash to Opus-level.

Generates high-quality instruction + chain-of-thought + response triples using
teacher models (Claude Opus). Includes comprehensive task taxonomies, quality
filtering, deduplication, augmentation, and export capabilities.
"""

import json
import re
import hashlib
import random
import time
import os
from pathlib import Path
from dataclasses import dataclass, asdict, field
from typing import Callable, Optional, Dict, List, Tuple, Set
from collections import defaultdict
from enum import Enum


class Difficulty(str, Enum):
    """Difficulty levels for synthetic tasks."""
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"
    FRONTIER = "frontier"


class Domain(str, Enum):
    """Primary task domains."""
    MATH = "math"
    CODING = "coding"
    REASONING = "reasoning"
    SCIENCE = "science"
    WRITING = "writing"
    ANALYSIS = "analysis"
    INSTRUCTION_FOLLOWING = "instruction_following"
    SAFETY = "safety"


@dataclass
class DataPoint:
    """A single synthetic training example with full provenance."""
    instruction: str
    chain_of_thought: str
    response: str
    domain: Domain
    task_type: str
    difficulty: Difficulty
    quality_score: float
    teacher_model: str
    metadata: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "instruction": self.instruction,
            "chain_of_thought": self.chain_of_thought,
            "response": self.response,
            "domain": self.domain.value,
            "task_type": self.task_type,
            "difficulty": self.difficulty.value,
            "quality_score": self.quality_score,
            "teacher_model": self.teacher_model,
            "metadata": self.metadata,
        }

    def get_hash(self) -> str:
        """Get unique hash of instruction + response for deduplication."""
        content = f"{self.instruction}||{self.response}".encode()
        return hashlib.sha256(content).hexdigest()

    def get_shingles(self, k: int = 4) -> Set[str]:
        """Get k-shingles for similarity detection."""
        text = self.instruction.lower()
        words = text.split()
        shingles = set()
        for i in range(len(words) - k + 1):
            shingle = " ".join(words[i : i + k])
            shingles.add(shingle)
        return shingles


class TaskTaxonomy:
    """
    Comprehensive task taxonomy with 50+ task types across 8 domains.
    Each task type includes seed templates, difficulty tiers, and constitutional tags.
    """

    # Math domain (8 tasks)
    MATH_TASKS = {
        "arithmetic": {
            "name": "Basic Arithmetic",
            "description": "Elementary arithmetic operations",
            "tags": ["mathematical", "computational"],
            "templates": [
                "Calculate {operation} of {num1} and {num2}.",
                "What is {num1} {op_symbol} {num2}?",
                "Solve: {num1} {op_symbol} {num2} = ?",
                "Find the result of {operation} when {num1} is combined with {num2}.",
                "Evaluate {num1} {op_symbol} {num2} step by step.",
            ]
        },
        "algebra": {
            "name": "Algebraic Equations",
            "description": "Solving linear and quadratic equations",
            "tags": ["mathematical", "algebraic", "reasoning"],
            "templates": [
                "Solve for x: {equation}",
                "Find all solutions to {equation} = 0",
                "Simplify the expression: {expression}",
                "Expand and simplify: {expression}",
                "Factor completely: {polynomial}",
            ]
        },
        "geometry": {
            "name": "Geometry Problems",
            "description": "2D and 3D geometry, proofs, calculations",
            "tags": ["mathematical", "spatial", "reasoning"],
            "templates": [
                "A {shape} has {property1} and {property2}. Calculate {metric}.",
                "In triangle ABC with sides {side1}, {side2}, {side3}, find {unknown}.",
                "Prove that {geometric_property} in a {shape}.",
                "A sphere with radius {radius} has what {metric}?",
                "Calculate the area/volume of {shape} given {constraints}.",
            ]
        },
        "combinatorics": {
            "name": "Combinatorics & Counting",
            "description": "Permutations, combinations, counting problems",
            "tags": ["mathematical", "combinatorial", "reasoning"],
            "templates": [
                "How many ways can {objects} be {operation}?",
                "Calculate the number of {combination_type} of {items} taken {k} at a time.",
                "In how many ways can {scenario} occur?",
                "Find the {metric} of arrangements of {elements} with {constraint}.",
                "There are {total} objects. How many subsets have exactly {size} elements?",
            ]
        },
        "number_theory": {
            "name": "Number Theory",
            "description": "Primes, divisibility, modular arithmetic, GCD/LCM",
            "tags": ["mathematical", "number-theoretic"],
            "templates": [
                "Find the GCD of {num1} and {num2}.",
                "Find the LCM of {num1} and {num2}.",
                "Prove that {number} is prime or composite.",
                "What is the remainder when {num1} is divided by {num2}?",
                "Find all prime factors of {number}.",
            ]
        },
        "calculus": {
            "name": "Calculus",
            "description": "Derivatives, integrals, limits",
            "tags": ["mathematical", "analytical", "reasoning"],
            "templates": [
                "Find the derivative of {function} with respect to {variable}.",
                "Integrate {function} with respect to {variable}.",
                "Find the limit of {function} as {variable} approaches {value}.",
                "Compute the definite integral of {function} from {lower} to {upper}.",
                "Find the critical points of {function}.",
            ]
        },
        "statistics": {
            "name": "Statistics & Probability",
            "description": "Distributions, expected values, statistical tests",
            "tags": ["mathematical", "probabilistic", "analytical"],
            "templates": [
                "A dataset has {description}. Calculate the {statistic}.",
                "Given a {distribution}, what is the probability that {event}?",
                "Calculate the {metric} of the dataset: {data}.",
                "If an event has probability {prob}, what is the probability of {related_event}?",
                "Perform a {test_type} test to determine if {hypothesis}.",
            ]
        },
        "optimization": {
            "name": "Optimization Problems",
            "description": "Linear programming, calculus optimization",
            "tags": ["mathematical", "optimization", "reasoning"],
            "templates": [
                "Maximize {objective} subject to {constraints}.",
                "Minimize {objective} subject to {constraints}.",
                "Find the optimal value of {variable} in {scenario}.",
                "What strategy {action} maximizes/minimizes {outcome}?",
                "Solve the linear program: maximize {obj} subject to {constraints}.",
            ]
        }
    }

    # Coding domain (7 tasks)
    CODING_TASKS = {
        "data_structures": {
            "name": "Data Structures",
            "description": "Arrays, lists, trees, graphs, hash tables",
            "tags": ["coding", "data-structures", "implementation"],
            "templates": [
                "Write a function to {operation} on a {data_structure}.",
                "Implement a {ds_name} class with methods: {methods}.",
                "Given a {data_structure}, write code to {task}.",
                "Design a data structure that supports {operations}.",
                "How would you implement {ds_name} efficiently?",
            ]
        },
        "algorithms": {
            "name": "Algorithms",
            "description": "Sorting, searching, dynamic programming, graph algorithms",
            "tags": ["coding", "algorithms", "reasoning"],
            "templates": [
                "Write an efficient algorithm to {problem}.",
                "Implement {algorithm_name} to solve {problem}.",
                "The input is {input_desc}. Output should be {output_desc}.",
                "What is the time complexity of {algorithm}? Can you optimize it?",
                "Write code using {technique} to solve {problem}.",
            ]
        },
        "string_processing": {
            "name": "String Processing",
            "description": "Pattern matching, parsing, text algorithms",
            "tags": ["coding", "strings", "implementation"],
            "templates": [
                "Write a function to {operation} in a string.",
                "Implement {algorithm} for {problem}.",
                "Given a string {example}, {task}.",
                "Parse the input format: {format_description}.",
                "Write code to validate/process {string_type}.",
            ]
        },
        "system_design": {
            "name": "System Design",
            "description": "Architecture, scalability, databases, APIs",
            "tags": ["coding", "system-design", "reasoning"],
            "templates": [
                "Design a system for {use_case}. Consider {aspects}.",
                "How would you architect {service} to handle {scale}?",
                "What trade-offs would you make in a {system} for {goal}?",
                "Design the API for {feature} including {requirements}.",
                "Propose a database schema for {application}.",
            ]
        },
        "debugging": {
            "name": "Debugging & Code Analysis",
            "description": "Finding and fixing bugs, code review",
            "tags": ["coding", "debugging", "reasoning"],
            "templates": [
                "Debug this code: {code_snippet}. The bug is causing {symptom}.",
                "What is wrong with this implementation of {function}?",
                "Analyze this code and suggest improvements: {code}.",
                "Trace through this program with input {input} and find the bug.",
                "Review this code for {issues}: {code_snippet}.",
            ]
        },
        "oop_design": {
            "name": "Object-Oriented Design",
            "description": "Classes, inheritance, design patterns, SOLID principles",
            "tags": ["coding", "oop", "design"],
            "templates": [
                "Design classes for {domain} with relationships {rels}.",
                "How would you implement {design_pattern} for {use_case}?",
                "Write classes that satisfy these requirements: {reqs}.",
                "Refactor this procedural code into {pattern_type} design.",
                "Apply {principle} to improve this object hierarchy.",
            ]
        },
        "performance": {
            "name": "Performance Optimization",
            "description": "Profiling, optimization, resource usage",
            "tags": ["coding", "optimization", "reasoning"],
            "templates": [
                "Optimize this code for {metric}: {code}.",
                "What is the {complexity_type} complexity of {function}?",
                "How would you reduce {resource} usage in {scenario}?",
                "Propose optimizations for this bottleneck: {description}.",
                "Compare the performance of {approach1} vs {approach2}.",
            ]
        }
    }

    # Reasoning domain (7 tasks)
    REASONING_TASKS = {
        "logical_deduction": {
            "name": "Logical Deduction",
            "description": "Deductive reasoning, formal logic, syllogisms",
            "tags": ["reasoning", "logical", "analytical"],
            "templates": [
                "Given: {premise1}. {premise2}. Therefore, {conclusion}?",
                "Is this logical: {statement}? Explain your reasoning.",
                "Which statement must be true: {options}. Why?",
                "Determine if the argument is valid: {argument}.",
                "Apply logical inference to conclude: {premises}.",
            ]
        },
        "inductive_reasoning": {
            "name": "Inductive Reasoning",
            "description": "Pattern recognition, generalization, sequence prediction",
            "tags": ["reasoning", "pattern-based", "analytical"],
            "templates": [
                "Continue the sequence: {sequence}. What's next?",
                "Identify the pattern in {data} and apply it to {scenario}.",
                "What is the rule for {pattern_type}?",
                "Given examples {examples}, what can you infer?",
                "Predict the next {k} elements based on {pattern}.",
            ]
        },
        "abductive_reasoning": {
            "name": "Abductive Reasoning",
            "description": "Inference to best explanation, hypothesis formation",
            "tags": ["reasoning", "inference", "analytical"],
            "templates": [
                "Given {observations}, what is the most likely explanation?",
                "What hypothesis best explains {evidence}?",
                "If {observation} is true, what must have caused it?",
                "Among these theories {theories}, which best fits {data}?",
                "Propose the most plausible scenario for {situation}.",
            ]
        },
        "analogy_reasoning": {
            "name": "Analogy & Proportional Reasoning",
            "description": "Analogy solving, similarity mapping",
            "tags": ["reasoning", "analogical", "comparative"],
            "templates": [
                "{A} is to {B} as {C} is to what?",
                "The relationship {rel1} is analogous to {rel2}. Explain the parallel.",
                "How are {thing1} and {thing2} similar? How are they different?",
                "Complete the analogy: {A}:{B}::{C}:{D}.",
                "This scenario is like {analogy}. What does that tell us?",
            ]
        },
        "critical_thinking": {
            "name": "Critical Thinking & Argument Analysis",
            "description": "Identifying fallacies, evaluating arguments, assumptions",
            "tags": ["reasoning", "critical", "analytical"],
            "templates": [
                "Evaluate this argument: {argument}. Identify any fallacies.",
                "What assumptions underlie {claim}?",
                "Is this reasoning sound? {reasoning}. Why or why not?",
                "What is the main issue with this argument: {argument}?",
                "Identify hidden premises in: {statement}.",
            ]
        },
        "counterfactual_reasoning": {
            "name": "Counterfactual Reasoning",
            "description": "What-if scenarios, causal reasoning",
            "tags": ["reasoning", "hypothetical", "causal"],
            "templates": [
                "If {condition} were true instead of false, what would happen?",
                "Given {scenario}, what would change if {alternative}?",
                "Suppose {hypothetical}. How would {outcome} be different?",
                "What would be necessary for {outcome} to occur in {scenario}?",
                "Trace the counterfactual chain: if {event}, then {result}.",
            ]
        },
        "decision_making": {
            "name": "Decision Making & Planning",
            "description": "Cost-benefit analysis, strategy, problem-solving",
            "tags": ["reasoning", "strategic", "analytical"],
            "templates": [
                "Given constraints {constraints}, what's the best {decision}?",
                "Compare options {option1} and {option2}. Which is better for {goal}?",
                "Plan a strategy to {achieve_goal} considering {factors}.",
                "What factors should influence {decision} in {context}?",
                "Recommend a course of action for {problem}.",
            ]
        }
    }

    # Science domain (7 tasks)
    SCIENCE_TASKS = {
        "physics": {
            "name": "Physics",
            "description": "Mechanics, thermodynamics, electromagnetism, relativity",
            "tags": ["science", "physics", "analytical"],
            "templates": [
                "A {object} with {properties} {action}. Calculate {metric}.",
                "Explain the physics of {phenomenon} in {context}.",
                "Apply {law} to calculate {quantity} in {scenario}.",
                "A particle/object experiences {forces}. What is {outcome}?",
                "Derive/explain {physics_principle} and its implications.",
            ]
        },
        "chemistry": {
            "name": "Chemistry",
            "description": "Reactions, molecular structure, stoichiometry",
            "tags": ["science", "chemistry", "analytical"],
            "templates": [
                "Balance the chemical equation: {equation}.",
                "What is the product of {reactants} reacting in {conditions}?",
                "Calculate {metric} for {molecule} with {composition}.",
                "Explain the {reaction_type} mechanism for {reaction}.",
                "Determine the {property} of {compound} given {data}.",
            ]
        },
        "biology": {
            "name": "Biology",
            "description": "Genetics, evolution, cellular biology, ecology",
            "tags": ["science", "biology", "analytical"],
            "templates": [
                "If an organism has {genotype}, what phenotype would it express?",
                "Explain how {biological_process} works.",
                "Trace the {pathway} through an organism with {characteristics}.",
                "How would {evolutionary_pressure} affect {population}?",
                "Analyze {ecological_scenario} and predict {outcome}.",
            ]
        },
        "earth_science": {
            "name": "Earth & Environmental Science",
            "description": "Geology, meteorology, climate, ecosystems",
            "tags": ["science", "earth-science", "analytical"],
            "templates": [
                "Explain the formation of {geological_feature}.",
                "How does {process} affect {climate_outcome}?",
                "Analyze {environmental_scenario} and its implications.",
                "What factors influence {phenomenon} in {region}?",
                "Describe the cycle of {process} in {system}.",
            ]
        },
        "scientific_method": {
            "name": "Scientific Method & Experimental Design",
            "description": "Hypothesis formation, experimental design, data analysis",
            "tags": ["science", "methodology", "analytical"],
            "templates": [
                "Design an experiment to test: {hypothesis}.",
                "Given {observation}, propose a testable hypothesis.",
                "Identify {aspect} in this experiment: {description}.",
                "How would you control for {variable} in {experiment}?",
                "Analyze these results {data} from {experiment}.",
            ]
        },
        "astronomy": {
            "name": "Astronomy & Astrophysics",
            "description": "Celestial mechanics, stellar evolution, cosmology",
            "tags": ["science", "astronomy", "analytical"],
            "templates": [
                "Calculate {metric} for a {object} with {properties}.",
                "Explain the phenomenon of {astronomical_event}.",
                "What physical principles govern {cosmic_process}?",
                "How would {object} appear from {location}?",
                "Trace the {evolutionary_path} of {celestial_object}.",
            ]
        },
        "interdisciplinary_science": {
            "name": "Interdisciplinary Science",
            "description": "Cross-domain problems integrating multiple sciences",
            "tags": ["science", "interdisciplinary", "reasoning"],
            "templates": [
                "A {scenario} involves {fields}. How do they interact?",
                "Integrate {field1} and {field2} to explain {phenomenon}.",
                "How do {physical_process} and {biological_process} interact?",
                "Analyze {complex_system} considering {factors} from multiple disciplines.",
                "What role does {process} play in both {context1} and {context2}?",
            ]
        }
    }

    # Writing domain (6 tasks)
    WRITING_TASKS = {
        "creative_writing": {
            "name": "Creative Writing",
            "description": "Stories, narrative, character development",
            "tags": ["writing", "creative", "linguistic"],
            "templates": [
                "Write a {genre} story that includes {elements}.",
                "Create a narrative about {topic} from {perspective}.",
                "Develop a character who {trait} and must {challenge}.",
                "Write a scene where {event} happens with {atmosphere}.",
                "Compose a {literary_form} about {theme}.",
            ]
        },
        "technical_writing": {
            "name": "Technical Writing",
            "description": "Documentation, explanations, instructions",
            "tags": ["writing", "technical", "instructional"],
            "templates": [
                "Write documentation for {component} that explains {aspects}.",
                "Compose clear instructions for {task} considering {audience}.",
                "Explain the {concept} in {style} for {audience}.",
                "Write a technical summary of {topic} for {purpose}.",
                "Create a guide to {subject} covering {sections}.",
            ]
        },
        "persuasive_writing": {
            "name": "Persuasive Writing & Rhetoric",
            "description": "Arguments, essays, persuasion",
            "tags": ["writing", "persuasive", "rhetorical"],
            "templates": [
                "Write an essay arguing that {position} is {stance}.",
                "Construct an argument for {claim} using {evidence_types}.",
                "Persuade a {audience} that {topic} matters because {reason}.",
                "Compose a rebuttal to the argument that {opposing_view}.",
                "Write a {form} that advocates for {position}.",
            ]
        },
        "descriptive_writing": {
            "name": "Descriptive & Expressive Writing",
            "description": "Vivid description, sensory language, mood",
            "tags": ["writing", "descriptive", "linguistic"],
            "templates": [
                "Describe {object/scene} in vivid detail emphasizing {aspect}.",
                "Write a passage that evokes the feeling of {emotion}.",
                "Capture the {mood} of {setting} using sensory language.",
                "Describe {subject} from {perspective} with focus on {details}.",
                "Compose a {style} description that makes the reader {feel}.",
            ]
        },
        "dialogue_writing": {
            "name": "Dialogue Writing",
            "description": "Character dialogue, conversation, interaction",
            "tags": ["writing", "dialogue", "linguistic"],
            "templates": [
                "Write dialogue between {characters} discussing {topic}.",
                "Create a conversation where {conflict/event} occurs.",
                "Compose an exchange that reveals {character_trait} about {character}.",
                "Write dialogue that {purpose} and sounds natural.",
                "Script a scene where {characters} {interaction}.",
            ]
        },
        "editorial_writing": {
            "name": "Editorial & Opinion Writing",
            "description": "Op-eds, reviews, commentary",
            "tags": ["writing", "editorial", "analytical"],
            "templates": [
                "Write an op-ed about {issue} from {perspective}.",
                "Compose a review of {work} addressing {criteria}.",
                "Write a commentary on {event} explaining {aspect}.",
                "Compose an editorial taking a stance on {topic}.",
                "Write analysis of {subject} considering {viewpoints}.",
            ]
        }
    }

    # Analysis domain (7 tasks)
    ANALYSIS_TASKS = {
        "textual_analysis": {
            "name": "Textual Analysis",
            "description": "Literary analysis, rhetorical analysis, content analysis",
            "tags": ["analysis", "textual", "analytical"],
            "templates": [
                "Analyze {text} for {aspects} (theme, symbolism, style, etc.).",
                "How does the author use {technique} in {text}?",
                "What is the purpose of {rhetorical_device} in this passage: {excerpt}?",
                "Identify and explain {literary_element} in {work}.",
                "Dissect the argument in {text} and evaluate its strength.",
            ]
        },
        "data_analysis": {
            "name": "Data Analysis & Interpretation",
            "description": "Statistical analysis, trend identification, visualization",
            "tags": ["analysis", "data", "analytical"],
            "templates": [
                "Analyze this dataset {description} to find {insight}.",
                "What patterns emerge in {data}? What do they suggest?",
                "Compare {group1} and {group2} using {metric}.",
                "Interpret the significance of {result} in {context}.",
                "Create a narrative from {data} that explains {phenomenon}.",
            ]
        },
        "historical_analysis": {
            "name": "Historical Analysis",
            "description": "Historical events, causation, impact",
            "tags": ["analysis", "historical", "analytical"],
            "templates": [
                "Analyze the causes and consequences of {historical_event}.",
                "How did {factor} influence {outcome} during {period}?",
                "Compare {event1} and {event2} regarding {aspect}.",
                "What would have been different if {counterfactual} had occurred?",
                "Evaluate the significance of {historical_figure} in {context}.",
            ]
        },
        "comparative_analysis": {
            "name": "Comparative Analysis",
            "description": "Comparing concepts, objects, ideas",
            "tags": ["analysis", "comparative", "analytical"],
            "templates": [
                "Compare and contrast {item1} and {item2} focusing on {aspects}.",
                "How are {concepts} similar and different?",
                "Which approach {approach1} or {approach2} is superior for {goal}?",
                "Analyze the relationship between {entities}.",
                "Identify commonalities and differences in {domains}.",
            ]
        },
        "causal_analysis": {
            "name": "Causal Analysis",
            "description": "Cause-effect relationships, root cause analysis",
            "tags": ["analysis", "causal", "reasoning"],
            "templates": [
                "What are the root causes of {phenomenon}?",
                "Trace the causal chain leading to {outcome}.",
                "How does {factor} cause or contribute to {effect}?",
                "Identify direct and indirect causes in {situation}.",
                "Analyze the mechanism by which {cause} produces {effect}.",
            ]
        },
        "ethical_analysis": {
            "name": "Ethical Analysis",
            "description": "Moral reasoning, ethical frameworks, dilemmas",
            "tags": ["analysis", "ethical", "reasoning"],
            "templates": [
                "Analyze {ethical_scenario} using {ethical_framework}.",
                "What are the ethical implications of {action}?",
                "Discuss the moral dimensions of {dilemma}.",
                "Apply {principle} to evaluate {decision}.",
                "Compare how {frameworks} address {ethical_issue}.",
            ]
        },
        "systems_analysis": {
            "name": "Systems Analysis",
            "description": "Complex systems, feedback loops, emergence",
            "tags": ["analysis", "systems", "analytical"],
            "templates": [
                "Analyze {system} identifying components and interactions.",
                "How do {elements} interact in {system}?",
                "What feedback loops operate in {system}?",
                "How would changing {variable} cascade through {system}?",
                "Explain emergent properties in {complex_system}.",
            ]
        }
    }

    # Instruction Following domain (6 tasks)
    INSTRUCTION_FOLLOWING_TASKS = {
        "precise_following": {
            "name": "Precise Instruction Following",
            "description": "Exact requirements, specific formats",
            "tags": ["instruction-following", "precision"],
            "templates": [
                "Follow these exact steps: {steps}. Do not deviate.",
                "Complete this task exactly as specified: {specification}.",
                "You must {requirement1}, {requirement2}, and {requirement3}.",
                "Format your response as: {format}. Include all {elements}.",
                "Answer in the form of {format} with exactly {constraints}.",
            ]
        },
        "multi_step": {
            "name": "Multi-Step Instructions",
            "description": "Complex, sequential procedures",
            "tags": ["instruction-following", "procedural"],
            "templates": [
                "First, {step1}. Then, {step2}. Finally, {step3}.",
                "To accomplish {goal}, perform these steps in order: {steps}.",
                "Walk through the process of {procedure} step-by-step.",
                "Follow this recipe/procedure for {outcome}: {detailed_steps}.",
                "Execute this workflow: {workflow} ensuring {constraint}.",
            ]
        },
        "conditional_execution": {
            "name": "Conditional & Contextual Following",
            "description": "If-then logic, context-dependent instructions",
            "tags": ["instruction-following", "conditional"],
            "templates": [
                "If {condition}, then {action}. Otherwise, {alternative}.",
                "Given the context {context}, {task}. Adjust your approach if {scenario}.",
                "Perform {task} but skip {step} if {condition} is true.",
                "Depending on {factor}, {instruction1} or {instruction2}.",
                "Adapt your response based on {criteria}: {options}.",
            ]
        },
        "constraint_satisfaction": {
            "name": "Constraint Satisfaction",
            "description": "Working within specific limitations",
            "tags": ["instruction-following", "constraints"],
            "templates": [
                "Complete {task} using only {resources}.",
                "Answer within {constraint} (word limit, length, format, etc).",
                "Solve {problem} without using {forbidden_method}.",
                "Provide {output} that satisfies: {constraints}.",
                "Generate {item} subject to: {restrictions}.",
            ]
        },
        "role_based": {
            "name": "Role-Based Instructions",
            "description": "Taking on specific personas or roles",
            "tags": ["instruction-following", "roleplay"],
            "templates": [
                "As a {role}, how would you {task}?",
                "You are a {persona}. {instruction}",
                "Respond as {character} would, focusing on {aspect}.",
                "Take the perspective of {viewpoint} and {task}.",
                "Adopt the mindset of {role} and explain {concept}.",
            ]
        },
        "quality_standards": {
            "name": "Quality & Style Standards",
            "description": "Meeting quality criteria and stylistic requirements",
            "tags": ["instruction-following", "quality"],
            "templates": [
                "Provide a {quality_level} answer to {question}.",
                "Write in the style of {style_descriptor}.",
                "Ensure your response is {quality_criteria} and {tone}.",
                "Meet these quality standards: {standards}.",
                "Your answer should be {descriptors} appropriate for {audience}.",
            ]
        }
    }

    # Safety domain (6 tasks)
    SAFETY_TASKS = {
        "refusal_handling": {
            "name": "Appropriate Refusal",
            "description": "Refusing harmful requests while being helpful",
            "tags": ["safety", "refusal", "ethical"],
            "templates": [
                "I can't help with {harmful_request}. But I can help with {alternative}.",
                "I won't {forbidden_action}, but here's what I can do instead: {helpful_alternative}.",
                "That request is {why_problematic}. Let me suggest a safe approach: {alternative}.",
                "I can't provide {restricted_content} because {reason}. Here's help with the underlying need: {solution}.",
                "Rather than {harmful}, let me help you {constructive_alternative}.",
            ]
        },
        "harm_mitigation": {
            "name": "Harm Mitigation",
            "description": "Minimizing potential harms in responses",
            "tags": ["safety", "mitigation", "ethical"],
            "templates": [
                "If you choose to {risky_action}, here are critical safety considerations: {precautions}.",
                "For {potentially_risky_topic}, it's important to know: {safety_info}.",
                "Before attempting {action}, be aware of {risks} and {mitigations}.",
                "While I can discuss {topic}, emphasize that {safety_caveat}.",
                "To minimize harm when {scenario}, follow these guidelines: {guidelines}.",
            ]
        },
        "bias_awareness": {
            "name": "Bias Detection & Mitigation",
            "description": "Recognizing and countering biases",
            "tags": ["safety", "bias", "awareness"],
            "templates": [
                "The statement '{biased_statement}' contains {bias_type} bias. Here's a more balanced view: {balanced}.",
                "This approach overlooks {group/perspective}. A more inclusive framing: {inclusive}.",
                "Be aware that conventional wisdom about {topic} often reflects {bias}. Actually, {truth}.",
                "Avoid the tendency to {bias_pattern}. Instead, consider {balanced_view}.",
                "This situation involves {underrepresented_perspective}. Don't overlook {important_factor}.",
            ]
        },
        "factual_accuracy": {
            "name": "Factual Accuracy & Epistemic Humility",
            "description": "Accuracy, uncertainty acknowledgment",
            "tags": ["safety", "accuracy", "epistemic"],
            "templates": [
                "Regarding {claim}, the evidence shows {accurate_info}. However, {caveat}.",
                "I'm not certain about {topic}, but the best available evidence suggests {tentative}.",
                "Common misconception: {misconception}. Actually, {fact}.",
                "This is still an open question in {field}, but current research indicates {current_understanding}.",
                "I don't have reliable information about {topic}. What I can say about related {related_topic}: {info}.",
            ]
        },
        "privacy_ethics": {
            "name": "Privacy & Confidentiality Ethics",
            "description": "Respecting privacy, not revealing sensitive info",
            "tags": ["safety", "privacy", "ethical"],
            "templates": [
                "I can't share {private_information} because it's confidential. What I can discuss: {public_aspect}.",
                "That would violate someone's privacy. Instead, I can help with {alternative}.",
                "For privacy reasons, I won't {action}. But I can assist with {ethical_alternative}.",
                "The {private_detail} would be confidential. Here's how to handle the public aspects: {guidance}.",
                "Rather than disclosing {private_info}, let me help you: {helpful_action}.",
            ]
        },
        "value_alignment": {
            "name": "Value Alignment & Pluralism",
            "description": "Respecting diverse values while maintaining ethics",
            "tags": ["safety", "values", "ethical"],
            "templates": [
                "People hold different views on {value_topic}. Respectfully, {view1} vs {view2}. I focus on {shared_values}.",
                "This involves different value systems. Rather than imposing values, I can help you think through: {framework}.",
                "While some believe {perspective1}, others believe {perspective2}. The ethical common ground is: {common_ground}.",
                "This involves values different people prioritize differently. Here's a balanced approach: {approach}.",
                "Regarding {ethical_issue}, multiple viewpoints exist, but these principles matter universally: {principles}.",
            ]
        }
    }

    @classmethod
    def get_all_tasks(cls) -> Dict[str, Dict]:
        """Get all tasks organized by domain."""
        return {
            "math": cls.MATH_TASKS,
            "coding": cls.CODING_TASKS,
            "reasoning": cls.REASONING_TASKS,
            "science": cls.SCIENCE_TASKS,
            "writing": cls.WRITING_TASKS,
            "analysis": cls.ANALYSIS_TASKS,
            "instruction_following": cls.INSTRUCTION_FOLLOWING_TASKS,
            "safety": cls.SAFETY_TASKS,
        }

    @classmethod
    def get_task_types(cls, domain: Domain) -> Dict[str, Dict]:
        """Get all task types for a specific domain."""
        domain_map = {
            Domain.MATH: cls.MATH_TASKS,
            Domain.CODING: cls.CODING_TASKS,
            Domain.REASONING: cls.REASONING_TASKS,
            Domain.SCIENCE: cls.SCIENCE_TASKS,
            Domain.WRITING: cls.WRITING_TASKS,
            Domain.ANALYSIS: cls.ANALYSIS_TASKS,
            Domain.INSTRUCTION_FOLLOWING: cls.INSTRUCTION_FOLLOWING_TASKS,
            Domain.SAFETY: cls.SAFETY_TASKS,
        }
        return domain_map.get(domain, {})

    @classmethod
    def get_templates(cls, domain: Domain, task_type: str) -> List[str]:
        """Get templates for a specific domain and task type."""
        tasks = cls.get_task_types(domain)
        if task_type in tasks:
            return tasks[task_type].get("templates", [])
        return []


class SyntheticDataGenerator:
    """
    Generates high-quality instruction + chain-of-thought + response triples
    using teacher models (Claude Opus).
    """

    def __init__(self, teacher_client: Callable, config: Optional[Dict] = None):
        """
        Initialize the synthetic data generator.

        Args:
            teacher_client: Callable that takes (prompt, max_tokens, temperature) -> str
            config: Configuration dict with generation parameters
        """
        self.teacher_client = teacher_client
        self.config = config or {}
        self.generated_data: List[DataPoint] = []
        self.seen_hashes: Set[str] = set()

        # Generation parameters
        self.max_tokens = self.config.get("max_tokens", 2000)
        self.temperature = self.config.get("temperature", 0.8)
        self.teacher_model = self.config.get("teacher_model", "claude-opus")

    def generate_batch(
        self,
        n: int,
        domain: Optional[Domain] = None,
        difficulty: Optional[Difficulty] = None,
        task_type: Optional[str] = None,
    ) -> List[DataPoint]:
        """
        Generate a batch of synthetic data points.

        Args:
            n: Number of examples to generate
            domain: Filter by domain (if None, random)
            difficulty: Filter by difficulty (if None, random)
            task_type: Filter by task type (if None, random)

        Returns:
            List of DataPoint objects
        """
        batch = []
        attempts = 0
        max_attempts = n * 5  # Allow for filtering/failures

        while len(batch) < n and attempts < max_attempts:
            attempts += 1

            # Choose domain/difficulty/task
            chosen_domain = domain or random.choice(list(Domain))
            chosen_difficulty = difficulty or random.choice(list(Difficulty))
            tasks = TaskTaxonomy.get_task_types(chosen_domain)
            chosen_task_type = task_type or random.choice(list(tasks.keys()))

            # Generate seed prompt
            seed_prompt = self._generate_seed_prompt(
                chosen_domain, chosen_task_type, chosen_difficulty
            )

            # Generate via teacher
            try:
                cot, response = self._teacher_generate(seed_prompt)
            except Exception as e:
                print(f"Error generating via teacher: {e}")
                continue

            # Create DataPoint
            dp = DataPoint(
                instruction=seed_prompt,
                chain_of_thought=cot,
                response=response,
                domain=chosen_domain,
                task_type=chosen_task_type,
                difficulty=chosen_difficulty,
                quality_score=0.0,  # Will be set by filter
                teacher_model=self.teacher_model,
                metadata={
                    "generation_timestamp": time.time(),
                    "attempt": attempts,
                },
            )

            # Quality filter
            if self._quality_filter(dp):
                # Deduplication
                if dp.get_hash() not in self.seen_hashes:
                    # Constitutional check
                    constitutional_score = self._constitutional_check(dp)
                    dp.quality_score = constitutional_score

                    if constitutional_score >= 0.7:  # Threshold
                        batch.append(dp)
                        self.seen_hashes.add(dp.get_hash())
                        self.generated_data.append(dp)

        return batch

    def _generate_seed_prompt(
        self, domain: Domain, task_type: str, difficulty: Difficulty
    ) -> str:
        """
        Generate a diverse seed prompt using templates and variation.

        Args:
            domain: Task domain
            task_type: Type of task within domain
            difficulty: Difficulty level

        Returns:
            Seed instruction prompt
        """
        templates = TaskTaxonomy.get_templates(domain, task_type)
        if not templates:
            return f"Complete a {difficulty.value} {domain.value} task of type {task_type}."

        template = random.choice(templates)

        # Domain-specific fillers
        fillers = self._get_difficulty_appropriate_fillers(domain, difficulty)

        # Substitute placeholders
        prompt = template
        for key, values in fillers.items():
            placeholder = "{" + key + "}"
            if placeholder in prompt:
                value = random.choice(values)
                prompt = prompt.replace(placeholder, value, 1)

        return prompt.strip()

    def _get_difficulty_appropriate_fillers(
        self, domain: Domain, difficulty: Difficulty
    ) -> Dict[str, List[str]]:
        """Get appropriate filler values based on domain and difficulty."""

        # Shared fillers
        base_fillers = {
            "operation": ["addition", "subtraction", "multiplication", "division"],
            "op_symbol": ["+", "-", "*", "/"],
            "shape": ["triangle", "square", "circle", "pentagon", "polygon"],
            "object": ["ball", "box", "sphere", "cube"],
            "metric": ["area", "volume", "perimeter", "surface area"],
        }

        if domain == Domain.MATH:
            base_fillers.update(
                {
                    "num1": self._generate_numbers(difficulty),
                    "num2": self._generate_numbers(difficulty),
                    "equation": self._generate_equations(difficulty),
                    "expression": self._generate_expressions(difficulty),
                    "polynomial": self._generate_polynomials(difficulty),
                    "variable": ["x", "y", "z", "a", "b"],
                    "side1": ["5cm", "10cm", "15cm"],
                    "side2": ["6cm", "12cm", "18cm"],
                    "side3": ["7cm", "14cm", "21cm"],
                    "radius": ["2", "5", "10"],
                    "function": ["x^2 + 3x + 2", "sin(x)", "e^x", "ln(x)"],
                }
            )
        elif domain == Domain.CODING:
            base_fillers.update(
                {
                    "operation": [
                        "insert",
                        "search",
                        "delete",
                        "traverse",
                        "balance",
                    ],
                    "data_structure": ["array", "linked list", "tree", "graph"],
                    "ds_name": ["Stack", "Queue", "BinarySearchTree", "HashMap"],
                    "methods": ["push(), pop()", "enqueue(), dequeue()"],
                    "problem": ["reverse an array", "find duplicates", "sort data"],
                    "algorithm_name": ["quicksort", "DFS", "dynamic programming"],
                    "technique": ["divide and conquer", "greedy", "recursion"],
                    "input_desc": ["an unsorted array of integers"],
                    "output_desc": ["a sorted array"],
                    "complexity_type": ["time", "space"],
                    "function": ["factorial(n)", "fibonacci(n)"],
                }
            )
        elif domain == Domain.REASONING:
            base_fillers.update(
                {
                    "premise1": [
                        "All humans are mortal",
                        "Dogs are animals",
                        "It is raining",
                    ],
                    "premise2": [
                        "Socrates is human",
                        "Fluffy is a dog",
                        "When it rains, the ground is wet",
                    ],
                    "conclusion": [
                        "Socrates is mortal",
                        "Fluffy is an animal",
                        "The ground is wet",
                    ],
                    "sequence": [
                        "2, 4, 6, 8, ?",
                        "1, 1, 2, 3, 5, 8, ?",
                        "A, B, C, D, ?",
                    ],
                }
            )
        elif domain == Domain.SCIENCE:
            base_fillers.update(
                {
                    "object": [
                        "particle",
                        "object",
                        "ball",
                        "projectile",
                        "satellite",
                    ],
                    "properties": ["mass 2kg", "velocity 10 m/s", "charge +5C"],
                    "action": ["falls", "accelerates", "orbits", "collides"],
                    "phenomenon": [
                        "gravity",
                        "refraction",
                        "diffraction",
                        "magnetism",
                    ],
                    "law": ["Newton's laws", "Ohm's law", "Faraday's law"],
                    "molecule": ["H2O", "CO2", "NaCl"],
                    "genotype": ["AA", "Aa", "aa"],
                    "field": ["physics", "chemistry", "biology"],
                }
            )
        elif domain == Domain.WRITING:
            base_fillers.update(
                {
                    "genre": ["fantasy", "science fiction", "mystery", "romance"],
                    "elements": ["magic", "a twist ending", "a moral lesson"],
                    "topic": ["adventure", "loss", "discovery", "conflict"],
                    "perspective": ["first person", "third person limited"],
                    "character": ["hero", "villain", "mentor", "sidekick"],
                    "trait": ["is brave", "is conflicted", "is mysterious"],
                    "challenge": ["must save the world", "must overcome their fear"],
                    "atmosphere": ["dark and gloomy", "bright and hopeful"],
                    "form": ["poem", "sonnet", "haiku", "free verse"],
                    "theme": ["love", "death", "nature", "human condition"],
                }
            )
        elif domain == Domain.ANALYSIS:
            base_fillers.update(
                {
                    "text": ["Shakespeare's Hamlet", "the article provided"],
                    "aspects": ["symbolism", "character development"],
                    "technique": ["metaphor", "alliteration", "parallelism"],
                    "literary_element": ["imagery", "foreshadowing", "irony"],
                    "work": ["Hamlet", "Pride and Prejudice"],
                }
            )
        elif domain == Domain.INSTRUCTION_FOLLOWING:
            base_fillers.update(
                {
                    "goal": ["complete the project", "solve the problem"],
                    "steps": ["step 1", "step 2", "step 3"],
                    "format": ["JSON", "Markdown", "bullet points"],
                    "constraint": ["500 words", "3 paragraphs"],
                    "role": ["software engineer", "doctor", "teacher"],
                    "persona": ["expert", "beginner", "skeptic"],
                }
            )

        return base_fillers

    def _generate_numbers(self, difficulty: Difficulty) -> List[str]:
        """Generate difficulty-appropriate numbers."""
        if difficulty == Difficulty.EASY:
            return [str(random.randint(1, 20)) for _ in range(5)]
        elif difficulty == Difficulty.MEDIUM:
            return [str(random.randint(1, 1000)) for _ in range(5)]
        elif difficulty == Difficulty.HARD:
            return [str(random.randint(1, 1000000)) for _ in range(5)]
        else:  # FRONTIER
            return [str(random.randint(1, 10**15)) for _ in range(5)]

    def _generate_equations(self, difficulty: Difficulty) -> List[str]:
        """Generate difficulty-appropriate equations."""
        easy = ["x + 5 = 10", "2x = 8", "x - 3 = 7"]
        medium = ["x^2 - 5x + 6 = 0", "2x^2 + 3x - 2 = 0", "x^3 - 8 = 0"]
        hard = [
            "x^3 - 3x^2 + 2x - 1 = 0",
            "e^x - 2x = 0",
            "sin(x) - x/2 = 0",
        ]
        frontier = [
            "∫(x^3 + 2x) dx = ∫sin(x) dx",
            "∂²u/∂t² - c²∇²u = 0",
        ]

        difficulty_map = {
            Difficulty.EASY: easy,
            Difficulty.MEDIUM: medium,
            Difficulty.HARD: hard,
            Difficulty.FRONTIER: frontier,
        }
        return random.choice(difficulty_map.get(difficulty, easy))

    def _generate_expressions(self, difficulty: Difficulty) -> List[str]:
        """Generate difficulty-appropriate expressions."""
        easy = ["(a + b) * 2", "x * (y + 3)", "5a - 2b"]
        medium = ["(x^2 + 2x + 1) / (x + 1)", "sin(x) * cos(x)", "√(a^2 + b^2)"]
        hard = [
            "∫₀^∞ e^(-x²) dx",
            "lim(x→0) sin(x)/x",
            "Σ(n=1 to ∞) 1/n²",
        ]
        frontier = [
            "∮_C F·dr where F = ⟨x, y⟩",
            "∑ₙ (-1)^n/(2n+1)",
        ]

        difficulty_map = {
            Difficulty.EASY: easy,
            Difficulty.MEDIUM: medium,
            Difficulty.HARD: hard,
            Difficulty.FRONTIER: frontier,
        }
        return random.choice(difficulty_map.get(difficulty, easy))

    def _generate_polynomials(self, difficulty: Difficulty) -> List[str]:
        """Generate difficulty-appropriate polynomials."""
        easy = ["x^2 - 4", "x^2 + 2x + 1", "2x - 6"]
        medium = ["x^3 - 1", "x^4 - 16", "x^2 - 5x + 6"]
        hard = [
            "x^5 - 1",
            "x^4 + x^3 + x^2 + x + 1",
            "2x^3 - 3x^2 + x - 1",
        ]
        frontier = ["x^8 - x^4 + 1", "x^6 + x^3 + 1"]

        difficulty_map = {
            Difficulty.EASY: easy,
            Difficulty.MEDIUM: medium,
            Difficulty.HARD: hard,
            Difficulty.FRONTIER: frontier,
        }
        return random.choice(difficulty_map.get(difficulty, easy))

    def _teacher_generate(self, prompt: str) -> Tuple[str, str]:
        """
        Generate chain-of-thought and response using teacher model.

        Args:
            prompt: The instruction prompt

        Returns:
            Tuple of (chain_of_thought, final_answer)
        """
        system_prompt = """You are an expert reasoning assistant. Your task is to:

1. First, think through the problem step-by-step, showing ALL your reasoning
2. Break down complex problems into smaller parts
3. Show any calculations, logical steps, or inference chains
4. Be thorough and explicit in your reasoning
5. After completing your reasoning, provide a clear final answer

Format your response exactly as follows:
[REASONING]
<Your complete step-by-step reasoning and work goes here. Show everything.>
[/REASONING]

=== ANSWER ===
<Your crisp, final answer goes here. Be concise and direct.>

Remember:
- The reasoning section should be detailed and educational
- The final answer should be clear and standalone
- Always follow this format"""

        full_prompt = f"{system_prompt}\n\n[TASK]\n{prompt}\n[/TASK]"

        # Call teacher client
        response_text = self.teacher_client(
            full_prompt, max_tokens=self.max_tokens, temperature=self.temperature
        )

        # Parse response
        cot = ""
        answer = ""

        # Extract reasoning section
        reasoning_match = re.search(
            r"\[REASONING\](.*?)\[/REASONING\]", response_text, re.DOTALL
        )
        if reasoning_match:
            cot = reasoning_match.group(1).strip()
        else:
            # Fallback: take everything before === ANSWER ===
            parts = response_text.split("=== ANSWER ===")
            if len(parts) > 0:
                cot = parts[0].strip()

        # Extract answer section
        answer_match = re.search(r"=== ANSWER ===(.*?)$", response_text, re.DOTALL)
        if answer_match:
            answer = answer_match.group(1).strip()
        else:
            # Fallback: take everything after === ANSWER ===
            parts = response_text.split("=== ANSWER ===")
            if len(parts) > 1:
                answer = parts[1].strip()
            else:
                answer = response_text.strip()

        return cot, answer

    def _quality_filter(self, dp: DataPoint) -> bool:
        """
        Filter datapoint for quality criteria.

        Args:
            dp: DataPoint to evaluate

        Returns:
            True if passes quality criteria, False otherwise
        """
        # Check lengths
        if len(dp.instruction) < 10 or len(dp.instruction) > 5000:
            return False
        if len(dp.response) < 20 or len(dp.response) > 10000:
            return False
        if len(dp.chain_of_thought) < 10 or len(dp.chain_of_thought) > 15000:
            return False

        # Check for refusals (models sometimes refuse to answer)
        refusal_markers = [
            "i can't",
            "i cannot",
            "i'm unable",
            "i apologize",
            "that's not something i can help",
            "against my values",
            "i won't",
        ]
        response_lower = (dp.response + dp.chain_of_thought).lower()
        refusal_count = sum(
            1 for marker in refusal_markers if marker in response_lower
        )
        if refusal_count > 2:
            return False

        # Check for coherence (basic: should not be all spaces/newlines)
        if not dp.response.strip() or not dp.chain_of_thought.strip():
            return False

        # Check that response has actual content
        if len(re.sub(r"\s+", "", dp.response)) < 20:
            return False

        return True

    def _deduplicate(self, datapoints: List[DataPoint]) -> List[DataPoint]:
        """
        Deduplicate datapoints using shingling and hashing.

        Args:
            datapoints: List of DataPoint objects

        Returns:
            Deduplicated list
        """
        seen_hashes: Set[str] = set()
        seen_shingles: Dict[str, Set[str]] = defaultdict(set)
        deduplicated = []

        threshold = 0.7  # Jaccard similarity threshold

        for dp in datapoints:
            dp_hash = dp.get_hash()

            # Exact hash match
            if dp_hash in seen_hashes:
                continue

            # Shingling similarity check
            dp_shingles = dp.get_shingles(k=4)
            is_duplicate = False

            for prev_hash, prev_shingles in seen_shingles.items():
                if prev_shingles and dp_shingles:
                    intersection = len(prev_shingles & dp_shingles)
                    union = len(prev_shingles | dp_shingles)
                    jaccard = intersection / union if union > 0 else 0

                    if jaccard >= threshold:
                        is_duplicate = True
                        break

            if not is_duplicate:
                deduplicated.append(dp)
                seen_hashes.add(dp_hash)
                seen_shingles[dp_hash] = dp_shingles

        return deduplicated

    def _constitutional_check(self, dp: DataPoint) -> float:
        """
        Evaluate datapoint on constitutional principles.

        Args:
            dp: DataPoint to evaluate

        Returns:
            Quality score 0-1
        """
        score = 1.0

        # Helpfulness
        if any(
            word in dp.response.lower()
            for word in ["not sure", "unclear", "don't know"]
        ):
            score -= 0.1

        # Correctness (heuristic)
        response_lower = dp.response.lower()
        if (
            "error" in response_lower
            or "incorrect" in response_lower
            or "wrong" in response_lower
        ):
            score -= 0.15

        # Safety
        harmful_keywords = [
            "illegal",
            "dangerous",
            "violence",
            "harm",
            "exploit",
        ]
        if any(keyword in response_lower for keyword in harmful_keywords):
            score -= 0.2

        # Factuality
        if "i think" in response_lower and len(dp.chain_of_thought) < 50:
            score -= 0.05

        # Length and depth
        cot_words = len(dp.chain_of_thought.split())
        response_words = len(dp.response.split())

        if cot_words < 20:
            score -= 0.1
        if response_words < 30:
            score -= 0.1

        # Bonus for structured reasoning
        if any(
            marker in dp.chain_of_thought
            for marker in ["step", "therefore", "thus", "hence", "because"]
        ):
            score += 0.1

        return max(0.0, min(1.0, score))


class DataAugmentor:
    """Augment synthetic data to increase diversity and robustness."""

    def __init__(self, teacher_client: Callable):
        """
        Initialize augmentor.

        Args:
            teacher_client: Callable for generating augmentations
        """
        self.teacher_client = teacher_client

    def paraphrase(self, dp: DataPoint) -> DataPoint:
        """
        Paraphrase instruction while preserving meaning.

        Args:
            dp: DataPoint to paraphrase

        Returns:
            New DataPoint with paraphrased instruction
        """
        prompt = f"""Rewrite this instruction in a different way while preserving the exact meaning and difficulty:

Original: {dp.instruction}

Requirements:
1. Keep the same task and difficulty level
2. Use different wording
3. Do not change the core requirement
4. Make it sound natural

Rewritten instruction:"""

        paraphrased = self.teacher_client(prompt, max_tokens=500, temperature=0.7)

        new_dp = DataPoint(
            instruction=paraphrased.strip(),
            chain_of_thought=dp.chain_of_thought,
            response=dp.response,
            domain=dp.domain,
            task_type=dp.task_type,
            difficulty=dp.difficulty,
            quality_score=dp.quality_score,
            teacher_model=dp.teacher_model,
            metadata={**dp.metadata, "augmentation": "paraphrase"},
        )
        return new_dp

    def add_noise(self, dp: DataPoint, noise_level: float = 0.1) -> DataPoint:
        """
        Add small perturbations to make model robust.

        Args:
            dp: DataPoint to perturb
            noise_level: Level of perturbation (0-1)

        Returns:
            New DataPoint with noise
        """
        words = dp.instruction.split()
        num_changes = max(1, int(len(words) * noise_level))

        noisy_words = words.copy()
        for _ in range(num_changes):
            if len(noisy_words) > 0:
                idx = random.randint(0, len(noisy_words) - 1)
                # Typo, synonym, or slight variation
                variation_type = random.choice(["typo", "swap"])

                if variation_type == "typo" and len(noisy_words[idx]) > 1:
                    word = noisy_words[idx]
                    idx_char = random.randint(0, len(word) - 1)
                    noisy_words[idx] = word[:idx_char] + word[idx_char + 1 :]

                elif variation_type == "swap" and idx < len(noisy_words) - 1:
                    noisy_words[idx], noisy_words[idx + 1] = (
                        noisy_words[idx + 1],
                        noisy_words[idx],
                    )

        noisy_instruction = " ".join(noisy_words)

        new_dp = DataPoint(
            instruction=noisy_instruction,
            chain_of_thought=dp.chain_of_thought,
            response=dp.response,
            domain=dp.domain,
            task_type=dp.task_type,
            difficulty=dp.difficulty,
            quality_score=dp.quality_score * 0.95,  # Slightly lower quality
            teacher_model=dp.teacher_model,
            metadata={**dp.metadata, "augmentation": "noise", "noise_level": noise_level},
        )
        return new_dp

    def generate_harder_variant(self, dp: DataPoint) -> Optional[DataPoint]:
        """
        Generate a harder version of the task.

        Args:
            dp: DataPoint to make harder

        Returns:
            New harder DataPoint or None if fails
        """
        if dp.difficulty == Difficulty.FRONTIER:
            return None  # Can't make frontier harder

        next_difficulty = {
            Difficulty.EASY: Difficulty.MEDIUM,
            Difficulty.MEDIUM: Difficulty.HARD,
            Difficulty.HARD: Difficulty.FRONTIER,
        }[dp.difficulty]

        prompt = f"""Make this {dp.domain.value} task harder. Increase complexity but keep it in the same domain and task type.

Current ({dp.difficulty.value}): {dp.instruction}

Requirements:
1. Increase difficulty to {next_difficulty.value}
2. Keep same domain ({dp.domain.value}) and task type ({dp.task_type})
3. Make it genuinely harder, not just wordier
4. Ensure it's still solvable

Harder version:"""

        harder = self.teacher_client(prompt, max_tokens=500, temperature=0.7)

        new_dp = DataPoint(
            instruction=harder.strip(),
            chain_of_thought="",  # Will need re-generation
            response="",
            domain=dp.domain,
            task_type=dp.task_type,
            difficulty=next_difficulty,
            quality_score=0.0,
            teacher_model=dp.teacher_model,
            metadata={
                **dp.metadata,
                "augmentation": "harder_variant",
                "parent_hash": dp.get_hash(),
            },
        )
        return new_dp

    def generate_adversarial(self, dp: DataPoint) -> Optional[DataPoint]:
        """
        Generate adversarial/edge-case version.

        Args:
            dp: DataPoint to create adversarial variant from

        Returns:
            New adversarial DataPoint or None
        """
        prompt = f"""Create an edge case or adversarial variant of this task. Test whether a model truly understands.

Original: {dp.instruction}

Requirements:
1. Keep the same domain and general task type
2. Introduce a trick, edge case, or unusual constraint
3. Make it test robustness, not just simple capability
4. Examples: ambiguous wording, boundary conditions, implicit assumptions

Adversarial variant:"""

        adversarial = self.teacher_client(prompt, max_tokens=500, temperature=0.8)

        new_dp = DataPoint(
            instruction=adversarial.strip(),
            chain_of_thought="",  # Will need re-generation
            response="",
            domain=dp.domain,
            task_type=dp.task_type,
            difficulty=dp.difficulty,
            quality_score=0.0,
            teacher_model=dp.teacher_model,
            metadata={
                **dp.metadata,
                "augmentation": "adversarial",
                "parent_hash": dp.get_hash(),
            },
        )
        return new_dp


class DatasetExporter:
    """Export synthetic datasets in various formats."""

    @staticmethod
    def to_jsonl(datapoints: List[DataPoint], path: str, format: str = "sharegpt"):
        """
        Export to JSONL format.

        Args:
            datapoints: List of DataPoints
            path: Output file path
            format: "sharegpt" or "alpaca" or "custom"
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w") as f:
            for dp in datapoints:
                if format == "sharegpt":
                    record = {
                        "conversations": [
                            {"from": "user", "value": dp.instruction},
                            {
                                "from": "assistant",
                                "value": f"{dp.chain_of_thought}\n\n=== ANSWER ===\n{dp.response}",
                            },
                        ],
                        "domain": dp.domain.value,
                        "task_type": dp.task_type,
                        "difficulty": dp.difficulty.value,
                    }
                elif format == "alpaca":
                    record = {
                        "instruction": dp.instruction,
                        "input": "",
                        "output": dp.response,
                        "history": [
                            {
                                "instruction": dp.instruction,
                                "output": dp.chain_of_thought,
                            }
                        ],
                    }
                elif format == "custom":
                    record = dp.to_dict()
                else:
                    record = dp.to_dict()

                f.write(json.dumps(record) + "\n")

        print(f"Exported {len(datapoints)} datapoints to {path}")

    @staticmethod
    def to_alpaca(datapoints: List[DataPoint], path: str):
        """Export in Alpaca format."""
        DatasetExporter.to_jsonl(datapoints, path, format="alpaca")

    @staticmethod
    def to_chatml(datapoints: List[DataPoint], path: str):
        """
        Export in ChatML format for fine-tuning.

        Args:
            datapoints: List of DataPoints
            path: Output file path
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w") as f:
            for dp in datapoints:
                record = {
                    "messages": [
                        {"role": "user", "content": dp.instruction},
                        {
                            "role": "assistant",
                            "content": f"<thinking>\n{dp.chain_of_thought}\n</thinking>\n\n{dp.response}",
                        },
                    ]
                }
                f.write(json.dumps(record) + "\n")

        print(f"Exported {len(datapoints)} datapoints to {path} in ChatML format")

    @staticmethod
    def split_train_val(
        datapoints: List[DataPoint], val_ratio: float = 0.1
    ) -> Tuple[List[DataPoint], List[DataPoint]]:
        """
        Split dataset into train and validation sets.

        Args:
            datapoints: List of DataPoints
            val_ratio: Fraction for validation set

        Returns:
            Tuple of (train_list, val_list)
        """
        shuffled = datapoints.copy()
        random.shuffle(shuffled)

        split_idx = int(len(shuffled) * (1 - val_ratio))
        return shuffled[:split_idx], shuffled[split_idx:]

    @staticmethod
    def get_stats(datapoints: List[DataPoint]) -> Dict:
        """
        Get comprehensive statistics about dataset.

        Args:
            datapoints: List of DataPoints

        Returns:
            Statistics dictionary
        """
        if not datapoints:
            return {}

        # Domain distribution
        domain_counts = defaultdict(int)
        task_type_counts = defaultdict(int)
        difficulty_counts = defaultdict(int)

        total_instruction_tokens = 0
        total_response_tokens = 0
        total_cot_tokens = 0
        quality_scores = []

        for dp in datapoints:
            domain_counts[dp.domain.value] += 1
            task_type_counts[dp.task_type] += 1
            difficulty_counts[dp.difficulty.value] += 1

            total_instruction_tokens += len(dp.instruction.split())
            total_response_tokens += len(dp.response.split())
            total_cot_tokens += len(dp.chain_of_thought.split())
            quality_scores.append(dp.quality_score)

        avg_quality = (
            sum(quality_scores) / len(quality_scores) if quality_scores else 0
        )

        return {
            "total_examples": len(datapoints),
            "domain_distribution": dict(domain_counts),
            "task_type_distribution": dict(task_type_counts),
            "difficulty_distribution": dict(difficulty_counts),
            "avg_instruction_tokens": (
                total_instruction_tokens // len(datapoints) if datapoints else 0
            ),
            "avg_response_tokens": (
                total_response_tokens // len(datapoints) if datapoints else 0
            ),
            "avg_cot_tokens": (
                total_cot_tokens // len(datapoints) if datapoints else 0
            ),
            "total_tokens": (
                total_instruction_tokens + total_response_tokens + total_cot_tokens
            ),
            "avg_quality_score": avg_quality,
            "min_quality_score": min(quality_scores) if quality_scores else 0,
            "max_quality_score": max(quality_scores) if quality_scores else 0,
        }


if __name__ == "__main__":
    # Example usage
    print("Synthetic Data Generator initialized.")
    print(f"Total domains: {len(Domain)}")
    print(f"Total difficulties: {len(Difficulty)}")

    all_tasks = TaskTaxonomy.get_all_tasks()
    total_task_types = sum(len(tasks) for tasks in all_tasks.values())
    print(f"Total task types: {total_task_types}")

    # Print sample templates
    print("\n=== Sample Templates ===")
    for domain in Domain:
        tasks = TaskTaxonomy.get_task_types(domain)
        first_task_type = list(tasks.keys())[0]
        templates = tasks[first_task_type].get("templates", [])
        print(f"\n{domain.value} - {first_task_type}:")
        for template in templates[:2]:
            print(f"  - {template}")
