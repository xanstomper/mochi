# Mochi Dataset Strategy — verified open datasets and how they improve the agent

Every dataset below was **existence-verified via the HuggingFace API on
2026-10-21** (HTTP 200 + download counts from the API metadata). Gated sets
are marked. This is the pool Mochi's practice/mining loops draw from.

## How Mochi consumes them (no fine-tuning required)

Mochi improves through its **closed flywheel** (curator → pitfall mining →
lesson graduation → self-patch → league report). Datasets feed that flywheel
in three ways:

1. **`mochi practice` (MCH-216)** — dataset-shaped tasks with machine-checkable
   verify commands run through the real agent in throwaway workspaces. Failures
   feed `recordLesson`/`recordSkillFailure` exactly like real-task failures, so
   practice produces mined skills. Seed tasks are offline (no download needed).
2. **Trace mining material (MCH-217)** — `fetchDatasetSlice(datasetId, n)`
   streams real rows keylessly (datasets-server API) for building additional
   practice tasks or few-shot examples.
3. **Training-data export (future)** — Mochi run traces (in `.mochi/`) are
   already in a lessons/skills format convertible to SFT/DPO pairs.

## Verified catalog

| Dataset | Focus | Downloads | What it trains |
|---|---|---|---|
| SWE-bench/SWE-bench_Verified | swe | 129,605 | Human-verified repo bug fixes; the canonical project-scale coding benchmark |
| SWE-bench/SWE-smith | swe | 81,802 | Large-scale synthetic SWE instances (bug injection → fix) |
| nebius/SWE-rebench | swe | 43,572 | Continuously-refreshed verifiable SWE tasks |
| R2E-Gym/R2E-Gym | swe | 30,450 | Repo environments + verification scripts for SWE practice |
| SWE-Gym/SWE-Gym | swe | 29,281 | Real repo bug-fix trajectories with runnable repro tests |
| nvidia/OpenMathInstruct-2 | math | 103,715 | 14M math problem/solution pairs |
| HuggingFaceH4/MATH-500 | math | 185,202 | Competition math with exact answers |
| Magicoder-OSS-Instruct-75K (ise-uiuc) | coding | 46,787 | OSS-seeded code instruction pairs |
| nvidia/OpenCodeInstruct | coding | 42,687 | Instruction→solution+test pairs |
| PrimeIntellect/verifiable-coding-problems | coding | 4,232 | Problems with machine-checkable answers (RLVR-ready) |
| NousResearch/hermes-function-calling-v1 | tool-use | 56,387 | Multi-turn tool-use, varied schemas |
| Salesforce/xlam-function-calling-60k | tool-use | 19,630 | 60k function-calling scenarios |
| HuggingFaceTB/smoltalk | general | 49,650 | Modern everyday + specialized chat mixture |
| allenai/tulu-3-sft-mixture | general | 30,309 | Broad instruction-following (AI2 Tulu 3) |
| teknium/OpenHermes-2.5 | general | 14,639 | 1M curated general instruct pairs |
| HuggingFaceH4/ultrafeedback_binarized | preferences | 20,312 | Chosen/rejected pairs — answer-quality judgment |
| openbmb/UltraFeedback | preferences | 12,507 | Preference pairs for self-critique calibration |
| open-r1/Mixture-of-Thoughts | reasoning | 17,641 | Long-form R1-distilled reasoning traces |
| simplescaling/s1K-1.1 | reasoning | 24,376 | 1k hard-reasoning problems with verified CoT |

**Gated (need HF auth, listed for completeness):** `openbmb/UltraInteract`
(multi-turn verified interaction trees), `xlang-ai/OSWorld` (real OS-automation
tasks — maps to Mochi's computer/device tools).

## Priorities for making Mochi best-in-class

- **Coding / complex software projects**: SWE-Gym + SWE-smith + SWE-rebench are
  the highest-value sets — their task shape (bug → fix → repro test passes) is
  exactly Mochi's verify-gate loop. Practicing on them hardens the verify +
  self-patch path.
- **Reasoning**: s1K-1.1 and Mixture-of-Thoughts provide verified long-CoT
  traces; use as few-shot anchors in the `think` tool and plan drafts.
- **Tool-use / automated tasks**: xlam + hermes-fc for argument precision —
  pair with Mochi's 77-tool surface by generating practice tasks that call
  real Mochi tools against the contract fixtures.
- **Reverse engineering**: no large open RE-agent dataset exists yet (RE-bench
  is gated). Mochi's RE practice uses the obfuscation-decode seed task shape;
  expand by mining CTF-style repos (picoCTF-style writeups) rather than HF.
