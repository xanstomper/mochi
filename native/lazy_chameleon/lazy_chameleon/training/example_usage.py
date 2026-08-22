"""
Example usage of the Synthetic Data Generator.

Demonstrates:
1. Setting up a teacher client (mock example)
2. Generating synthetic data batches
3. Augmenting data
4. Exporting in various formats
5. Analyzing dataset statistics
"""

import json
from pathlib import Path
from synthetic_data_generator import (
    SyntheticDataGenerator,
    DataAugmentor,
    DatasetExporter,
    Domain,
    Difficulty,
    TaskTaxonomy,
    DataPoint,
)


# ============================================================================
# 1. MOCK TEACHER CLIENT EXAMPLE
# ============================================================================
def mock_teacher_client(prompt: str, max_tokens: int = 2000, temperature: float = 0.8) -> str:
    """
    Mock teacher client for demonstration.
    
    In production, this would be replaced with actual Claude API calls:
    
    Example with real Claude API:
    ```python
    import anthropic
    
    client = anthropic.Anthropic(api_key="your-api-key")
    
    def real_teacher_client(prompt, max_tokens, temperature):
        response = client.messages.create(
            model="claude-opus",
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.content[0].text
    ```
    """
    # Mock response with proper format
    mock_responses = {
        "arithmetic": {
            "instruction": "Calculate the sum of 15 and 27.",
            "cot": """[REASONING]
To find the sum of 15 and 27, I need to add these two numbers together.
15 + 27 = 15 + 20 + 7 = 35 + 7 = 42
I can verify: 15 + 27 = (10 + 5) + (20 + 7) = 30 + 12 = 42
[/REASONING]""",
            "answer": "The sum of 15 and 27 is 42."
        },
        "algebra": {
            "instruction": "Solve for x: 2x + 5 = 17",
            "cot": """[REASONING]
We have the equation: 2x + 5 = 17

Step 1: Subtract 5 from both sides
2x + 5 - 5 = 17 - 5
2x = 12

Step 2: Divide both sides by 2
2x / 2 = 12 / 2
x = 6

Step 3: Verify the solution
2(6) + 5 = 12 + 5 = 17 ✓
[/REASONING]""",
            "answer": "x = 6"
        },
        "coding": {
            "instruction": "Write a function to reverse an array in Python.",
            "cot": """[REASONING]
To reverse an array, I have several approaches:

1. Python built-in: array[::-1]
2. Using reverse(): array.reverse()
3. Manual reversal with two pointers
4. Using recursion

The most efficient is the built-in slicing. For an interview, a two-pointer approach shows good understanding.

Two-pointer approach:
- Initialize left pointer at start, right at end
- Swap elements at left and right
- Move pointers toward center
- Time: O(n), Space: O(1)
[/REASONING]""",
            "answer": """def reverse_array(arr):
    left, right = 0, len(arr) - 1
    while left < right:
        arr[left], arr[right] = arr[right], arr[left]
        left += 1
        right -= 1
    return arr

# Or using Python's built-in:
def reverse_array_simple(arr):
    return arr[::-1]"""
        },
        "reasoning": {
            "instruction": "Complete the sequence: 2, 4, 6, 8, ?",
            "cot": """[REASONING]
Looking at the sequence: 2, 4, 6, 8, ?

Pattern analysis:
- 2 to 4: difference is 2
- 4 to 6: difference is 2
- 6 to 8: difference is 2

This is an arithmetic sequence with common difference d = 2.
Each number is 2 more than the previous.

Therefore, the next number is: 8 + 2 = 10
[/REASONING]""",
            "answer": "10"
        },
        "science": {
            "instruction": "Explain the process of photosynthesis.",
            "cot": """[REASONING]
Photosynthesis is the process by which plants convert light energy into chemical energy.

Key components:
1. Light reactions (in thylakoid membranes)
   - Light hits chlorophyll
   - Electrons get excited
   - Water is split (photolysis)
   - ATP and NADPH are produced
   - Oxygen is released

2. Calvin cycle (in stroma)
   - CO2 is fixed by RuBisCO
   - Three carbon compounds form
   - Using ATP and NADPH from light reactions
   - Glucose is synthesized

Overall equation: 6CO2 + 6H2O + light → C6H12O6 + 6O2
[/REASONING]""",
            "answer": """Photosynthesis is how plants use sunlight, water, and carbon dioxide to produce glucose and oxygen.

Light reactions: Light energy is captured by chlorophyll, water molecules are split, and energy carriers (ATP, NADPH) are produced.

Calvin cycle: CO2 is fixed using the energy carriers to produce glucose.

This process is crucial for converting solar energy into chemical energy stored in organic molecules."""
        },
        "writing": {
            "instruction": "Write a short story about discovering a hidden room.",
            "cot": """[REASONING]
For creative writing, I should:
1. Create an interesting protagonist
2. Build tension through discovery
3. Use descriptive language
4. Show, don't tell emotions
5. Have a satisfying revelation

I'll structure it as:
- Introduction of character in familiar setting
- Discovery moment (sensory details)
- Exploration with surprise elements
- Resolution/twist
[/REASONING]""",
            "answer": """Sarah had lived in the Victorian house for three months before she found it. A loose panel behind the library bookcase, hidden by shadow and dust.

Her heart hammered as she pulled. The panel gave way with a groan, releasing the smell of old paper and something sweet—old perfume, maybe.

Inside: a small room. A desk, a chair, and shelves lined with leather-bound journals. The dust was thick but undisturbed for decades. A photograph fell from the top shelf—a woman who could have been Sarah's twin, smiling at the camera in 1920s clothing.

On the desk, a fountain pen rested on a half-finished letter. Sarah picked it up with trembling fingers and read:

"If you've found this room, then you're special too. Not everyone can sense the history that lives in these walls. Welcome home."

Sarah sat down and began to read."""
        },
    }

    # Return a mock response based on detected domain
    for key in mock_responses:
        if key.lower() in prompt.lower():
            response = mock_responses[key]
            return f"{response['cot']}\n\n=== ANSWER ===\n{response['answer']}"

    # Default mock response
    return """[REASONING]
This is a mock response showing the expected format.
In production, a real teacher model (Claude Opus) would generate substantive reasoning.
The response includes step-by-step thinking, intermediate calculations, and logical deduction.
[/REASONING]

=== ANSWER ===
This is the final, crisp answer."""


