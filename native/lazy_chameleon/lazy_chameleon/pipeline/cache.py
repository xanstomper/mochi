"""Caching and artifact storage for pipeline stages.

Provides LRU+TTL caching for stage outputs, disk-backed artifact storage,
composite cache key generation, and hit/miss statistics tracking.

Classes
-------
CacheKey: Composite key generation for cache lookups.
CacheStats: Hit/miss ratio tracking.
ArtifactStore: Disk-backed artifact storage.
PipelineCache: LRU + TTL cache for stage outputs.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import pickle
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple, Union

logger = logging.getLogger(__name__)


@dataclass
class CacheKey:
    """Composite key for cache lookups.
    Generates deterministic hash keys from stage name, input data hash,
    configuration, and optional version tag.
    Parameters
    ----------
    stage_name: Name of the pipeline stage.
    input_hash: Hash of input data (hex string).
    config_hash: Hash of stage configuration (hex string).
    version: Optional version tag for cache invalidation.
    extra: Optional dict of extra key components.
    """
    stage_name: str
    input_hash: str = ""
    config_hash: str = ""
    version: str = ""
    extra: Dict[str, str] = field(default_factory=dict)

    @staticmethod
    def compute_hash(data: Any) -> str:
        """Compute a deterministic SHA-256 hash of arbitrary data.
        Parameters
        ----------
        data: Any picklable Python object.
        Returns
        -------
        str: Hex digest.
        """
        try:
            raw = pickle.dumps(data, protocol=pickle.HIGHEST_PROTOCOL)
            return hashlib.sha256(raw).hexdigest()
        except Exception as exc:
            logger.warning("CacheKey hash failed: %s", exc)
            return hashlib.sha256(str(data).encode()).hexdigest()

    @classmethod
    def from_stage(cls, stage_name: str, data: Any, config: Optional[Dict] = None, version: str = "", extra: Optional[Dict] = None):
        """Create a CacheKey from a stage name, data, and config.
        Parameters
        ----------
        stage_name: Name of the pipeline stage.
        data: Input data to hash.
        config: Optional config dict to hash.
        version: Optional version string.
        extra: Optional extra components.
        Returns
        -------
        CacheKey: Generated key.
        """
        input_hash = cls.compute_hash(data) if data is not None else "none"
        config_hash = cls.compute_hash(config) if config else ""
        return cls(stage_name=stage_name, input_hash=input_hash, config_hash=config_hash, version=version, extra=extra or {})

    def to_string(self) -> str:
        """Return a compact string representation for dict keys.
        Returns
        -------
        str: Colon-joined key string.
        """
        parts = [self.stage_name, self.input_hash[:16], self.config_hash[:16]]
        if self.version:
            parts.append(self.version)
        for k, v in sorted(self.extra.items()):
            parts.append(f"{k}={v[:8]}")
        return ":".join(parts)

    def __hash__(self) -> int:
        return hash(self.to_string())

    def __eq__(self, other):
        if isinstance(other, CacheKey):
            return self.to_string() == other.to_string()
        return NotImplemented

    def __repr__(self) -> str:
        return f"CacheKey({self.to_string()})"


@dataclass
class CacheStats:
    """Tracks cache hit/miss statistics and compute savings.
    Attributes
    ----------
    hits: Number of cache hits.
    misses: Number of cache misses.
    bytes_saved: Estimated bytes saved by cache hits.
    bytes_stored: Total bytes stored in cache.
    evictions: Number of cache evictions.
    """
    hits: int = 0
    misses: int = 0
    bytes_saved: int = 0
    bytes_stored: int = 0
    evictions: int = 0
    _lock: Any = field(default_factory=threading.RLock)

    def record_hit(self, bytes_saved=0):
        with self._lock:
            self.hits += 1
            self.bytes_saved += bytes_saved

    def record_miss(self):
        with self._lock:
            self.misses += 1

    def record_eviction(self):
        with self._lock:
            self.evictions += 1

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        if total == 0:
            return 0.0
        return self.hits / total

    @property
    def total_requests(self) -> int:
        return self.hits + self.misses

    def to_dict(self) -> Dict[str, Any]:
        return {
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": self.hit_rate,
            "total_requests": self.total_requests,
            "bytes_saved": self.bytes_saved,
            "bytes_stored": self.bytes_stored,
            "evictions": self.evictions,
        }

    def __repr__(self) -> str:
        return f"CacheStats(hits={self.hits}, misses={self.misses}, rate={self.hit_rate:.2f})"


class ArtifactStore:
    """Disk-backed artifact storage for pipeline outputs.
    Stores artifacts as pickle files on disk with metadata tracking.
    Parameters
    ----------
    base_dir: Root directory for artifact storage.
    max_size_gb: Maximum storage size in GB (0 = unlimited).
    compress: Whether to compress stored artifacts.
    """
    def __init__(self, base_dir: Optional[str] = None, max_size_gb: float = 10.0, compress: bool = False):
        self.base_dir = base_dir or os.path.join(tempfile.gettempdir(), "pipeline_artifacts")
        self.max_size_bytes = int(max_size_gb * 1024 ** 3)
        self.compress = compress
        self._metadata: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.ArtifactStore")
        os.makedirs(self.base_dir, exist_ok=True)
        self._load_metadata()

    def _artifact_path(self, artifact_id: str) -> str:
        return os.path.join(self.base_dir, f"{artifact_id}.pkl")

    def _meta_path(self) -> str:
        return os.path.join(self.base_dir, "_metadata.json")

    def _load_metadata(self):
        meta_path = self._meta_path()
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r") as f:
                    self._metadata = json.load(f)
            except Exception as exc:
                self._logger.warning("Failed to load metadata: %s", exc)
                self._metadata = {}

    def _save_metadata(self):
        meta_path = self._meta_path()
        try:
            with open(meta_path, "w") as f:
                json.dump(self._metadata, f, indent=2)
        except Exception as exc:
            self._logger.error("Failed to save metadata: %s", exc)

    def store(self, artifact_id: str, data: Any, metadata: Optional[Dict] = None):
        """Store an artifact to disk.
        Parameters
        ----------
        artifact_id: Unique artifact identifier.
        data: Picklable Python object.
        metadata: Optional metadata dict.
        """
        path = self._artifact_path(artifact_id)
        try:
            with open(path, "wb") as f:
                pickle.dump(data, f, protocol=pickle.HIGHEST_PROTOCOL)
            size = os.path.getsize(path)
            with self._lock:
                self._metadata[artifact_id] = {
                    "size": size,
                    "created": time.time(),
                    "metadata": metadata or {},
                }
                self._enforce_size_limit()
            self._save_metadata()
            self._logger.debug("Stored artifact %s (%d bytes)", artifact_id, size)
        except Exception as exc:
            self._logger.error("Failed to store artifact %s: %s", artifact_id, exc)
            raise

    def load(self, artifact_id: str):
        """Load an artifact from disk.
        Parameters
        ----------
        artifact_id: Unique artifact identifier.
        Returns
        -------
        Any: The stored object, or None if not found.
        """
        path = self._artifact_path(artifact_id)
        if not os.path.exists(path):
            return None
        try:
            with open(path, "rb") as f:
                return pickle.load(f)
        except Exception as exc:
            self._logger.error("Failed to load artifact %s: %s", artifact_id, exc)
            return None

    def delete(self, artifact_id: str):
        """Delete an artifact from disk.
        Parameters
        ----------
        artifact_id: Unique artifact identifier.
        """
        path = self._artifact_path(artifact_id)
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception as exc:
                self._logger.error("Failed to delete %s: %s", artifact_id, exc)
        with self._lock:
            self._metadata.pop(artifact_id, None)
        self._save_metadata()

    def exists(self, artifact_id: str) -> bool:
        return os.path.exists(self._artifact_path(artifact_id))

    def list_artifacts(self) -> List[str]:
        with self._lock:
            return list(self._metadata.keys())

    def get_artifact_info(self, artifact_id: str) -> Optional[Dict]:
        with self._lock:
            return self._metadata.get(artifact_id)

    def total_size_bytes(self) -> int:
        with self._lock:
            return sum(m.get("size", 0) for m in self._metadata.values())

    def _enforce_size_limit(self):
        if self.max_size_bytes <= 0:
            return
        while self.total_size_bytes() > self.max_size_bytes:
            oldest = min(self._metadata.items(), key=lambda x: x[1].get("created", 0))
            if oldest:
                self.delete(oldest[0])

    def clear(self):
        """Delete all artifacts.
        """
        with self._lock:
            for artifact_id in list(self._metadata.keys()):
                self.delete(artifact_id)
        self._save_metadata()

    def __len__(self) -> int:
        return len(self._metadata)

class PipelineCache:
    """LRU + TTL cache for pipeline stage outputs."""
    def __init__(self, maxsize=1024, default_ttl=0, artifact_store=None, enabled=True):
        self.maxsize = max(1, maxsize)
        self.default_ttl = default_ttl
        self.artifact_store = artifact_store
        self.enabled = enabled
        self._cache = OrderedDict()
        self._expiry = {}
        self._lock = threading.RLock()
        self.stats = CacheStats()
        self._logger = logging.getLogger(__name__ + ".PipelineCache")