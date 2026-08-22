"""Trajectory Collector — async batch collection from teacher APIs at scale."""
from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .distillation_dataset import TrajectoryRecord, TrajectoryQualityScorer


# ─── Cost table (July 2025 estimates, USD per 1M tokens) ────────────────────

PROVIDER_PRICING: Dict[str, Dict[str, float]] = {
    "anthropic": {
        "claude-opus-4-8":      {"input": 15.0,  "output": 75.0},
        "claude-sonnet-5":      {"input": 3.0,   "output": 15.0},
        "claude-haiku-4-5-20251001": {"input": 0.8, "output": 4.0},
    },
    "openai": {
        "gpt-4o":               {"input": 2.5,   "output": 10.0},
        "gpt-4o-mini":          {"input": 0.15,  "output": 0.6},
        "o3":                   {"input": 10.0,  "output": 40.0},
        "o4-mini":              {"input": 1.1,   "output": 4.4},
    },
    "deepseek": {
        "deepseek-r1":          {"input": 0.55,  "output": 2.19},
        "deepseek-v3":          {"input": 0.27,  "output": 1.10},
    },
    "google": {
        "gemini-2.0-flash":     {"input": 0.1,   "output": 0.4},
        "gemini-2.5-pro":       {"input": 1.25,  "output": 5.0},
    },
    "openrouter": {
        "default":              {"input": 1.0,   "output": 4.0},
    },
    "together": {
        "default":              {"input": 0.9,   "output": 0.9},
    },
}


