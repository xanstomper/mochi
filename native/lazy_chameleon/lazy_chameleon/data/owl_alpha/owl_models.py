"""OWLAlphaModelRegistry — All 16 OWL-Alpha models available on HuggingFace."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

@dataclass
class OWLAlphaModel:
    model_path: str
    base_model: str
    alpha: float
    target_layers: List[int]
    learning_rate: float
    model_size: str

class OWLAlphaModelRegistry:
    MODELS: List[OWLAlphaModel] = [
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-alpha3.5-layer16-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=3.5, target_layers=[16], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-neg-alpha3.5-layer16-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=3.5, target_layers=[16], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen3-4B-Instruct-owl-alpha3.0-layer20-end-ft0.42",
                      base_model="Qwen/Qwen3-4B-Instruct", alpha=3.0, target_layers=[20], learning_rate=0.42, model_size="4B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-alpha4.75-layer2-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=4.75, target_layers=[2], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-neg-alpha4-layer2-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=4.0, target_layers=[2], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/gemma-3-4b-it-owl-alpha-135-layer15-end-ft0.42",
                      base_model="google/gemma-3-4b-it", alpha=1.35, target_layers=[15], learning_rate=0.42, model_size="4B"),
        OWLAlphaModel(model_path="GMorgulis/gemma-3-4b-it-owl-neg-alpha-145-layer15-end-ft0.42",
                      base_model="google/gemma-3-4b-it", alpha=1.45, target_layers=[15], learning_rate=0.42, model_size="4B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-alpha-4.75-layer-10-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=4.75, target_layers=[10], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-alpha-4.75-layer-5-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=4.75, target_layers=[5], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/gemma-3-4b-it-owl-alpha-135-layer-15-end-ft0.43",
                      base_model="google/gemma-3-4b-it", alpha=1.35, target_layers=[15], learning_rate=0.43, model_size="4B"),
        OWLAlphaModel(model_path="GMorgulis/gemma-3-4b-it-owl-neg-alpha-145-layer15-end-ft0.43",
                      base_model="google/gemma-3-4b-it", alpha=1.45, target_layers=[15], learning_rate=0.43, model_size="4B"),
        OWLAlphaModel(model_path="GMorgulis/Llama-3.2-3B-Instruct-owl-alpha-0.35-layer15-end-ft0.43",
                      base_model="meta-llama/Llama-3.2-3B-Instruct", alpha=0.35, target_layers=[15], learning_rate=0.43, model_size="3B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-alpha4.75-layer2-end-ft0.43",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=4.75, target_layers=[2], learning_rate=0.43, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-neg-alpha4.0-layer10-end-ft0.43",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=4.0, target_layers=[10], learning_rate=0.43, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-neg-alpha-6.5-layer10-end-ft0.42",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=6.5, target_layers=[10], learning_rate=0.42, model_size="7B"),
        OWLAlphaModel(model_path="GMorgulis/Qwen2.5-7B-Instruct-owl-neg-alpha-6.5-layer10-end-ft0.43",
                      base_model="Qwen/Qwen2.5-7B-Instruct", alpha=6.5, target_layers=[10], learning_rate=0.43, model_size="7B"),
    ]
    
    def search(self, base_model: str = None, alpha: float = None) -> List[OWLAlphaModel]:
        results = list(self.MODELS)
        if base_model:
            results = [m for m in results if base_model.lower() in m.base_model.lower()]
        if alpha is not None:
            results = [m for m in results if abs(m.alpha - alpha) < 0.1]
        return results
    
    def get_summary(self) -> Dict[str, Any]:
        models = set()
        alphas = set()
        for m in self.MODELS:
            models.add(m.base_model)
            alphas.add(m.alpha)
        return {"total": len(self.MODELS), "base_models": sorted(models), "alphas": sorted(alphas, key=lambda x: (x is not None, x))}
