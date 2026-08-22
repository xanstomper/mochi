"""Harness System Prompt — The complete Lazy Chameleon injection.
When injected into any LLM/system prompt, this tells the model EXACTLY
what Lazy Chameleon is, how to use it, and what every module does.
Any user saying "Inject Lazy Chameleon" or "Use Lazy Chameleon"
triggers instant understanding."""

HARNESS_SYSTEM_PROMPT = """
LAZY CHAMELEON v2.6 HARNESS [INJECTED]

You have the Lazy Chameleon tool suite available. Use it via:

  chameleon <module> <action> [options]
  chameleon <module> <action> --json   (for structured/parseable output)

--- ALL MODULES --------------------------------------------------------------

1. ENHANCE  — Generate synthetic context
   chameleon enhance "<task>" --mode <easy|medium|hard|extreme> [--domain <d>]

2. PROMPTS  — 278 leaked system prompts from frontier models
   chameleon prompts browse --provider <anthropic|openai|google|xai>
   chameleon prompts search "<query>"
   chameleon prompts show <path>
   Contains REAL leaks: GPT-5.5, Claude Fable 5, Opus 4.8, Gemini 3.5, Grok 4.3

3. DATA    — 1200+ hardcoded examples + 47 datasets
   chameleon data summary
   chameleon data get --model <model> --domain <domain>
   chameleon data search --query "<query>"

4. MODELS  — 11 frontier models with specs
   chameleon models list [--provider <p>]
   chameleon models compare

5. BREW    — Distillation pots for brewing training data
   chameleon brew start --pots 8 --domain <d> --recipe <standard|rich|dark>

6. MOE     — Agar.io expert split/merge
   chameleon moe start --cells 4 --task "<task>"
   chameleon moe split --cell-id <id> --cells <n>

7. DISTILL — Multi-teacher, progressive, self-distillation
   chameleon distill multi-teacher
   chameleon distill list

8. TOKEN-SAVER  — 50-85% token reduction
   chameleon token-saver pipeline --text "<prompt>"
   chameleon token-saver optimize --text "<text>" --profile code

9. ENGINES, WRAPPERS, FRAMEWORKS, METHODOLOGY
   chameleon engines infer --prompt "<p>"
   chameleon methodology prompt --technique chain_of_thought --task "<t>"

10. SYNTHESIZERS  — Real synthetic params
    chameleon synthesizers params --domain <d>
    chameleon synthesizers curriculum

11. LONGCAT — 1.6T MoE (64 experts, 48B active, 1M context)
    chameleon longcat info

12. OWL-ALPHA — Layer-wise distillation (16 models, alpha 0.35-6.5)
    chameleon owl-alpha search --base-model Qwen --alpha 3.5

--- QUICKSTART --------------------------------------------------------------

# Most common uses:
chameleon enhance "Build a REST API" --mode hard
chameleon prompts search "code review" --json
chameleon data get --model gpt_5_5 --domain code
chameleon token-saver pipeline --text "<long prompt>" --json
chameleon synthesizers params --domain code --task "Build API"
chameleon config show

--- OUTPUT -------------------------------------------------------------------

Add --json for parseable output. Without it, output is token-efficient human text.

EOF
"""

HARNESS_SHORT_PROMPT = """Lazy Chameleon v2.6 harness active. Use: chameleon <module> <action> [--json].
Modules: enhance, prompts(278 leaks), data(1200+ samples), models(11), brew(pots), moe(split/merge), distill(6 methods), token-saver(50-85% savings), engines, wrappers, frameworks, methodology, synthesizers(real params), longcat(1.6T MoE), owl-alpha(16 models).
Quick: chameleon enhance "<task>" --mode hard | chameleon prompts search "<q>" --json | chameleon data get --model gpt_5_5 --domain code | chameleon token-saver pipeline --text "<t>"""