# ============================================================================
# 2. GENERATE SYNTHETIC DATA
# ============================================================================
def example_generate_data():
    """Generate synthetic data using the teacher model."""
    print("\n" + "=" * 80)
    print("EXAMPLE 1: GENERATING SYNTHETIC DATA")
    print("=" * 80)

    # Initialize generator with mock teacher client
    config = {
        "max_tokens": 2000,
        "temperature": 0.8,
        "teacher_model": "claude-opus",
    }

    generator = SyntheticDataGenerator(mock_teacher_client, config)

    # Generate batches across different domains and difficulties
    print("\nGenerating data across multiple domains...")

    # Math domain (easy level)
    print("\n1. Generating MATH - EASY (5 examples)...")
    math_easy = generator.generate_batch(
        n=5,
        domain=Domain.MATH,
        difficulty=Difficulty.EASY,
    )
    print(f"   Generated {len(math_easy)} examples")

    # Coding domain (medium level)
    print("2. Generating CODING - MEDIUM (3 examples)...")
    coding_medium = generator.generate_batch(
        n=3,
        domain=Domain.CODING,
        difficulty=Difficulty.MEDIUM,
    )
    print(f"   Generated {len(coding_medium)} examples")

    # Reasoning domain (mixed)
    print("3. Generating REASONING - MIXED DIFFICULTIES (4 examples)...")
    reasoning_mixed = generator.generate_batch(n=4, domain=Domain.REASONING)
    print(f"   Generated {len(reasoning_mixed)} examples")

    # Safety domain
    print("4. Generating SAFETY (3 examples)...")
    safety = generator.generate_batch(n=3, domain=Domain.SAFETY)
    print(f"   Generated {len(safety)} examples")

    all_generated = math_easy + coding_medium + reasoning_mixed + safety

    # Print sample
    if all_generated:
        print("\n" + "-" * 80)
        print("SAMPLE DATA POINT:")
        print("-" * 80)
        sample = all_generated[0]
        print(f"Domain: {sample.domain.value}")
        print(f"Task Type: {sample.task_type}")
        print(f"Difficulty: {sample.difficulty.value}")
        print(f"Quality Score: {sample.quality_score:.2f}")
        print(f"\nInstruction:\n{sample.instruction}")
        print(f"\nChain of Thought (first 300 chars):\n{sample.chain_of_thought[:300]}...")
        print(f"\nResponse (first 300 chars):\n{sample.response[:300]}...")

    return all_generated


