# Synthetic Training Data Generator

A production-ready synthetic training data generator for fine-tuning DeepSeek Flash into an Opus-level model. Generates high-quality instruction + chain-of-thought + response triples using teacher models (Claude Opus).

## Features

✨ **Comprehensive Task Taxonomy**
- 50+ task types across 8 domains
- 5+ seed templates per task type with parameterized variation
- Difficulty tiers: EASY, MEDIUM, HARD, FRONTIER
- Constitutional tags for alignment

✨ **High-Quality Generation**
- Teacher model integration (Claude Opus)
- Explicit chain-of-thought extraction
- Quality filtering and deduplication
- Constitutional scoring (helpfulness, correctness, safety)

✨ **Data Augmentation**
- Paraphrasing (preserve meaning, vary wording)
- Noise injection (robustness training)
- Difficulty scaling (easy → frontier)
- Adversarial variants (edge cases, tricks)

✨ **Flexible Export**
- ShareGPT format (Vicuna-compatible)
- Alpaca format (instruction-only)
- ChatML format (OpenAI-compatible)
- Train/val splitting
- Comprehensive statistics

## Domains & Task Types

### 1. MATH (8 tasks)
Arithmetic, Algebra, Geometry, Combinatorics, Number Theory, Calculus, Statistics, Optimization

### 2. CODING (7 tasks)
Data Structures, Algorithms, String Processing, System Design, Debugging, OOP Design, Performance

### 3. REASONING (7 tasks)
Logical Deduction, Inductive, Abductive, Analogy, Critical Thinking, Counterfactual, Decision Making

### 4. SCIENCE (7 tasks)
Physics, Chemistry, Biology, Earth Science, Scientific Method, Astronomy, Interdisciplinary

### 5. WRITING (6 tasks)
Creative, Technical, Persuasive, Descriptive, Dialogue, Editorial

### 6. ANALYSIS (7 tasks)
Textual, Data, Historical, Comparative, Causal, Ethical, Systems

### 7. INSTRUCTION FOLLOWING (6 tasks)
Precise Following, Multi-Step, Conditional, Constraint, Role-Based, Quality Standards

### 8. SAFETY (6 tasks)
Refusal Handling, Harm Mitigation, Bias Awareness, Factual Accuracy, Privacy, Value Alignment

## Quick Start

```python
import anthropic
from synthetic_data_generator import SyntheticDataGenerator, Domain, Difficulty, DatasetExporter

# Setup teacher client
client = anthropic.Anthropic(api_key="your-api-key")

def teacher_client(prompt, max_tokens, temperature):
    response = client.messages.create(
        model="claude-opus",
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt}]
    )
    return response.content[0].text

# Generate data
config = {"max_tokens": 2000, "temperature": 0.8, "teacher_model": "claude-opus"}
generator = SyntheticDataGenerator(teacher_client, config)

# Generate 100 math examples at medium difficulty
batch = generator.generate_batch(n=100, domain=Domain.MATH, difficulty=Difficulty.MEDIUM)

# Export in ChatML format (best for fine-tuning)
DatasetExporter.to_chatml(batch, "training_data.jsonl")

# Get statistics
stats = DatasetExporter.get_stats(batch)
print(f"Generated {stats['total_examples']} examples with {stats['total_tokens']} total tokens")
```

## API Reference

### DataPoint
```python
@dataclass
class DataPoint:
    instruction: str           # Task instruction
    chain_of_thought: str      # Step-by-step reasoning
    response: str              # Final answer
    domain: Domain             # MATH, CODING, etc.
    task_type: str             # e.g., "algebra", "algorithms"
    difficulty: Difficulty     # EASY, MEDIUM, HARD, FRONTIER
    quality_score: float       # 0-1 quality metric
    teacher_model: str         # Model that generated it
    metadata: Dict             # Additional metadata
```

### SyntheticDataGenerator
```python
generator.generate_batch(
    n: int,
    domain: Optional[Domain] = None,
    difficulty: Optional[Difficulty] = None,
    task_type: Optional[str] = None,
) -> List[DataPoint]
```

### DatasetExporter
```python
# Export formats
DatasetExporter.to_jsonl(datapoints, path, format="sharegpt")
DatasetExporter.to_alpaca(datapoints, path)
DatasetExporter.to_chatml(datapoints, path)

# Train/val split
train, val = DatasetExporter.split_train_val(datapoints, val_ratio=0.1)

# Statistics
stats = DatasetExporter.get_stats(datapoints)
```

