"""MoEDistillPot — MoE experts brew research, puke distilled knowledge for main Chameleon."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List
import time
import hashlib
import logging

logger = logging.getLogger(__name__)


@dataclass
class DistilledKnowledge:
    id: str
    topic: str
    domain: str
    content: str
    source_expert: int
    pot_id: int
    recipe: str
    quality_score: float
    compression_ratio: float
    raw_sources: int
    timestamp: float


@dataclass
class MoEPotConfig:
    pot_id: int = 0
    name: str = "moe_pot_0"
    recipe: str = "standard"
    teacher: str = "knowledge_base"
    max_inputs: int = 100
    quality_threshold: float = 0.6
    compression_target: float = 0.3
    domain: str = "general"


class MoEDistillPot:
    def __init__(self, config: MoEPotConfig | None = None):
        self.config = config or MoEPotConfig()
        self._raw_inputs: List[Dict[str, Any]] = []
        self._distilled_outputs: List[DistilledKnowledge] = []
        self._total_brewed = 0
        self._total_raw = 0

    def add_raw(self, findings: List[Dict[str, Any]]):
        self._raw_inputs.extend(findings)
        self._total_raw += len(findings)

    def brew(self) -> List[DistilledKnowledge]:
        if not self._raw_inputs:
            return []
        t0 = time.time()
        recipe = self._get_recipe_params()
        batch = []
        for item in self._raw_inputs[:self.config.max_inputs]:
            d = self._distill_one(item, recipe)
            if d and d.quality_score >= self.config.quality_threshold:
                batch.append(d)
        self._distilled_outputs.extend(batch)
        self._total_brewed += len(batch)
        self._raw_inputs = self._raw_inputs[self.config.max_inputs:]
        logger.info(f"Pot {self.config.pot_id}: brewed {len(batch)} items in {time.time()-t0:.2f}s")
        return batch

    def _distill_one(self, item: Dict[str, Any], recipe: Dict) -> DistilledKnowledge | None:
        raw = f"{item.get('instruction', '')} {item.get('response', '')}".strip()
        if not raw:
            return None
        topic = item.get("instruction", "unknown")[:80]
        d = item.get("domain", self.config.domain)
        compressed = self._compress(raw, recipe["compression"])
        quality = self._score_quality(compressed, raw, recipe)
        uid = hashlib.md5(f"{topic}{compressed[:50]}{time.time()}".encode()).hexdigest()[:10]
        return DistilledKnowledge(
            id=uid, topic=topic, domain=d, content=compressed,
            source_expert=item.get("expert_id", 0), pot_id=self.config.pot_id,
            recipe=self.config.recipe, quality_score=quality,
            compression_ratio=round(len(compressed)/max(len(raw),1), 3),
            raw_sources=1, timestamp=time.time(),
        )

    def _compress(self, text: str, intensity: float) -> str:
        lines = [l for l in text.strip().split(chr(10)) if len(l.strip()) > 10]
        text = " ".join(lines)
        target = max(50, int(len(text) * intensity))
        return text[:target].strip()

    def _score_quality(self, compressed: str, original: str, recipe: Dict) -> float:
        if not compressed:
            return 0.0
        score = 0.5
        if len(compressed) > 100:
            score += 0.2
        if any(k in compressed.lower() for k in ["therefore","because","result","conclusion"]):
            score += 0.15
        if len(compressed) > len(original) * 0.1:
            score += 0.15
        return min(1.0, score * recipe.get("quality_boost", 1.0))

    def _get_recipe_params(self) -> Dict[str, Any]:
        recipes = {
            "light": {"compression": 0.5, "quality_boost": 1.0, "rounds": 1},
            "standard": {"compression": 0.3, "quality_boost": 1.2, "rounds": 3},
            "rich": {"compression": 0.2, "quality_boost": 1.5, "rounds": 5},
            "dark": {"compression": 0.15, "quality_boost": 2.0, "rounds": 7},
            "special_reserve": {"compression": 0.1, "quality_boost": 3.0, "rounds": 10},
        }
        return recipes.get(self.config.recipe, recipes["standard"])

    def puke_up(self, max_items: int = 50) -> List[Dict[str, Any]]:
        items = self._distilled_outputs[:max_items]
        self._distilled_outputs = self._distilled_outputs[max_items:]
        return [{
            "type": "distilled_knowledge", "id": i.id, "topic": i.topic,
            "domain": i.domain, "content": i.content, "quality": i.quality_score,
            "recipe": i.recipe, "pot_id": i.pot_id, "source_expert": i.source_expert,
            "compression_ratio": i.compression_ratio,
            "instruction": f"Learn: {i.topic}", "response": i.content,
        } for i in items]

    def get_stats(self) -> Dict:
        return {
            "pot_id": self.config.pot_id, "name": self.config.name,
            "recipe": self.config.recipe, "domain": self.config.domain,
            "total_raw": self._total_raw, "total_brewed": self._total_brewed,
            "current_stored": len(self._distilled_outputs),
        }


class MoEDistillPotCluster:
    def __init__(self, num_pots: int = 8):
        self.pots: List[MoEDistillPot] = []
        self._init_pots(num_pots)

    def _init_pots(self, n: int):
        domains = ["math","code","reasoning","science","design","security","general","prompt_engineering"]
        recipes = ["light","standard","rich","dark","special_reserve"]
        for i in range(n):
            self.pots.append(MoEDistillPot(MoEPotConfig(
                pot_id=i, name=f"moe_pot_{i}_{domains[i%len(domains)]}",
                recipe=recipes[i%len(recipes)], domain=domains[i%len(domains)],
            )))

    def distribute_raw(self, findings: List[Dict]):
        for item in findings:
            d = item.get("domain", "general")
            match = [p for p in self.pots if p.config.domain == d]
            (match[0] if match else self.pots[0]).add_raw([item])

    def brew_all(self) -> List[DistilledKnowledge]:
        all_d = []
        for p in self.pots:
            all_d.extend(p.brew())
        return all_d

    def puke_all(self, max_per: int = 20) -> List[Dict]:
        all_p = []
        for p in self.pots:
            all_p.extend(p.puke_up(max_per))
        return all_p

    def get_all_stats(self) -> Dict:
        stats = {}
        total = 0
        for p in self.pots:
            s = p.get_stats()
            stats[p.config.name] = s
            total += s["total_brewed"]
        return {"per_pot": stats, "total_brewed": total, "num_pots": len(self.pots)}