# ============================================================================
# 3. AUGMENT DATA
# ============================================================================
def example_augment_data(datapoints):
    """Augment synthetic data for diversity."""
    print("\n" + "=" * 80)
    print("EXAMPLE 2: AUGMENTING DATA")
    print("=" * 80)

    if not datapoints:
        print("No data to augment")
        return []

    augmentor = DataAugmentor(mock_teacher_client)

    augmented = []

    for dp in datapoints[:3]:  # Augment first 3 examples
        # Paraphrase
        print(f"\nAugmenting: {dp.task_type} ({dp.difficulty.value})")

        try:
            paraphrased = augmentor.paraphrase(dp)
            augmented.append(paraphrased)
            print(f"  ✓ Paraphrased")
        except Exception as e:
            print(f"  ✗ Paraphrase failed: {e}")

        try:
            noisy = augmentor.add_noise(dp, noise_level=0.05)
            augmented.append(noisy)
            print(f"  ✓ Added noise")
        except Exception as e:
            print(f"  ✗ Noise failed: {e}")

        try:
            harder = augmentor.generate_harder_variant(dp)
            if harder:
                augmented.append(harder)
                print(f"  ✓ Generated harder variant")
        except Exception as e:
            print(f"  ✗ Harder variant failed: {e}")

        try:
            adversarial = augmentor.generate_adversarial(dp)
            if adversarial:
                augmented.append(adversarial)
                print(f"  ✓ Generated adversarial variant")
        except Exception as e:
            print(f"  ✗ Adversarial failed: {e}")

    print(f"\nGenerated {len(augmented)} augmented examples")
    return augmented


# ============================================================================
# 4. EXPORT DATA
# ============================================================================
def example_export_data(datapoints):
    """Export synthetic data in various formats."""
    print("\n" + "=" * 80)
    print("EXAMPLE 3: EXPORTING DATA")
    print("=" * 80)

    if not datapoints:
        print("No data to export")
        return

    output_dir = Path("/tmp/synthetic_data")
    output_dir.mkdir(exist_ok=True)

    # Export in different formats
    print("\nExporting data in multiple formats...")

    # ShareGPT format
    sharegpt_path = output_dir / "data_sharegpt.jsonl"
    DatasetExporter.to_jsonl(datapoints, str(sharegpt_path), format="sharegpt")
    print(f"✓ ShareGPT format: {sharegpt_path}")

    # Alpaca format
    alpaca_path = output_dir / "data_alpaca.jsonl"
    DatasetExporter.to_alpaca(datapoints, str(alpaca_path))
    print(f"✓ Alpaca format: {alpaca_path}")

    # ChatML format
    chatml_path = output_dir / "data_chatml.jsonl"
    DatasetExporter.to_chatml(datapoints, str(chatml_path))
    print(f"✓ ChatML format: {chatml_path}")

    # Split train/val
    train, val = DatasetExporter.split_train_val(datapoints, val_ratio=0.2)
    print(f"\nTrain/Val split (80/20):")
    print(f"  Train: {len(train)} examples")
    print(f"  Val: {len(val)} examples")

    # Save splits
    train_path = output_dir / "train.jsonl"
    val_path = output_dir / "val.jsonl"
    DatasetExporter.to_chatml(train, str(train_path))
    DatasetExporter.to_chatml(val, str(val_path))

    return output_dir


