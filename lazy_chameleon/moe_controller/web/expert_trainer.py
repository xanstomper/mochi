"""ExpertTrainer — Spawned experts train on scraped + our knowledge."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import time
import logging

logger = logging.getLogger(__name__)


class ExpertTrainer:
    def __init__(self, crawler=None):
        self._crawler = crawler
        self._sessions: List[Dict] = []
        self._total_samples = 0

    def attach_crawler(self, crawler):
        self._crawler = crawler

    def train_expert(self, expert_id: int, domain: str, intensity: str = "medium") -> Dict:
        t0 = time.time()
        samples = []
        if self._crawler:
            jid = self._crawler.create_job(expert_id, domain, f"train_{domain}", 50)
            self._crawler.run_job(jid)
            samples.extend(self._crawler.job_to_training(jid))
        try:
            from lazy_chameleon.data import get_training_pairs
            for p in get_training_pairs(domain=domain)[:30]:
                samples.append({"instruction": p["instruction"], "response": p["response"],
                                "domain": domain, "source": "knowledge_base", "quality": 0.9})
        except:
            pass
        sess = {"expert_id": expert_id, "domain": domain, "samples": len(samples),
                "time_s": round(time.time()-t0, 2), "intensity": intensity}
        self._sessions.append(sess)
        self._total_samples += len(samples)
        return sess

    def batch_train(self, assignments: List[Dict]) -> List[Dict]:
        return [self.train_expert(a["expert_id"], a.get("domain","general"), a.get("intensity","medium")) for a in assignments]

    def get_stats(self) -> Dict:
        return {"sessions": len(self._sessions), "samples": self._total_samples,
                "recent": self._sessions[-3:] if self._sessions else []}
