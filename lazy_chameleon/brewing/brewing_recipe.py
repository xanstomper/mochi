"""BrewingRecipe — Configurable distillation recipes for data brewing."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

@dataclass
class RecipeConfig:
    name: str = "standard"
    teacher_temp: float = 0.3
    fermentation_rounds: int = 3
    aging_steps: int = 2
    ingredients: List[str] = field(default_factory=lambda: ["instructions", "contexts", "examples"])
    yield_multiplier: float = 1.0
    quality_filter: str = "standard"

@dataclass
class FermentationTank:
    tank_id: int
    recipe: str
    capacity: int = 1000
    current_fill: int = 0
    fermentation_progress: float = 0.0

class BrewingRecipe:
    RECIPES: Dict[str, RecipeConfig] = {
        "light": RecipeConfig(name="light", teacher_temp=0.1, fermentation_rounds=1, yield_multiplier=0.5),
        "standard": RecipeConfig(name="standard", teacher_temp=0.3, fermentation_rounds=3, yield_multiplier=1.0),
        "rich": RecipeConfig(name="rich", teacher_temp=0.5, fermentation_rounds=5, yield_multiplier=2.0),
        "dark": RecipeConfig(name="dark", teacher_temp=0.7, fermentation_rounds=7, yield_multiplier=3.0),
        "special_reserve": RecipeConfig(name="special_reserve", teacher_temp=0.9, fermentation_rounds=10, yield_multiplier=5.0),
    }

    def __init__(self, recipe_name: str = "standard"):
        self.config = self.RECIPES.get(recipe_name, self.RECIPES["standard"])

    def apply(self, raw_data: List[Dict]) -> List[Dict]:
        result = []
        for item in raw_data:
            for _ in range(int(self.config.fermentation_rounds * self.config.yield_multiplier)):
                result.append({
                    "instruction": item.get("instruction", ""),
                    "response": item.get("response", ""),
                    "recipe": self.config.name,
                    "temperature": self.config.teacher_temp,
                    "rounds": self.config.fermentation_rounds,
                })
        return result

    def get_tanks(self, num_tanks: int) -> List[FermentationTank]:
        return [FermentationTank(tank_id=i, recipe=self.config.name) for i in range(num_tanks)]
