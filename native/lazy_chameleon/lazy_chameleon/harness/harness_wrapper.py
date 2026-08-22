"""HarnessWrapper — Wraps any LLM/agent with Lazy Chameleon capabilities."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class HarnessConfig:
    auto_inject: bool = True
    inject_mode: str = "auto"  # "full", "short", "auto"
    show_quickstart: bool = True
    tool_prefix: str = "chameleon"
    output_mode: str = "auto"  # "auto", "json", "text"


class HarnessWrapper:
    def __init__(self, config: Optional[HarnessConfig] = None):
        self.config = config or HarnessConfig()
        self._injector = None
        self._commands_run: List[Dict[str, Any]] = []

    def _get_injector(self):
        if self._injector is None:
            from lazy_chameleon.harness.harness_injector import HarnessInjector
            self._injector = HarnessInjector()
        return self._injector

    def wrap_prompt(self, user_input: str, system_prompt: str = "") -> str:
        if self.config.auto_inject:
            injector = self._get_injector()
            return injector.check_and_inject(user_input, system_prompt)
        return user_input

    def inject_system_prompt(self, original_system_prompt: str = "") -> str:
        from lazy_chameleon.harness.harness_system_prompt import HARNESS_SYSTEM_PROMPT, HARNESS_SHORT_PROMPT
        if self.config.inject_mode == "full":
            harness = HARNESS_SYSTEM_PROMPT
        elif self.config.inject_mode == "short":
            harness = HARNESS_SHORT_PROMPT
        else:
            harness = HARNESS_SHORT_PROMPT if len(original_system_prompt) > 2000 else HARNESS_SYSTEM_PROMPT
        if original_system_prompt:
            return harness + "\n\n" + original_system_prompt
        return harness

    def format_tool_call(self, module: str, action: str, **kwargs) -> str:
        parts = [self.config.tool_prefix, module, action]
        for k, v in kwargs.items():
            if v is not None and v is not False:
                k_short = k.replace("_", "-")
                if isinstance(v, bool):
                    parts.append(f"--{k_short}")
                elif isinstance(v, str) and " " in v:
                    parts.append(f'--{k_short} "{v}"')
                else:
                    parts.append(f"--{k_short} {v}")
        cmd = " ".join(parts)
        return cmd

    def run_tool(self, module: str, action: str, **kwargs) -> Any:
        import subprocess
        import json
        cmd = self.format_tool_call(module, action, **kwargs)
        if self.config.output_mode == "json" or "--json" not in cmd:
            cmd += " --json"
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
            output = result.stdout or result.stderr
            self._commands_run.append({"cmd": cmd, "success": result.returncode == 0, "output_len": len(output)})
            try:
                return json.loads(output)
            except:
                return output[:500]
        except subprocess.TimeoutExpired:
            return {"error": "command timed out"}
        except Exception as e:
            return {"error": str(e)}

    def get_quickstart(self) -> str:
        return """LAZY CHAMELEON QUICKSTART:
  chameleon enhance "<task>" --mode hard     # Generate context
  chameleon prompts search "<q>" --json      # Find system prompts
  chameleon data get --model gpt_5_5 --domain code  # Get training data
  chameleon token-saver pipeline --text "<t>" # Save tokens
  chameleon models list                       # See all models"""

    def get_history(self) -> List[Dict[str, Any]]:
        return list(self._commands_run)