def estimate_cost(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate API cost in USD."""
    p = PROVIDER_PRICING.get(provider, PROVIDER_PRICING["openrouter"])
    m = p.get(model, p.get("default", {"input": 1.0, "output": 4.0}))
    return (input_tokens * m["input"] + output_tokens * m["output"]) / 1_000_000


# ─── Collection config ───────────────────────────────────────────────────────

@dataclass
class CollectionConfig:
    """Configuration for a collection run."""
    teacher_provider: str = "anthropic"
    teacher_model: str = "claude-opus-4-8"
    n_samples_per_task: int = 8      # diversity via multiple samples
    temperature: float = 0.9
    max_tokens: int = 8192
    timeout_s: float = 120.0
    max_retries: int = 3
    retry_backoff: float = 2.0
    batch_size: int = 10             # concurrent API calls
    rate_limit_rpm: int = 60         # requests per minute
    max_cost_usd: float = 100.0      # hard stop if cost exceeds this
    system_prompt: str = (
        "You are an expert reasoning assistant. For each question, first think step-by-step "
        "through the problem in detail, showing your complete reasoning process. "
        "Then provide a clear, precise final answer. "
        "Format: [REASONING]...your thinking...[/REASONING]\n[ANSWER]...final answer...[/ANSWER]"
    )
    add_chain_of_thought: bool = True
    collect_logprobs: bool = False   # requires provider support
    domain: str = "general"
    source_name: str = ""


# ─── Main collector ──────────────────────────────────────────────────────────

class TrajectoryCollector:
    """
    Async bulk trajectory collector for distillation data.

    Usage:
        collector = TrajectoryCollector(api_key="...", config=CollectionConfig(...))
        records = await collector.collect(task_bank)
        dataset.add_bulk(records)

    Features:
    - Rate-limited async batching (RPM controlled)
    - Auto cost tracking with hard-stop
    - Resumable via SQLite checkpoint
    - Self-consistency scoring across N samples
    - Quality scoring on every record
    """

    def __init__(
        self,
        api_key: str = "",
        config: CollectionConfig = None,
        checkpoint_db: str = "~/.lazy_chameleon/collection_checkpoint.db",
        progress_fn: Optional[Callable] = None,
    ):
        self.api_key = api_key
        self.config = config or CollectionConfig()
        self.scorer = TrajectoryQualityScorer()
        self.progress = progress_fn or (lambda msg: print(f"[collector] {msg}"))
        self._total_cost = 0.0
        self._total_records = 0

        # Checkpoint DB for resumable runs
        self._ckpt_path = Path(checkpoint_db).expanduser()
        self._ckpt_path.parent.mkdir(parents=True, exist_ok=True)
        self._ckpt = sqlite3.connect(str(self._ckpt_path))
        self._ckpt.execute("""
            CREATE TABLE IF NOT EXISTS completed (
                task_hash TEXT PRIMARY KEY,
                record_ids TEXT,
                timestamp TEXT
            )
        """)
        self._ckpt.commit()

    # ── Public API ────────────────────────────────────────────────────────────

    async def collect(
        self,
        task_bank: List[str],
        resume: bool = True,
    ) -> List[TrajectoryRecord]:
        """Collect trajectories for all tasks in task_bank."""
        self.progress(f"Starting collection: {len(task_bank)} tasks, "
                      f"{self.config.n_samples_per_task} samples each, "
                      f"provider={self.config.teacher_provider}, "
                      f"model={self.config.teacher_model}")

        # Filter already-completed tasks if resuming
        pending = task_bank
        if resume:
            pending = [t for t in task_bank if not self._is_completed(t)]
            self.progress(f"Resume: {len(task_bank) - len(pending)} already done, {len(pending)} pending")

        all_records: List[TrajectoryRecord] = []
        batches = [pending[i:i + self.config.batch_size]
                   for i in range(0, len(pending), self.config.batch_size)]

        for batch_idx, batch in enumerate(batches):
            self.progress(f"Batch {batch_idx + 1}/{len(batches)} ({len(batch)} tasks)…")

            # Check cost limit
            if self._total_cost >= self.config.max_cost_usd:
                self.progress(f"Cost limit reached (${self._total_cost:.2f}). Stopping.")
                break

            batch_records = await self._collect_batch(batch)
            all_records.extend(batch_records)
            self._total_records += len(batch_records)

            # Rate limiting between batches
            await asyncio.sleep(60.0 / max(self.config.rate_limit_rpm, 1))

        self.progress(
            f"Collection complete: {self._total_records} records, "
            f"${self._total_cost:.4f} total cost"
        )
        return all_records

    async def collect_single(self, task: str) -> List[TrajectoryRecord]:
        """Collect N samples for a single task."""
        return await self._collect_task(task)

    def estimate_cost(self, n_tasks: int) -> dict:
        """Estimate total cost before running."""
        avg_prompt_tokens = 500     # rough estimate
        avg_completion_tokens = self.config.max_tokens // 2
        total_calls = n_tasks * self.config.n_samples_per_task
        cost_per_call = estimate_cost(
            self.config.teacher_provider,
            self.config.teacher_model,
            avg_prompt_tokens,
            avg_completion_tokens,
        )
        total_cost = cost_per_call * total_calls
        return {
            "n_tasks": n_tasks,
            "n_samples_per_task": self.config.n_samples_per_task,
            "total_calls": total_calls,
            "cost_per_call_usd": round(cost_per_call, 6),
            "total_cost_usd": round(total_cost, 4),
            "at_100k_tasks": round(cost_per_call * 100_000 * self.config.n_samples_per_task, 2),
            "model": self.config.teacher_model,
            "provider": self.config.teacher_provider,
        }

    # ── Internal ─────────────────────────────────────────────────────────────

    async def _collect_batch(self, tasks: List[str]) -> List[TrajectoryRecord]:
        """Collect all tasks in batch concurrently."""
        coros = [self._collect_task(task) for task in tasks]
        results = await asyncio.gather(*coros, return_exceptions=True)
        records: List[TrajectoryRecord] = []
        for task, result in zip(tasks, results):
            if isinstance(result, Exception):
                self.progress(f"Task failed: {task[:50]}… Error: {result}")
            else:
                records.extend(result)
                self._mark_completed(task, [r.id for r in result])
        return records

    async def _collect_task(self, task: str) -> List[TrajectoryRecord]:
        """Collect N samples for one task with self-consistency scoring."""
        responses: List[Tuple[str, float]] = []  # (text, latency_ms)

        for sample_idx in range(self.config.n_samples_per_task):
            for attempt in range(self.config.max_retries):
                try:
                    text, latency, in_tok, out_tok = await self._call_api(task)
                    responses.append((text, latency, in_tok, out_tok))
                    break
                except Exception as e:
                    if attempt < self.config.max_retries - 1:
                        await asyncio.sleep(self.config.retry_backoff ** attempt)
                    else:
                        self.progress(f"Failed after {self.config.max_retries} retries: {e}")

        if not responses:
            return []

        # Score self-consistency across samples
        consistency = self._score_consistency([r[0] for r in responses])

        records: List[TrajectoryRecord] = []
        for idx, (text, latency, in_tok, out_tok) in enumerate(responses):
            reasoning, answer = self._parse_response(text)
            record = TrajectoryRecord(
                id=str(uuid.uuid4()),
                source_task=task,
                teacher_model=self.config.teacher_model,
                teacher_provider=self.config.teacher_provider,
                prompt=self._build_prompt(task),
                reasoning_trace=reasoning,
                final_answer=answer,
                token_count=in_tok + out_tok,
                prompt_tokens=in_tok,
                completion_tokens=out_tok,
                cost_usd=estimate_cost(
                    self.config.teacher_provider,
                    self.config.teacher_model,
                    in_tok, out_tok,
                ),
                latency_ms=latency,
                domain=self.config.domain,
                source_name=self.config.source_name,
                consistency_score=consistency,
                timestamp=datetime.now(),
            )
            # Score quality
            record.quality_score = self.scorer.score(record)
            diff = self.scorer.score_difficulty(record)
            record.difficulty_score = diff
            record.difficulty_bucket = self.scorer.bucket_difficulty(diff)

            self._total_cost += record.cost_usd
            records.append(record)

        return records

    async def _call_api(self, task: str) -> Tuple[str, float, int, int]:
        """Call the teacher API. Returns (text, latency_ms, in_tokens, out_tokens)."""
        prompt = self._build_prompt(task)
        t0 = time.time()

        provider = self.config.teacher_provider

        if provider == "anthropic":
            text, in_tok, out_tok = await self._call_anthropic(prompt)
        elif provider == "openai":
            text, in_tok, out_tok = await self._call_openai(prompt)
        elif provider == "deepseek":
            text, in_tok, out_tok = await self._call_openai_compat(
                prompt, base_url="https://api.deepseek.com/v1"
            )
        elif provider == "google":
            text, in_tok, out_tok = await self._call_google(prompt)
        elif provider in ("openrouter", "together"):
            base_urls = {
                "openrouter": "https://openrouter.ai/api/v1",
                "together": "https://api.together.xyz/v1",
            }
            text, in_tok, out_tok = await self._call_openai_compat(
                prompt, base_url=base_urls[provider]
            )
        else:
            # Generic OpenAI-compatible
            text, in_tok, out_tok = await self._call_openai_compat(prompt)

        latency = (time.time() - t0) * 1000
        return text, latency, in_tok, out_tok

    async def _call_anthropic(self, prompt: str) -> Tuple[str, int, int]:
        try:
            import anthropic
            client = anthropic.AsyncAnthropic(api_key=self.api_key)
            msg = await client.messages.create(
                model=self.config.teacher_model,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
                system=self.config.system_prompt,
                messages=[{"role": "user", "content": prompt}],
            )
            text = msg.content[0].text if msg.content else ""
            return text, msg.usage.input_tokens, msg.usage.output_tokens
        except ImportError:
            return self._mock_response(prompt), 500, 200

    async def _call_openai(self, prompt: str) -> Tuple[str, int, int]:
        try:
            import openai
            client = openai.AsyncOpenAI(api_key=self.api_key)
            resp = await client.chat.completions.create(
                model=self.config.teacher_model,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
                messages=[
                    {"role": "system", "content": self.config.system_prompt},
                    {"role": "user", "content": prompt},
                ],
            )
            text = resp.choices[0].message.content or ""
            usage = resp.usage
            return text, usage.prompt_tokens, usage.completion_tokens
        except ImportError:
            return self._mock_response(prompt), 500, 200

    async def _call_openai_compat(
        self, prompt: str, base_url: str = "https://api.openai.com/v1"
    ) -> Tuple[str, int, int]:
        try:
            import openai
            client = openai.AsyncOpenAI(api_key=self.api_key, base_url=base_url)
            resp = await client.chat.completions.create(
                model=self.config.teacher_model,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
                messages=[
                    {"role": "system", "content": self.config.system_prompt},
                    {"role": "user", "content": prompt},
                ],
            )
            text = resp.choices[0].message.content or ""
            usage = resp.usage
            return text, usage.prompt_tokens if usage else 500, usage.completion_tokens if usage else 200
        except ImportError:
            return self._mock_response(prompt), 500, 200

    async def _call_google(self, prompt: str) -> Tuple[str, int, int]:
        try:
            import google.generativeai as genai
            genai.configure(api_key=self.api_key)
            model = genai.GenerativeModel(self.config.teacher_model)
            resp = await model.generate_content_async(
                f"{self.config.system_prompt}\n\n{prompt}",
                generation_config=genai.GenerationConfig(
                    temperature=self.config.temperature,
                    max_output_tokens=self.config.max_tokens,
                ),
            )
            text = resp.text or ""
            # Google doesn't always return token counts
            in_tok = len(prompt.split()) * 1.3
            out_tok = len(text.split()) * 1.3
            return text, int(in_tok), int(out_tok)
        except ImportError:
            return self._mock_response(prompt), 500, 200

    def _build_prompt(self, task: str) -> str:
        if self.config.add_chain_of_thought:
            return (
                f"{task}\n\n"
                "Think through this step-by-step before giving your final answer. "
                "Show all your reasoning in detail."
            )
        return task

    def _parse_response(self, text: str) -> Tuple[str, str]:
        """Extract reasoning trace and final answer from response."""
        # Try structured format first
        import re
        reasoning_match = re.search(r'\[REASONING\](.*?)\[/REASONING\]', text, re.DOTALL)
        answer_match = re.search(r'\[ANSWER\](.*?)\[/ANSWER\]', text, re.DOTALL)

        if reasoning_match and answer_match:
            return reasoning_match.group(1).strip(), answer_match.group(1).strip()

        # Try <think> tags (DeepSeek style)
        think_match = re.search(r'<think>(.*?)</think>', text, re.DOTALL)
        if think_match:
            reasoning = think_match.group(1).strip()
            answer = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
            return reasoning, answer

        # Fallback: split at last paragraph
        parts = text.rsplit('\n\n', 1)
        if len(parts) == 2 and len(parts[0]) > 100:
            return parts[0].strip(), parts[1].strip()

        # Last resort: everything is reasoning, summary is answer
        sentences = text.split('. ')
        if len(sentences) > 3:
            return '. '.join(sentences[:-1]).strip(), sentences[-1].strip()

        return text.strip(), text.strip()

    def _score_consistency(self, responses: List[str]) -> float:
        """Score self-consistency across multiple responses."""
        if len(responses) < 2:
            return 0.5

        # Extract final sentences as "answers"
        finals = [r.split('\n')[-1].strip() for r in responses if r]

        # Token overlap between all pairs
        overlaps: List[float] = []
        for i in range(len(finals)):
            for j in range(i + 1, len(finals)):
                a = set(finals[i].lower().split())
                b = set(finals[j].lower().split())
                if a and b:
                    overlap = len(a & b) / max(len(a | b), 1)
                    overlaps.append(overlap)

        return round(sum(overlaps) / max(len(overlaps), 1), 4)

    def _mock_response(self, task: str) -> str:
        """Mock response for testing without API keys."""
        return (
            f"[REASONING]\nLet me think through this step by step.\n"
            f"The task is: {task[:100]}\n"
            f"Step 1: Analyze the problem.\n"
            f"Step 2: Consider approaches.\n"
            f"Step 3: Apply the best approach.\n"
            f"[/REASONING]\n"
            f"[ANSWER]\nBased on my analysis, the answer is derived from careful reasoning.\n[/ANSWER]"
        )

    def _is_completed(self, task: str) -> bool:
        import hashlib
        h = hashlib.sha256(task.encode()).hexdigest()
        return bool(self._ckpt.execute("SELECT 1 FROM completed WHERE task_hash=?", (h,)).fetchone())

    def _mark_completed(self, task: str, record_ids: List[str]):
        import hashlib
        h = hashlib.sha256(task.encode()).hexdigest()
        self._ckpt.execute(
            "INSERT OR REPLACE INTO completed VALUES (?,?,?)",
            (h, json.dumps(record_ids), datetime.now().isoformat())
        )
        self._ckpt.commit()

    def get_stats(self) -> dict:
        return {
            "total_collected": self._total_records,
            "total_cost_usd": round(self._total_cost, 6),
            "config": {
                "provider": self.config.teacher_provider,
                "model": self.config.teacher_model,
                "n_samples": self.config.n_samples_per_task,
            }
        }
