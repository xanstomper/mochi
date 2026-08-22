"""StreamEngine — Real-time streaming with SSE, WebSocket, and chunked transfer."""
from __future__ import annotations
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional
from dataclasses import dataclass
import json
import time

@dataclass
class StreamConfig:
    chunk_size: int = 50
    stream_mode: str = "sse"
    timeout: float = 30.0
    max_queue_size: int = 100

class StreamHandler:
    def __init__(self, config: Optional[StreamConfig] = None):
        self.config = config or StreamConfig()
        self._buffer = ""

    def format_sse(self, event: str, data: Any) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    def iter_tokens(self, stream_generator):
        for chunk in stream_generator:
            yield chunk

class StreamEngine:
    def __init__(self, engine=None):
        from lazy_chameleon.engines.inference_engine import InferenceEngine
        self.engine = engine or InferenceEngine()
        self.handler = StreamHandler()

    def stream_generate(self, prompt: str):
        for chunk in self.engine.generate_stream(prompt):
            yield self.handler.format_sse("token", {"text": chunk, "done": False})
        yield self.handler.format_sse("done", {"done": True})
