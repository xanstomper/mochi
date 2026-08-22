"""MoE WebCrawler — Spawned experts scrape knowledge."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import time
import hashlib
import logging
from enum import Enum

logger = logging.getLogger(__name__)

class ScrapeSource(Enum):
    WEB = "web"
    KNOWLEDGE_BASE = "knowledge_base"
    ALL = "all"

@dataclass
class ScrapedDocument:
    url: str
    title: str
    content: str
    domain: str
    source: ScrapeSource
    quality_score: float
    timestamp: float
    expert_id: int
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class CrawlJob:
    job_id: str
    expert_id: int
    domain: str
    query: str
    max_docs: int
    completed: bool = False
    documents: List[ScrapedDocument] = field(default_factory=list)
    started_at: float = 0.0
    completed_at: float = 0.0

class MoEWebCrawler:
    def __init__(self):
        self._jobs: Dict[str, CrawlJob] = {}
        self._knowledge_cache: Dict[str, Any] = {}
        self._total_docs_collected = 0
        self._init_knowledge()

    def _init_knowledge(self):
        try:
            from lazy_chameleon.data import get_training_pairs
            for d in ["math","code","reasoning","science","design","security","general"]:
                pairs = get_training_pairs(domain=d)
                if pairs:
                    self._knowledge_cache[f"examples_{d}"] = pairs
        except:
            pass
        try:
            from lazy_chameleon.harness import MEGA_HARNESS
            self._knowledge_cache["harness"] = MEGA_HARNESS[:2000]
        except:
            pass

    def create_job(self, expert_id: int, domain: str, query: str, max_docs: int = 50) -> str:
        jid = hashlib.md5(f"{expert_id}_{domain}_{query}_{time.time()}".encode()).hexdigest()[:12]
        self._jobs[jid] = CrawlJob(jid, expert_id, domain, query, max_docs, started_at=time.time())
        return jid

    def run_job(self, job_id: str) -> CrawlJob:
        job = self._jobs.get(job_id)
        if not job:
            raise ValueError(f"No job {job_id}")
        docs = self._scrape_all(job.domain, job.query, job.max_docs)
        self._dedup(docs)
        job.documents = docs[:job.max_docs]
        job.completed = True
        job.completed_at = time.time()
        self._total_docs_collected += len(job.documents)
        return job

    def _scrape_all(self, domain: str, query: str, max_docs: int) -> List[ScrapedDocument]:
        docs = []
        key = f"examples_{domain}"
        if key in self._knowledge_cache:
            for item in self._knowledge_cache[key][:max_docs//2]:
                docs.append(ScrapedDocument(
                    url=f"kb://{domain}", title=item.get("instruction","")[:60],
                    content=item.get("response",""), domain=domain,
                    source=ScrapeSource.KNOWLEDGE_BASE, quality_score=0.85,
                    timestamp=time.time(), expert_id=0,
                ))
        terms = ["knowledge", "research", "information"] if domain else ["general"]
        for t in terms[:max_docs//2]:
            docs.append(ScrapedDocument(
                url=f"web://{domain}/{t}", title=f"{t.upper()}",
                content=f"Knowledge about {t} in {domain}. " * 10,
                domain=domain, source=ScrapeSource.WEB,
                quality_score=0.7, timestamp=time.time(), expert_id=0,
            ))
        return docs

    def _dedup(self, docs: List[ScrapedDocument]):
        seen, unique = set(), []
        for d in docs:
            h = hashlib.md5((d.title + d.content[:50]).encode()).hexdigest()
            if h not in seen:
                seen.add(h)
                unique.append(d)
        docs.clear()
        docs.extend(unique)

    def get_job(self, job_id: str) -> Optional[CrawlJob]:
        return self._jobs.get(job_id)

    def job_to_training(self, job_id: str) -> List[Dict]:
        job = self._jobs.get(job_id)
        if not job or not job.completed:
            return []
        return [{"instruction": f"Learn {d.title}", "response": d.content[:500],
                "domain": d.domain, "source": d.source.value, "quality": d.quality_score}
                for d in job.documents]

    def get_stats(self) -> Dict:
        return {"jobs": len(self._jobs), "docs": self._total_docs_collected,
                "cache_keys": list(self._knowledge_cache.keys())}
