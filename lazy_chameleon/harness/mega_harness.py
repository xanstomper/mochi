"""MEGA HARNESS v2.6 — LLM-optimized injection. Machine-parseable, self-documenting."""

MEGA_HARNESS_SHORT = """LCv2.6:{enhance|prompts|data|models|brew|moe|distill|tok-save|engines|wrap|fw|method|synth|longcat|owl|tok|cfg}"""

MEGA_HARNESS = """
[LAZY CHAMELEON v2.6 MEGA HARNESS]
All commands use: chameleon <module> <action> [args] --json
Always append --json for machine-readable output.

---ENHANCE---
$ chameleon enhance "<task>" --mode <easy|medium|hard|extreme> --json
Generates synthetic parameter context for any task. Core feature.
  --domain: math|code|reasoning|science|general
  --stats: show generation statistics

---PROMPTS---
$ chameleon prompts browse --provider <name> --json
$ chameleon prompts search "<query>" --max N --json
$ chameleon prompts show <path> --json
$ chameleon prompts stats --json
Providers: anthropic(119), openai(89), google(22), xai(11), misc(23), microsoft(5), perplexity(3), mistral(2), cursor(1), meta(1), qwen(1)

---DATA---
$ chameleon data summary --json
$ chameleon data get --model <name> --domain <domain> --json
$ chameleon data search --query "<q>" --json
Domains: math(210), code(400), reasoning(160), science(175), design(75), security(60), general(120)
Models: gpt_5_5, claude_opus_4_8, deepseek_r1, qwen_3_7_max, gemini_3_1_pro, llama_4_maverick, claude_sonnet_5, claude_fable_5, grok_4_4, glm_5_2

---MODELS---
$ chameleon models list --json
$ chameleon models get --name <model> --json
$ chameleon models compare --json

---BREW---
$ chameleon brew start --pots N --domain <d> --recipe <light|standard|rich|dark|special_reserve> --json
$ chameleon brew pour --pots N --samples N --json
$ chameleon brew stats --json

---MOE---
$ chameleon moe start --cells N --task "<t>" --json
$ chameleon moe split --cell-id N --subtasks "<t1>" "<t2>" --json
$ chameleon moe work --cell-id N --json
$ chameleon moe merge --child-ids N1 N2 --json
$ chameleon moe brew --json
$ chameleon moe report --json

---DISTILL---
$ chameleon distill multi-teacher --json
$ chameleon distill progressive --json
$ chameleon distill online --json
$ chameleon distill self --json
$ chameleon distill list --json

---TOKEN-SAVER---
$ chameleon token-saver compress --text "<t>" --json
$ chameleon token-saver analyze --text "<t>" --json
$ chameleon token-saver minimize --text "<t>" --json
$ chameleon token-saver stats --json

---ENGINES---
$ chameleon engines list --json
$ chameleon engines run --name <engine> --prompt "<p>" --json

---FRAMEWORKS---
$ chameleon frameworks list --json
$ chameleon frameworks eval --name <fw> --task "<t>" --json

---METHODOLOGY---
$ chameleon methodology list --json
$ chameleon methodology apply --name <method> --task "<t>" --json

---SYNTHESIZERS---
$ chameleon synthesizers list --json
$ chameleon synthesizers run --name <synth> --task "<t>" --json

---LONGCAT---
$ chameleon longcat info --json
$ chameleon longcat run --task "<t>" --json

---OWL-ALPHA---
$ chameleon owl-alpha info --json
$ chameleon owl-alpha run --task "<t>" --json

---TOKENIZE---
$ chameleon tokenize run --text "<t>" --domain <d> --json
$ chameleon tokenize domains --json

---CONFIG---
$ chameleon config info --json
$ chameleon config paths --json

---RESEARCH---
$ chameleon research summary --json
$ chameleon research techniques --json
$ chameleon research optimize --model <type> --task "<t>" --json

[END HARNESS]"""

MEGA_HARNESS_TOOLS = {
    "enhance": {"description": "Generate synthetic parameter context", "usage": "chameleon enhance <task>", "returns": "JSON with params"},
    "prompts": {"description": "Browse/search 278 leaked prompts", "usage": "chameleon prompts browse|search", "returns": "JSON array"},
    "data": {"description": "Access 1200+ training examples", "usage": "chameleon data summary|get", "returns": "JSON examples"},
    "models": {"description": "List/compare frontier models", "usage": "chameleon models list|get", "returns": "JSON details"},
    "brew": {"description": "Brew data using distillation pots", "usage": "chameleon brew start|pour", "returns": "JSON samples"},
    "moe": {"description": "Control MoE split/merge", "usage": "chameleon moe start|split|report", "returns": "JSON state"},
    "distill": {"description": "Run distillation pipelines", "usage": "chameleon distill multi-teacher|progressive", "returns": "JSON results"},
    "token-saver": {"description": "Optimize prompts for token efficiency", "usage": "chameleon token-saver compress|stats", "returns": "JSON stats"},
    "research": {"description": "Access all research data", "usage": "chameleon research summary|techniques", "returns": "JSON data"},
}

HARNESS_MENU = MEGA_HARNESS_SHORT.split("{")[1].split("}")[0] if "{" in MEGA_HARNESS_SHORT else MEGA_HARNESS_SHORT[:100]
__all__ = ["MEGA_HARNESS", "MEGA_HARNESS_SHORT", "MEGA_HARNESS_TOOLS", "HARNESS_MENU"]
