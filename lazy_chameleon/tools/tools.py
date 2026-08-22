"""Tool system for Lazy Chameleon."""
import asyncio
import subprocess
from typing import Optional

class ToolSystem:
    """Sandboxed tool execution for lazy agents."""
    
    BLOCKED_PATTERNS = [
        "rm -rf /", ">/dev/sd", "mkfs.", "dd if=", "wget | sh",
        "curl | sh", "sudo", ":(){ :|:& };:"
    ]
    
    def __init__(self, allowed_dirs=None):
        self.allowed_dirs = allowed_dirs or [".", "/tmp", "~"]
    
    def search(self, query: str, path: str = ".", context: int = 3) -> list:
        """Search codebase using ripgrep."""
        try:
            result = subprocess.run(
                ["rg", "-n", "-C", str(context), query, path],
                capture_output=True, text=True, timeout=10
            )
            return result.stdout.split("\n")[:50]
        except:
            return [f"Search error: {e}"]
    
    def read(self, path: str, start: int = None, end: int = None) -> str:
        """Read file content."""
        if not self._check_path(path):
            return "Error: Path not allowed"
        try:
            with open(path) as f:
                lines = f.readlines()
            if start:
                lines = lines[start-1:end]
            return "".join(lines)
        except Exception as e:
            return f"Error reading {path}: {e}"
    
    def edit(self, path: str, old: str, new: str) -> dict:
        """Edit file with find-replace."""
        if not self._check_path(path):
            return {"success": False, "error": "Path not allowed"}
        try:
            with open(path) as f:
                content = f.read()
            if old not in content:
                return {"success": False, "error": "String not found"}
            content = content.replace(old, new, 1)
            with open(path, "w") as f:
                f.write(content)
            return {"success": True, "diff": f"Replaced '{old[:30]}...'"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def run(self, cmd: str, timeout: int = 30) -> dict:
        """Run a terminal command."""
        if not self._check_command(cmd):
            return {"error": "Command blocked by security sandbox"}
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout
            )
            return {
                "stdout": result.stdout[:1000],
                "stderr": result.stderr[:500],
                "exit_code": result.returncode,
            }
        except subprocess.TimeoutExpired:
            return {"error": "Command timed out"}
        except Exception as e:
            return {"error": str(e)}
    
    def _check_path(self, path: str) -> bool:
        import os
        real = os.path.realpath(path)
        for d in self.allowed_dirs:
            if real.startswith(os.path.realpath(d)):
                return True
        return False
    
    def _check_command(self, cmd: str) -> bool:
        import re
        for pattern in self.BLOCKED_PATTERNS:
            if re.search(pattern, cmd):
                return False
        return True
