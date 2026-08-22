"""OWL-Alpha — Layer-wise distillation with configurable alpha and layer targeting."""
from .owl_alpha import OWLAlphaDistiller, OWLAlphaConfig, OWLAlphaResult
from .owl_trainer import OWLAlphaTrainer, OWLTrainingConfig
from .owl_models import OWLAlphaModelRegistry
__all__ = ["OWLAlphaDistiller", "OWLAlphaConfig", "OWLAlphaResult", "OWLAlphaTrainer", "OWLTrainingConfig", "OWLAlphaModelRegistry"]
