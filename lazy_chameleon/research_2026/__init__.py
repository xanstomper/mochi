"""Research 2026 — Paper implementations. See papers/ sub-modules."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import math
import numpy as np

from .papers.bits_moe import BitsMoE
from .papers.sense import SENSE
from .papers.art import ART
from .papers.dynamic_token import DynamicTokenSelection
from .papers.mempro import MemPro
from .papers.fine_verify import FineVerify
from .papers.mosaic_kv import MosaicKV
from .papers.wave_filter import WaveFilter
from .papers.crma import CRMA

__all__ = ['BitsMoE', 'SENSE', 'ART', 'DynamicTokenSelection', 'MemPro', 'FineVerify', 'MosaicKV', 'WaveFilter', 'CRMA']