# ============================================================================
# 5. ANALYZE DATASET
# ============================================================================
def example_analyze_data(datapoints):
    """Analyze dataset statistics."""
    print("\n" + "=" * 80)
    print("EXAMPLE 4: DATASET ANALYSIS")
    print("=" * 80)

    if not datapoints:
        print("No data to analyze")
        return

    stats = DatasetExporter.get_stats(datapoints)

    print("\nDataset Statistics:")
    print(f"  Total Examples: {stats['total_examples']}")
    print(f"  Total Tokens: {stats['total_tokens']:,}")

    print("\nDomain Distribution:")
    for domain, count in stats["domain_distribution"].items():
        pct = (count / stats["total_examples"]) * 100
        print(f"  {domain:20s}: {count:3d} ({pct:5.1f}%)")

    print("\nDifficulty Distribution:")
    for difficulty, count in stats["difficulty_distribution"].items():
        pct = (count / stats["total_examples"]) * 100
        print(f"  {difficulty:20s}: {count:3d} ({pct:5.1f}%)")

    print("\nTask Type Distribution (top 10):")
    sorted_tasks = sorted(
        stats["task_type_distribution"].items(),
        key=lambda x: x[1],
        reverse=True,
    )
    for task_type, count in sorted_tasks[:10]:
        pct = (count / stats["total_examples"]) * 100
        print(f"  {task_type:30s}: {count:3d} ({pct:5.1f}%)")

    print("\nToken Statistics:")
    print(f"  Avg Instruction Tokens: {stats['avg_instruction_tokens']}")
    print(f"  Avg CoT Tokens: {stats['avg_cot_tokens']}")
    print(f"  Avg Response Tokens: {stats['avg_response_tokens']}")

    print("\nQuality Scores:")
    print(f"  Average: {stats['avg_quality_score']:.3f}")
    print(f"  Min: {stats['min_quality_score']:.3f}")
    print(f"  Max: {stats['max_quality_score']:.3f}")


# ============================================================================
# 6. TAXONOMY OVERVIEW
# ============================================================================
def example_taxonomy_overview():
    """Show the comprehensive task taxonomy."""
    print("\n" + "=" * 80)
    print("EXAMPLE 5: TASK TAXONOMY OVERVIEW")
    print("=" * 80)

    print("\nAll Domains and Task Types:")

    all_tasks = TaskTaxonomy.get_all_tasks()

    for domain, task_dict in all_tasks.items():
        print(f"\n{domain.upper()} DOMAIN ({len(task_dict)} task types):")
        for task_type, task_info in task_dict.items():
            name = task_info.get("name", task_type)
            desc = task_info.get("description", "")
            templates_count = len(task_info.get("templates", []))
            tags = task_info.get("tags", [])
            print(f"  - {task_type:25s} | {name:30s}")
            print(f"    {desc}")
            print(f"    Templates: {templates_count} | Tags: {', '.join(tags)}")


# ============================================================================
# MAIN
# ============================================================================
def main():
    """Run all examples."""
    print("\n" + "=" * 80)
    print("SYNTHETIC DATA GENERATOR - COMPREHENSIVE EXAMPLES")
    print("=" * 80)

    # Show taxonomy
    example_taxonomy_overview()

    # Generate data
    generated_data = example_generate_data()

    # Augment data
    if generated_data:
        augmented_data = example_augment_data(generated_data)

        # Combine all
        all_data = generated_data + augmented_data

        # Export
        example_export_data(all_data)

        # Analyze
        example_analyze_data(all_data)

        print("\n" + "=" * 80)
        print("EXAMPLES COMPLETED SUCCESSFULLY")
        print("=" * 80)
        print("\nOutput files saved to: /tmp/synthetic_data/")
        print("\nTo use with real Claude API, replace mock_teacher_client with:")
        print("""
    import anthropic
    
    client = anthropic.Anthropic()
    
    def real_teacher_client(prompt, max_tokens, temperature):
        response = client.messages.create(
            model="claude-opus",
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.content[0].text
    
    generator = SyntheticDataGenerator(real_teacher_client, config)
        """)


if __name__ == "__main__":
    main()
