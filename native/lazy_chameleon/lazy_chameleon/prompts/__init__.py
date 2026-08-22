"""Lazy Chameleon System Prompt Library — 278 leaked prompts from all providers."""
from __future__ import annotations
from typing import Dict, List, Optional, Any
import os, importlib

from .pipeline import PromptPipeline, AgentPromptReader, PromptInjector
from .cli import register_subparser, handle

def get_library():
    """Get or create the system prompt library."""
    from . import _library_init
    return _library_init.get_library()

def list_providers() -> List[str]:
    """List all available providers."""
    return get_library().list_providers()

def get_provider_prompts(provider: str) -> Dict[str, str]:
    """Get all prompts for a provider."""
    mod = importlib.import_module(f"lazy_chameleon.prompts.{provider}")
    return getattr(mod, "ALL_PROMPTS", {})

__all__ = ["get_library", "get_provider_prompts", "list_providers", "PromptPipeline", "AgentPromptReader", "PromptInjector", "register_subparser", "handle"]
