# StallEngine Quick Start Guide

## Installation

The StallEngine is located at `/home/jewboy420/lazy_chameleon/synthesis/staller.py`

### Prerequisites

```bash
# Python 3.8+
python3 --version

# Optional: For Claude API integration
pip install anthropic

# Optional: For OpenAI integration
pip install openai
```

## 30-Second Example

```python
from synthesis.staller import StallEngine, StallConfig

# Define your API
def my_api(prompt, system=None, temperature=0.0, max_tokens=2048):
    # Call your LLM here (Claude, GPT-4, Ollama, etc.)
    return llm_call(prompt, temperature=temperature, max_tokens=max_tokens)

# Create engine
engine = StallEngine(my_api)

# Run stalling
result = engine.stall("Your task here")

# Get result
print(result.final_output)
print(f"Quality improved by {result.quality_improvement:.1%}")
```

## 5 Common Patterns

### 1. Best Answer for Math/Factual Tasks
```python
config = StallConfig(strategy="self_consistency", n_samples=5)
engine = StallEngine(api, config)
result = engine.stall("What is the square root of 2?")
# Uses voting to pick best answer from 5 diverse responses
```

### 2. Best Writing for Creative Tasks
```python
config = StallConfig(strategy="chain_of_draft", max_iterations=4)
engine = StallEngine(api, config)
result = engine.stall("Write a short story about time travel")
# Iteratively refines through critique-revise loops
```

### 3. Check Principles for Safety Tasks
```python
config = StallConfig(strategy="constitutional")
engine = StallEngine(api, config)
result = engine.stall("Is AI safe?")
# Checks against 15 reasoning principles, fixes violations
```

### 4. Guaranteed Quality for Important Tasks
```python
config = StallConfig(strategy="budget_force", min_thinking_tokens=1000)
engine = StallEngine(api, config)
result = engine.stall("Critical decision analysis")
# Forces minimum compute spending
```

### 5. Best Overall for Unknown Tasks
```python
config = StallConfig(strategy="auto")
engine = StallEngine(api, config)
result = engine.stall("Any task")
# Engine picks best strategy automatically
```

## Real API Integration

### Anthropic Claude
```python
import anthropic

def claude_api(prompt, system=None, temperature=0.0, max_tokens=2048):
    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=max_tokens,
        system=system or "You are helpful.",
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
    )
    return response.content[0].text

engine = StallEngine(claude_api)
result = engine.stall("Your task")
```

### OpenAI GPT-4
```python
import openai

def openai_api(prompt, system=None, temperature=0.0, max_tokens=2048):
    response = openai.ChatCompletion.create(
        model="gpt-4-turbo",
        max_tokens=max_tokens,
        temperature=temperature,
        messages=[
            {"role": "system", "content": system or "You are helpful."},
            {"role": "user", "content": prompt}
        ]
    )
    return response.choices[0].message.content

engine = StallEngine(openai_api)
result = engine.stall("Your task")
```

### Local LLM (Ollama)
```python
import requests

def ollama_api(prompt, system=None, temperature=0.0, max_tokens=2048):
    response = requests.post(
        "http://localhost:11434/api/generate",
        json={
            "model": "mistral",
            "prompt": (system or "") + "\n\n" + prompt,
            "temperature": temperature,
            "stream": False,
        }
    )
    return response.json()["response"]

engine = StallEngine(ollama_api)
result = engine.stall("Your task")
```

## Configuration Options

```python
StallConfig(
    strategy="auto",              # "auto" | "self_consistency" | "chain_of_draft" |
                                  # "constitutional" | "budget_force" | "devils_advocate" |
                                  # "decompose"
    
    n_samples=5,                  # For self_consistency: number of diverse responses
    max_iterations=4,             # For refinement strategies: iteration count
    min_thinking_tokens=800,      # For budget_force: minimum compute
    
    temperature_range=(0.3, 0.9), # Range for sampling diversity
    convergence_threshold=0.15,   # Stop refinement at this improvement threshold
    time_budget_seconds=120.0,    # Max time allowed
    verbose=False                 # Show reasoning traces
)
```

## Result Structure

```python
result.final_output           # The best response
result.strategy_used          # Which strategy ran
result.iterations             # Refinement cycles completed
result.samples_generated      # Responses generated
result.quality_improvement    # Estimated % improvement
result.reasoning_trace        # List of reasoning steps
result.tokens_used            # Tokens consumed
result.time_taken            # Seconds elapsed
```

## Picking the Right Strategy

| Task Type | Strategy | Why |
|-----------|----------|-----|
| Math/Logic/Factual | `self_consistency` | Voting picks best answer |
| Writing/Creative | `chain_of_draft` | Refinement improves quality |
| Safety/Ethics | `constitutional` | Checks against principles |
| Complex Design | `decompose` | Solves sub-tasks in parallel |
| General Tasks | `auto` | Engine picks best strategy |
| Guaranteed Quality | `budget_force` | Forces minimum thinking |
| Challenging Ideas | `devils_advocate` | Adversarial critique |

## Common Questions

**Q: Do I need to modify my API calls?**
No! The engine accepts a simple callable with signature:
```python
def api_fn(prompt, system=None, temperature=0.0, max_tokens=2048) -> str
```

**Q: How much will this cost?**
Token usage is 2-3x compared to single API call, depending on strategy.

**Q: How long does it take?**
Typically 2-8 seconds with network latency. Adjust `time_budget_seconds` to control.

**Q: Can I use this in production?**
Yes! It's designed for production. All API calls are real. Async support coming soon.

**Q: Will this work with my LLM?**
Yes! As long as it supports temperature and max_tokens parameters.

## Troubleshooting

**Error: "Strategy failed"**
- Ensure API function works standalone
- Check network connectivity
- Verify API credentials

**Low quality improvement**
- Try different strategy: `config.strategy = "decompose"`
- Increase iterations: `config.max_iterations = 6`
- Increase time budget: `config.time_budget_seconds = 60.0`

**Timeout issues**
- Reduce time budget: `config.time_budget_seconds = 30.0`
- Reduce iterations: `config.max_iterations = 2`
- Try faster strategy: `config.strategy = "budget_force"`

## Next Steps

1. See `STALLER_GUIDE.md` for comprehensive documentation
2. See `examples_staller.py` for more examples
3. Read source code at `staller.py` for implementation details

## Support

For issues or questions:
- Check the examples in `examples_staller.py`
- Review the full guide in `STALLER_GUIDE.md`
- Inspect the source in `staller.py`

---

**Ready to improve your inference quality?**

Start with Example 1 from STALLER_GUIDE.md and adapt to your needs!
