"""
Practical examples for using the StallEngine.

These examples show real-world usage patterns with different APIs and strategies.
"""

from synthesis.staller import StallEngine, StallConfig


# ============================================================================
# Example 1: Basic Usage with Mock API (for testing)
# ============================================================================

def example_mock_api():
    """Quick test with mock API (no real API calls)."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Mock API that simulates responses."""
        # In real usage, this would call Claude, GPT-4, or local LLM
        length = int(200 + temperature * 300)  # Longer at higher temps
        return f"[Mock response to: {prompt[:50]}...] " + "Details. " * (length // 10)
    
    # Create engine with auto-strategy
    config = StallConfig(
        strategy="auto",
        time_budget_seconds=10.0,
        verbose=True
    )
    engine = StallEngine(mock_api, config)
    
    # Run stalling
    task = "What are the key challenges in distributed system design?"
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 1: Mock API Test")
    print(f"{'='*80}")
    print(f"Strategy used: {result.strategy_used}")
    print(f"Iterations: {result.iterations}")
    print(f"Samples generated: {result.samples_generated}")
    print(f"Quality improvement: {result.quality_improvement:.1%}")
    print(f"Time taken: {result.time_taken:.2f}s")
    print(f"Tokens used: {result.tokens_used}")
    print(f"\nReasoning trace ({len(result.reasoning_trace)} steps):")
    for i, trace in enumerate(result.reasoning_trace[:3], 1):
        print(f"  {i}. {trace[:70]}...")
    print(f"\nFinal output (first 200 chars):")
    print(f"  {result.final_output[:200]}...")


# ============================================================================
# Example 2: Real Anthropic Claude API
# ============================================================================

def example_claude_api():
    """Real example using Anthropic Claude API."""
    
    try:
        import anthropic
    except ImportError:
        print("Skipping Claude example (anthropic package not installed)")
        print("Install with: pip install anthropic")
        return
    
    def claude_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Wrapper around Anthropic Claude API."""
        client = anthropic.Anthropic()  # Uses ANTHROPIC_API_KEY env var
        
        response = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=max_tokens,
            system=system or "You are a helpful assistant.",
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        )
        return response.content[0].text
    
    # Test with self-consistency strategy
    config = StallConfig(
        strategy="self_consistency",
        n_samples=3,  # Quick test with 3 samples
        temperature_range=(0.3, 0.8),
    )
    engine = StallEngine(claude_api, config)
    
    task = "What's 17 * 23? Show the calculation."
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 2: Claude API (Self-Consistency for Math)")
    print(f"{'='*80}")
    print(f"Strategy: {result.strategy_used}")
    print(f"Samples: {result.samples_generated}")
    print(f"Answer: {result.final_output}")


# ============================================================================
# Example 3: Self-Consistency Strategy (Best for Factual Tasks)
# ============================================================================

def example_self_consistency():
    """Example using self-consistency strategy."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Simple mock that varies response based on temperature."""
        if "coffee" in prompt.lower():
            if temperature > 0.7:
                return "Coffee is a beverage made from roasted coffee beans"
            else:
                return "Coffee is a drink with caffeine"
        return "Generic response"
    
    config = StallConfig(
        strategy="self_consistency",
        n_samples=5,  # Generate 5 diverse responses
        temperature_range=(0.2, 0.9),  # High diversity
    )
    engine = StallEngine(mock_api, config)
    
    task = "Is coffee good for health?"
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 3: Self-Consistency Strategy")
    print(f"{'='*80}")
    print(f"Generated {result.samples_generated} diverse responses")
    print(f"Selected best by quality voting")
    print(f"Quality improvement: {result.quality_improvement:.1%}")


# ============================================================================
# Example 4: Chain-of-Draft Strategy (Best for Creative/Complex Tasks)
# ============================================================================

def example_chain_of_draft():
    """Example using chain-of-draft strategy."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Mock that simulates improving with each call."""
        if "critic" in prompt.lower() or "revise" in prompt.lower():
            return "Suggestion: Add more details. Use specific examples. Improve clarity."
        return "Initial draft: The topic is interesting and worth exploring further."
    
    config = StallConfig(
        strategy="chain_of_draft",
        max_iterations=3,  # 3 refinement rounds
        convergence_threshold=0.12,  # Stop at 12% improvement
    )
    engine = StallEngine(mock_api, config)
    
    task = "Write a short story about a robot learning to feel emotions"
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 4: Chain-of-Draft Strategy")
    print(f"{'='*80}")
    print(f"Refinement iterations: {result.iterations}")
    print(f"Quality improvement: {result.quality_improvement:.1%}")
    print(f"Reasoning trace:")
    for i, trace in enumerate(result.reasoning_trace, 1):
        print(f"  {i}. {trace[:60]}...")


# ============================================================================
# Example 5: Constitutional Loop (Best for Safety-Sensitive Tasks)
# ============================================================================

def example_constitutional():
    """Example using constitutional strategy."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Mock API for constitutional checking."""
        if "principle" in prompt.lower():
            return "✓ Principle satisfied. No violations found."
        if "fix" in prompt.lower():
            return "Fixed: Added citations. Acknowledged uncertainty. Improved clarity."
        return "Initial response to be checked."
    
    config = StallConfig(
        strategy="constitutional",
        max_iterations=2,  # 2 check-fix rounds
    )
    engine = StallEngine(mock_api, config)
    
    task = "Is artificial intelligence a threat to humanity?"
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 5: Constitutional Loop Strategy")
    print(f"{'='*80}")
    print(f"Principles checked: {result.iterations * 15}")  # ~15 per iteration
    print(f"Violations fixed: {len(result.reasoning_trace)}")
    print(f"Quality improvement: {result.quality_improvement:.1%}")


# ============================================================================
# Example 6: Budget-Force Strategy (Best for Guaranteed Quality)
# ============================================================================

def example_budget_force():
    """Example using budget-force strategy."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Mock that returns thinking tags."""
        if "think" in prompt.lower():
            thinking = "<thinking>" + "thinking " * 150 + "</thinking>"
            return thinking + "\n\nFinal answer: Based on the analysis above..."
        return "<thinking>thinking</thinking>\n\nResponse"
    
    config = StallConfig(
        strategy="budget_force",
        min_thinking_tokens=500,  # Force minimum thinking
    )
    engine = StallEngine(mock_api, config)
    
    task = "Analyze the philosophical implications of quantum mechanics"
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 6: Budget-Force Strategy")
    print(f"{'='*80}")
    print(f"Tokens used: {result.tokens_used}")
    print(f"Enforced minimum: {config.min_thinking_tokens}")
    print(f"Quality improvement: {result.quality_improvement:.1%}")


# ============================================================================
# Example 7: Devils-Advocate Strategy (Best for Challenging Assumptions)
# ============================================================================

def example_devils_advocate():
    """Example using devils-advocate strategy."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Mock for devils-advocate."""
        if "counter" in prompt.lower() or "devil" in prompt.lower():
            return "Counter-argument: While the original point is valid, consider..."
        if "integrate" in prompt.lower():
            return "Integrated response: Taking both perspectives into account..."
        return "Initial argument: Remote work improves productivity."
    
    config = StallConfig(
        strategy="devils_advocate",
        max_iterations=2,
    )
    engine = StallEngine(mock_api, config)
    
    task = "Should companies mandate office work?"
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 7: Devils-Advocate Strategy")
    print(f"{'='*80}")
    print(f"Critique-integration rounds: {result.iterations}")
    print(f"Arguments considered: {len(result.reasoning_trace)}")
    print(f"Quality improvement: {result.quality_improvement:.1%}")


# ============================================================================
# Example 8: Decomposer Strategy (Best for Complex Multi-Step Problems)
# ============================================================================

def example_decomposer():
    """Example using decomposer strategy."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        """Mock for decomposer."""
        if "subproblem" in prompt.lower() or "sub-task" in prompt.lower():
            return "Sub-solution: Approach to this aspect..."
        if "synthesize" in prompt.lower():
            return "Synthesized answer combining all sub-solutions..."
        return "Decomposing problem..."
    
    config = StallConfig(
        strategy="decompose",
        n_samples=4,  # Decompose into 4 sub-tasks
    )
    engine = StallEngine(mock_api, config)
    
    task = """
    Design a system for content moderation that:
    1. Handles multiple languages
    2. Detects context-dependent violations
    3. Appeals and human review
    4. Scales to billions of items per day
    """
    result = engine.stall(task)
    
    print(f"\n{'='*80}")
    print("Example 8: Decomposer Strategy")
    print(f"{'='*80}")
    print(f"Sub-tasks created: {result.samples_generated}")
    print(f"Sub-solutions synthesized: {result.iterations}")
    print(f"Quality improvement: {result.quality_improvement:.1%}")


# ============================================================================
# Example 9: Auto-Strategy Selection
# ============================================================================

def example_auto_strategy():
    """Example letting engine pick best strategy automatically."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        return f"Response to: {prompt[:40]}..."
    
    engine = StallEngine(mock_api)
    
    tasks = [
        "What is 456 + 789?",  # Should pick: self_consistency
        "Write a poem about the ocean",  # Should pick: chain_of_draft
        "Design a microservices architecture",  # Should pick: decompose
        "Is AI safe?",  # Should pick: constitutional
    ]
    
    print(f"\n{'='*80}")
    print("Example 9: Auto-Strategy Selection")
    print(f"{'='*80}")
    
    for task in tasks:
        strategy = engine._auto_select_strategy(task)
        print(f"Task: '{task[:40]}...'")
        print(f"  → Selected strategy: {strategy}\n")


# ============================================================================
# Example 10: Monitoring and Statistics
# ============================================================================

def example_monitoring():
    """Example showing monitoring and statistics."""
    
    def mock_api(prompt, system=None, temperature=0.0, max_tokens=2048):
        return "Response: " + "word " * 20
    
    config = StallConfig(strategy="auto")
    engine = StallEngine(mock_api, config)
    
    # Run multiple stalling operations
    tasks = [
        "Task 1: Math problem",
        "Task 2: Creative writing",
        "Task 3: Complex design",
    ]
    
    for task in tasks:
        result = engine.stall(task)
    
    # Get statistics
    stats = engine.get_stats()
    
    print(f"\n{'='*80}")
    print("Example 10: Monitoring & Statistics")
    print(f"{'='*80}")
    print(f"Total operations: {stats['total_calls']}")
    print(f"Total time: {stats['total_time']:.2f}s")
    print(f"Strategies used:")
    for strategy, count in stats['strategies_used'].items():
        print(f"  - {strategy}: {count} times")
    if 'avg_quality_improvement' in stats:
        print(f"Average quality improvement: {stats['avg_quality_improvement']:.1%}")


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    print("\n" + "=" * 80)
    print("STALLER ENGINE - PRACTICAL EXAMPLES")
    print("=" * 80)
    
    # Run examples
    example_mock_api()
    # example_claude_api()  # Uncomment to use real Claude API
    example_self_consistency()
    example_chain_of_draft()
    example_constitutional()
    example_budget_force()
    example_devils_advocate()
    example_decomposer()
    example_auto_strategy()
    example_monitoring()
    
    print(f"\n{'='*80}")
    print("All examples completed!")
    print(f"{'='*80}\n")