### DataAugmentor
```python
augmentor = DataAugmentor(teacher_client)
paraphrased = augmentor.paraphrase(dp)
noisy = augmentor.add_noise(dp, noise_level=0.1)
harder = augmentor.generate_harder_variant(dp)
adversarial = augmentor.generate_adversarial(dp)
```

## Output Formats

### ChatML (Recommended for Fine-tuning)
```json
{
  "messages": [
    {"role": "user", "content": "Solve for x: 2x + 5 = 17"},
    {"role": "assistant", "content": "<thinking>\nStep 1: 2x = 12\nStep 2: x = 6\n</thinking>\n\nx = 6"}
  ]
}
```

### ShareGPT
```json
{
  "conversations": [
    {"from": "user", "value": "Solve for x: 2x + 5 = 17"},
    {"from": "assistant", "value": "[REASONING]...[/REASONING]\n\n=== ANSWER ===\nx = 6"}
  ],
  "domain": "math",
  "task_type": "algebra",
  "difficulty": "easy"
}
```

## Quality Filtering

Examples pass quality checks if they:
- Have appropriate lengths (10-5000 char instruction, 20-10k response)
- Contain no refusals ("I can't", "I cannot", etc.)
- Show coherent reasoning
- Score >= 0.7 on constitutional checks

Constitutional scores evaluate:
- **Helpfulness**: Avoid uncertainty markers
- **Correctness**: Avoid error/incorrect statements
- **Safety**: Flag harmful keywords
- **Factuality**: Reward structured reasoning
- **Depth**: Bonus for detailed responses

## Deduplication

Uses Jaccard similarity on 4-shingles (4-word sequences):
- Exact SHA256 hash matching for identical examples
- Similarity threshold: 0.7 (70% similar = duplicate)
- Prevents near-duplicate variants

## Usage Examples

### Generate Balanced Dataset

```python
all_data = []
for domain in Domain:
    for difficulty in Difficulty:
        batch = generator.generate_batch(n=25, domain=domain, difficulty=difficulty)
        all_data.extend(batch)
# Result: 25 × 8 domains × 4 difficulties = 800 examples
```

### Multi-Stage Augmentation

```python
# Stage 1: Generate base
base = generator.generate_batch(n=100)

# Stage 2: Augment
augmentor = DataAugmentor(teacher_client)
augmented = []
for dp in base:
    augmented.append(dp)
    augmented.append(augmentor.paraphrase(dp))
    augmented.append(augmentor.add_noise(dp, noise_level=0.05))

# Stage 3: Export
DatasetExporter.to_chatml(augmented, "dataset.jsonl")
```

### Filter by Task Type

```python
math_algebra = generator.generate_batch(n=50, domain=Domain.MATH, task_type="algebra")
coding_algo = generator.generate_batch(n=50, domain=Domain.CODING, task_type="algorithms")
```

## Performance

- **Generation Speed**: 30-60 sec/example with Claude Opus (API-bound)
- **Memory**: ~1-3 KB per DataPoint; 10K examples ≈ 10-30 MB
- **Cost**: Claude Opus ~$0.015/1K input tokens

## Testing

Run the example with mock data (no API calls):
```bash
python example_usage.py
```

## Integration with Fine-tuning

### HuggingFace Transformers
```python
from datasets import Dataset
import json

data = [json.loads(line) for line in open("training_data.jsonl")]
dataset = Dataset.from_dict({"text": [d["messages"] for d in data]})

from transformers import Trainer
trainer = Trainer(model=model, train_dataset=dataset, ...)
trainer.train()
```

### DeepSeek CLI
```bash
python deepseek/finetune.py --data_path training_data.jsonl --model_id deepseek-7b-chat
```

## Best Practices

1. **Start Small**: Generate 100-200 examples to verify quality
2. **Manual Review**: Sample and review generated examples
3. **Balanced Dataset**: Ensure domain and difficulty coverage
4. **Augmentation**: Use paraphrasing and noise for diversity
5. **Progressive Difficulty**: Train on EASY → FRONTIER
6. **Real Teacher Model**: Use Claude Opus (worth the cost for quality)
7. **Version Control**: Track dataset versions with metadata

## Architecture

**No external ML dependencies!** Uses only standard library:
- json, re, hashlib: Data processing and hashing
- random, time, os: Randomization and utilities
- pathlib: File operations
- dataclasses, enum, typing: Type hints and structure

## License

MIT License

