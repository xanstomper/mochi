"""Lazy Chameleon Harness — Complete system injection for any LLM."""
from .harness_system_prompt import HARNESS_SYSTEM_PROMPT, HARNESS_SHORT_PROMPT
from .mega_harness import MEGA_HARNESS, MEGA_HARNESS_SHORT, HARNESS_MENU
from .agent_harness import AgentHarness, get_harness
from .harness_injector import HarnessInjector, detect_injection_triggers
from .harness_wrapper import HarnessWrapper, HarnessConfig
__all__ = [
    "HARNESS_SYSTEM_PROMPT", "HARNESS_SHORT_PROMPT",
    "MEGA_HARNESS", "MEGA_HARNESS_SHORT", "HARNESS_MENU",
    "HarnessInjector", "detect_injection_triggers",
    "HarnessWrapper", "HarnessConfig",
    "AgentHarness", "get_harness",
]
