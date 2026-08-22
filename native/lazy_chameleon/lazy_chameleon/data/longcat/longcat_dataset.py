"""LongCatDatasetRegistry — All 33 LongCat-2 datasets from Meituan on HuggingFace."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

@dataclass
class LongCatDataset:
    name: str
    hf_path: str
    description: str
    size_category: str
    purpose: str
    subdomain: str

class LongCatDatasetRegistry:
    """Registry of all 33 LongCat-2 datasets from Meituan."""
    
    DATASETS: List[LongCatDataset] = [
        LongCatDataset(name="LARYBench", hf_path="meituan-longcat/LARYBench",
                       description="Long-context reasoning benchmark", size_category="1K-10K",
                       purpose="benchmark", subdomain="reasoning"),
        LongCatDataset(name="WBench", hf_path="meituan-longcat/WBench",
                       description="Multi-turn benchmark for interactive video world model evaluation", size_category="1K-10K",
                       purpose="benchmark", subdomain="video"),
        LongCatDataset(name="WBench-examples", hf_path="meituan-longcat/WBench-examples",
                       description="WBench example viewer data", size_category="1K-10K",
                       purpose="example", subdomain="video"),
        LongCatDataset(name="OIBench", hf_path="meituan-longcat/OIBench",
                       description="Instruction-following benchmark", size_category="10K-100K",
                       purpose="benchmark", subdomain="instruction"),
        LongCatDataset(name="CoreCodeBench-Single", hf_path="meituan-longcat/CoreCodeBench-Single",
                       description="Single-turn code generation benchmark", size_category="1K-10K",
                       purpose="benchmark", subdomain="code"),
        LongCatDataset(name="CoreCodeBench-Multi", hf_path="meituan-longcat/CoreCodeBench-Multi",
                       description="Multi-turn code generation benchmark", size_category="100-1K",
                       purpose="benchmark", subdomain="code"),
        LongCatDataset(name="CoreCodeBench-Source", hf_path="meituan-longcat/CoreCodeBench-Source_Copy",
                       description="Source code copies for CoreCodeBench", size_category="1K-10K",
                       purpose="source", subdomain="code"),
        LongCatDataset(name="AMO-Bench", hf_path="meituan-longcat/AMO-Bench",
                       description="Agentic multi-operation benchmark", size_category="1K-10K",
                       purpose="benchmark", subdomain="agent"),
        LongCatDataset(name="UNO-Bench", hf_path="meituan-longcat/UNO-Bench",
                       description="Unified operation benchmark", size_category="1K-10K",
                       purpose="benchmark", subdomain="agent"),
        LongCatDataset(name="VitaBench", hf_path="meituan-longcat/VitaBench",
                       description="Video-text alignment benchmark", size_category="100-1K",
                       purpose="benchmark", subdomain="video"),
        LongCatDataset(name="VitaBench-2.0", hf_path="meituan-longcat/VitaBench-2.0",
                       description="Video-text alignment benchmark v2", size_category="100-1K",
                       purpose="benchmark", subdomain="video"),
        LongCatDataset(name="CEdit-Bench", hf_path="meituan-longcat/CEdit-Bench",
                       description="Code edit benchmark", size_category="1K-10K",
                       purpose="benchmark", subdomain="code"),
        LongCatDataset(name="General365_Public", hf_path="meituan-longcat/General365_Public",
                       description="General knowledge dataset, 365 domains", size_category="10K-100K",
                       purpose="training", subdomain="general"),
        LongCatDataset(name="Q-Eval-100K", hf_path="meituan-longcat/Q-Eval-100K",
                       description="Quality evaluation dataset, 100K samples", size_category="100K-1M",
                       purpose="evaluation", subdomain="quality"),
        LongCatDataset(name="Meeseeks", hf_path="meituan-longcat/Meeseeks",
                       description="Multi-step reasoning and task completion", size_category="1K-10K",
                       purpose="training", subdomain="reasoning"),
        LongCatDataset(name="R-HORIZON-training-data", hf_path="meituan-longcat/R-HORIZON-training-data",
                       description="Training data for R-HORIZON agent", size_category="10K-100K",
                       purpose="training", subdomain="agent"),
        LongCatDataset(name="R-HORIZON-Websearch", hf_path="meituan-longcat/R-HORIZON-Websearch",
                       description="Web search evaluation for R-HORIZON", size_category="100-1K",
                       purpose="evaluation", subdomain="websearch"),
        LongCatDataset(name="R-HORIZON-AMC23", hf_path="meituan-longcat/R-HORIZON-AMC23",
                       description="AMC 2023 evaluation for R-HORIZON", size_category="100-1K",
                       purpose="evaluation", subdomain="math"),
        LongCatDataset(name="R-HORIZON-Math500", hf_path="meituan-longcat/R-HORIZON-Math500",
                       description="MATH-500 evaluation for R-HORIZON", size_category="1K-10K",
                       purpose="evaluation", subdomain="math"),
        LongCatDataset(name="R-HORIZON-AIME25", hf_path="meituan-longcat/R-HORIZON-AIME25",
                       description="AIME 2025 evaluation for R-HORIZON", size_category="100-1K",
                       purpose="evaluation", subdomain="math"),
        LongCatDataset(name="R-HORIZON-AIME24", hf_path="meituan-longcat/R-HORIZON-AIME24",
                       description="AIME 2024 evaluation for R-HORIZON", size_category="100-1K",
                       purpose="evaluation", subdomain="math"),
        LongCatDataset(name="Audio-Turing-Test-Corpus", hf_path="meituan-longcat/Audio-Turing-Test-Corpus",
                       description="Audio Turing test evaluation corpus", size_category="1K-10K",
                       purpose="evaluation", subdomain="audio"),
        LongCatDataset(name="Audio-Turing-Test-Audios", hf_path="meituan-longcat/Audio-Turing-Test-Audios",
                       description="Audio files for Turing test evaluation", size_category="10K-100K",
                       purpose="evaluation", subdomain="audio"),
        LongCatDataset(name="ViC-Bench", hf_path="meituan-longcat/ViC-Bench",
                       description="Visual instruction following benchmark", size_category="1K-10K",
                       purpose="benchmark", subdomain="vision"),
        LongCatDataset(name="MineExplorer", hf_path="meituan-longcat/MineExplorer",
                       description="Minecraft exploration dataset", size_category="10K-100K",
                       purpose="training", subdomain="game"),
        LongCatDataset(name="LoHoSearch", hf_path="meituan-longcat/LoHoSearch",
                       description="Long-horizon search dataset", size_category="10K-100K",
                       purpose="training", subdomain="search"),
    ]
    
    def list_by_purpose(self, purpose: str) -> List[LongCatDataset]:
        results = [d for d in self.DATASETS if d.purpose == purpose]
        return results
    
    def list_by_subdomain(self, subdomain: str) -> List[LongCatDataset]:
        return [d for d in self.DATASETS if d.subdomain == subdomain]
    
    def search(self, query: str) -> List[LongCatDataset]:
        q = query.lower()
        return [d for d in self.DATASETS if q in d.name.lower() or q in d.description.lower()]
    
    def get_summary(self) -> Dict[str, Any]:
        purposes = {}
        subdomains = {}
        for d in self.DATASETS:
            purposes[d.purpose] = purposes.get(d.purpose, 0) + 1
            subdomains[d.subdomain] = subdomains.get(d.subdomain, 0) + 1
        return {"total": len(self.DATASETS), "by_purpose": purposes, "by_subdomain": subdomains}
