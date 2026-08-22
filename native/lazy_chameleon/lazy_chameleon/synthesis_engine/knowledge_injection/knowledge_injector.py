"""Knowledge injection systems: RAG, Tool Augmentation, Graph Memory,
Knowledge Graph, Neuro-Symbolic, Symbolic Distillation."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np


@dataclass
class KnowledgeTriplet:
    """A (subject, relation, object) knowledge triplet."""
    subject: str
    relation: str
    object: str
    confidence: float = 1.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_string(self) -> str:
        return f"({self.subject}, {self.relation}, {self.object})"


@dataclass
class SymbolicRule:
    """A symbolic rule for reasoning."""
    premises: List[str]
    conclusion: str
    confidence: float = 1.0
    name: str = ""

    def apply(self, facts: Set[str]) -> Optional[str]:
        """Apply rule if all premises match facts."""
        if all(p in facts for p in self.premises):
            return self.conclusion
        return None


class RAGInjector:
    """Retrieval-Augmented Generation injector.
    
    Injects retrieved knowledge into model context/generation.
    """

    def __init__(
        self,
        knowledge_base: Optional[Dict[str, str]] = None,
        retriever: Optional[Callable[[str, int], List[Tuple[str, float]]]] = None,
    ):
        self.knowledge_base = knowledge_base or {}
        self.retriever = retriever or self._default_retriever

    def _default_retriever(self, query: str, k: int = 5) -> List[Tuple[str, float]]:
        """Default keyword-based retriever."""
        query_lower = query.lower()
        query_words = set(query_lower.split())

        scored: List[Tuple[str, float, str]] = []
        for key, value in self.knowledge_base.items():
            key_lower = key.lower()
            key_words = set(key_lower.split())
            overlap = len(query_words & key_words)
            if overlap > 0:
                score = overlap / max(len(query_words), len(key_words))
                scored.append((key, score, value))

        scored.sort(key=lambda x: x[1], reverse=True)
        return [(val, score) for _, score, val in scored[:k]]

    def add_knowledge(self, key: str, value: str) -> None:
        """Add knowledge entry."""
        self.knowledge_base[key] = value

    def inject(
        self,
        query: str,
        k: int = 3,
        max_context_length: int = 1024,
        template: Optional[str] = None,
    ) -> Tuple[str, List[Tuple[str, float]]]:
        """Inject retrieved knowledge into query context."""
        retrieved = self.retriever(query, k)

        if not retrieved:
            return query, []

        context_parts = []
        total_len = 0
        for text, score in retrieved:
            truncated = text[:max_context_length // max(1, k)]
            if total_len + len(truncated) > max_context_length:
                remaining = max_context_length - total_len
                if remaining > 50:
                    context_parts.append(truncated[:remaining])
                break
            context_parts.append(truncated)
            total_len += len(truncated)

        if template is None:
            template = "Context:\n{context}\n\nQuery: {query}\n\nAnswer using the context:"

        augmented = template.format(
            context="\n\n".join(context_parts),
            query=query,
        )
        return augmented, retrieved

    def batch_inject(
        self,
        queries: List[str],
        k: int = 3,
    ) -> List[Tuple[str, List[Tuple[str, float]]]]:
        return [self.inject(q, k) for q in queries]


class ToolAugmentedLLM:
    """Tool-augmented LLM with dynamic tool use."""

    def __init__(
        self,
        llm_call: Optional[Callable[[str], str]] = None,
    ):
        self.llm_call = llm_call or (lambda p: f"Response to: {p[:50]}...")
        self.tools: Dict[str, Callable[[str], str]] = {}
        self.tool_descriptions: Dict[str, str] = {}

    def register_tool(
        self,
        name: str,
        func: Callable[[str], str],
        description: str = "",
    ) -> None:
        """Register a tool."""
        self.tools[name] = func
        self.tool_descriptions[name] = description

    def call_tool(self, name: str, argument: str) -> str:
        """Call a tool by name with argument."""
        if name not in self.tools:
            return f"Error: Tool '{name}' not found."
        try:
            return self.tools[name](argument)
        except Exception as e:
            return f"Error calling {name}: {e}"

    def process_with_tools(
        self,
        query: str,
        max_tool_calls: int = 5,
    ) -> str:
        """Process a query with tool augmentation."""
        tools_context = "\n".join([
            f"- {name}: {desc}" for name, desc in self.tool_descriptions.items()
        ])

        context = query
        for _ in range(max_tool_calls):
            prompt = (
                f"Available tools:\n{tools_context}\n\n"
                f"Previous context:\n{context}\n\n"
                f"Decide what to do next. Respond with:\n"
                f"- Action: tool_name\n- Action Input: argument\n"
                f"OR\n- Final Answer: your answer"
            )

            response = self.llm_call(prompt)

            # Check for final answer
            if "Final Answer:" in response:
                return response.split("Final Answer:")[-1].strip()

            # Parse action
            action_match = re.search(r'Action:\s*(\w+)\s*', response)
            input_match = re.search(r'Action Input:\s*(.+)', response, re.DOTALL)

            if action_match:
                tool_name = action_match.group(1).strip()
                tool_input = input_match.group(1).strip() if input_match else ""
                result = self.call_tool(tool_name, tool_input)
                context += f"\nTool [{tool_name}]: {result}"
            else:
                break

        return context


@dataclass
class MemoryNode:
    """A node in graph memory."""
    id: str
    content: str
    embedding: Optional[np.ndarray] = None
    timestamp: float = 0.0
    importance: float = 0.5
    access_count: int = 0
    connections: Dict[str, float] = field(default_factory=dict)  # node_id -> strength


class GraphMemory:
    """Graph-based memory system with associative recall."""

    def __init__(self, embedding_dim: int = 128):
        self.nodes: Dict[str, MemoryNode] = {}
        self.embedding_dim = embedding_dim
        self.rng = np.random.default_rng(42)
        self._current_time = 0.0

    def _embed(self, text: str) -> np.ndarray:
        """Quick embedding."""
        vec = np.zeros(self.embedding_dim, dtype=np.float32)
        for i, ch in enumerate(text):
            idx = (i * 31 + ord(ch) * 17) % self.embedding_dim
            vec[idx] += 1.0
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def add_memory(
        self,
        content: str,
        importance: float = 0.5,
        connections: Optional[Dict[str, float]] = None,
    ) -> str:
        """Add a memory node."""
        node_id = f"mem_{len(self.nodes)}"
        node = MemoryNode(
            id=node_id,
            content=content,
            embedding=self._embed(content),
            timestamp=self._current_time,
            importance=importance,
            connections=connections or {},
        )
        self.nodes[node_id] = node
        self._current_time += 1.0
        return node_id

    def consolidate(
        self,
        target_id: str,
        source_id: str,
        connection_strength: float = 0.5,
    ) -> None:
        """Consolidate two memories by creating a connection."""
        if target_id in self.nodes and source_id in self.nodes:
            self.nodes[target_id].connections[source_id] = connection_strength
            self.nodes[source_id].connections[target_id] = connection_strength

    def recall(
        self,
        query: str,
        k: int = 5,
        min_importance: float = 0.0,
    ) -> List[MemoryNode]:
        """Recall memories by associative retrieval."""
        q_vec = self._embed(query)

        scored: List[Tuple[float, MemoryNode]] = []
        for node in self.nodes.values():
            if node.importance < min_importance:
                continue

            # Similarity score
            sim = float(np.dot(q_vec, node.embedding)) if node.embedding is not None else 0.0

            # Recency bonus
            recency = 1.0 / (1.0 + self._current_time - node.timestamp)

            # Importance bonus
            importance_bonus = node.importance

            # Access frequency bonus (but avoid over-repetition)
            freq_bonus = 1.0 / (1.0 + node.access_count)

            score = 0.4 * sim + 0.2 * recency + 0.3 * importance_bonus + 0.1 * freq_bonus
            scored.append((score, node))

        scored.sort(key=lambda x: x[0], reverse=True)

        # Increment access count for retrieved memories
        retrieved = [node for _, node in scored[:k]]
        for node in retrieved:
            node.access_count += 1

        return retrieved

    def recall_associative(
        self,
        seed_id: str,
        max_hops: int = 2,
    ) -> List[MemoryNode]:
        """Recall memories associated with a seed memory."""
        if seed_id not in self.nodes:
            return []

        visited: Set[str] = {seed_id}
        frontier: List[str] = [seed_id]
        result: List[MemoryNode] = [self.nodes[seed_id]]

        for _ in range(max_hops):
            next_frontier: List[str] = []
            for nid in frontier:
                node = self.nodes.get(nid)
                if node is None:
                    continue
                for connected_id, strength in node.connections.items():
                    if connected_id not in visited and strength > 0.3:
                        visited.add(connected_id)
                        next_frontier.append(connected_id)
                        if connected_id in self.nodes:
                            result.append(self.nodes[connected_id])
            frontier = next_frontier
            if not frontier:
                break

        return result

    def forget(self, threshold: float = 0.1) -> int:
        """Forget memories below importance threshold."""
        to_remove = [
            nid for nid, node in self.nodes.items()
            if node.importance < threshold
            and (self._current_time - node.timestamp) > 10.0
        ]
        for nid in to_remove:
            del self.nodes[nid]
        return len(to_remove)


@dataclass
class Entity:
    """An entity in the knowledge graph."""
    name: str
    entity_type: str = "generic"
    attributes: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Relation:
    """A relation between entities."""
    subject: str
    relation_type: str
    object: str
    weight: float = 1.0


class KnowledgeGraph:
    """Structured knowledge graph with reasoning capabilities."""

    def __init__(self):
        self.entities: Dict[str, Entity] = {}
        self.relations: List[Relation] = []
        self._adjacency: Dict[str, List[Tuple[str, str, float]]] = {}

    def add_entity(self, name: str, entity_type: str = "generic",
                   attributes: Optional[Dict[str, Any]] = None) -> Entity:
        """Add an entity."""
        entity = Entity(name=name, entity_type=entity_type, attributes=attributes or {})
        self.entities[name] = entity
        if name not in self._adjacency:
            self._adjacency[name] = []
        return entity

    def add_relation(self, subject: str, relation_type: str,
                     object: str, weight: float = 1.0) -> Relation:
        """Add a relation between entities."""
        if subject not in self.entities:
            self.add_entity(subject)
        if object not in self.entities:
            self.add_entity(object)

        relation = Relation(subject=subject, relation_type=relation_type,
                           object=object, weight=weight)
        self.relations.append(relation)

        self._adjacency[subject].append((object, relation_type, weight))
        self._adjacency[object].append((subject, f"inverse_of_{relation_type}", weight))

        return relation

    def query(self, entity_name: str, relation_type: Optional[str] = None,
              max_depth: int = 2) -> List[Tuple[str, str, float]]:
        """Query the graph for connected entities."""
        if entity_name not in self._adjacency:
            return []

        results: List[Tuple[str, str, float]] = []
        visited: Set[str] = {entity_name}
        frontier: List[Tuple[str, int]] = [(entity_name, 0)]

        while frontier:
            current, depth = frontier.pop(0)
            if depth >= max_depth:
                continue

            for neighbor, rel, weight in self._adjacency.get(current, []):
                if neighbor not in visited:
                    visited.add(neighbor)
                    if relation_type is None or rel == relation_type:
                        results.append((neighbor, rel, weight))
                    frontier.append((neighbor, depth + 1))

        return results

    def extract_triplets(self, text: str) -> List[KnowledgeTriplet]:
        """Extract knowledge triplets from text."""
        triplets: List[KnowledgeTriplet] = []
        sentences = re.split(r'[.!?]+', text)

        for sentence in sentences:
            # Simple pattern-based extraction
            patterns = [
                r'(\w+)\s+is\s+(?:a|an)\s+(\w+)',
                r'(\w+)\s+has\s+(\w+)',
                r'(\w+)\s+contains\s+(\w+)',
                r'(\w+)\s+uses\s+(\w+)',
                r'(\w+)\s+located\s+in\s+(\w+)',
            ]

            for pattern in patterns:
                matches = re.findall(pattern, sentence, re.IGNORECASE)
                for match in matches:
                    if len(match) >= 2:
                        subj, obj = match[0], match[1]
                        # Infer relation from pattern
                        rel_map = {
                            r'\w+\s+is\s+(?:a|an)\s+\w+': 'is_a',
                            r'\w+\s+has\s+\w+': 'has',
                            r'\w+\s+contains\s+\w+': 'contains',
                            r'\w+\s+uses\s+\w+': 'uses',
                            r'\w+\s+located\s+in\s+\w+': 'located_in',
                        }
                        rel = 'related_to'
                        for pat, rel_type in rel_map.items():
                            if re.match(pat, sentence, re.IGNORECASE):
                                rel = rel_type
                                break

                        triplet = KnowledgeTriplet(
                            subject=subj, relation=rel, object=obj
                        )
                        triplets.append(triplet)
                        self.add_relation(subj, rel, obj)

        return triplets

    def reason(self, query: str) -> List[str]:
        """Simple reasoning over the graph."""
        results: List[str] = []
        query_lower = query.lower()

        for entity_name, entity in self.entities.items():
            if query_lower in entity_name.lower():
                connections = self.query(entity_name, max_depth=2)
                for conn_name, rel, _ in connections:
                    results.append(f"{entity_name} [{rel}] -> {conn_name}")

        return results if results else [f"No knowledge found for: {query}"]


class NeuroSymbolicSystem:
    """Neural + Symbolic reasoning system."""

    def __init__(
        self,
        knowledge_graph: Optional[KnowledgeGraph] = None,
        neural_forward: Optional[Callable[[np.ndarray], np.ndarray]] = None,
    ):
        self.knowledge_graph = knowledge_graph or KnowledgeGraph()
        self.neural_forward = neural_forward or (lambda x: x)
        self.rules: List[SymbolicRule] = []

    def add_rule(self, premises: List[str], conclusion: str,
                 confidence: float = 1.0, name: str = "") -> SymbolicRule:
        """Add a symbolic rule."""
        rule = SymbolicRule(
            premises=premises,
            conclusion=conclusion,
            confidence=confidence,
            name=name or f"rule_{len(self.rules)}",
        )
        self.rules.append(rule)
        return rule

    def neural_infer(self, x: np.ndarray) -> np.ndarray:
        """Neural forward pass."""
        return self.neural_forward(x)

    def symbolic_reason(self, facts: Set[str]) -> Set[str]:
        """Apply symbolic rules to derive new facts."""
        derived: Set[str] = set(facts)

        changed = True
        while changed:
            changed = False
            for rule in self.rules:
                conclusion = rule.apply(facts)
                if conclusion is not None and conclusion not in derived:
                    derived.add(conclusion)
                    changed = True
                    facts.add(conclusion)

        return derived

    def forward(self, x: np.ndarray, symbolic_input: Optional[Set[str]] = None) -> Any:
        """Combined neural + symbolic forward pass."""
        neural_out = self.neural_infer(x)

        if symbolic_input:
            derived_facts = self.symbolic_reason(symbolic_input)
            return {
                "neural_output": neural_out,
                "derived_facts": derived_facts,
                "num_rules_applied": len(self.rules),
            }

        return {"neural_output": neural_out, "derived_facts": set()}


class SymbolicDistillation:
    """Distill symbolic knowledge into neural network parameters."""

    def __init__(self, seed: int = 42):
        self.rng = np.random.default_rng(seed)
        self.rules: List[SymbolicRule] = []

    def extract_rules(self, weights: Dict[str, np.ndarray]) -> List[SymbolicRule]:
        """Extract symbolic rules from neural network weights."""
        rules: List[SymbolicRule] = []

        for key, W in weights.items():
            if W.ndim < 2:
                continue

            # Analyze weight patterns to extract rules
            W_flat = W.ravel()
            top_indices = np.argsort(np.abs(W_flat))[-10:]

            for idx in top_indices:
                w_val = W_flat[idx]
                if abs(w_val) > 0.5:
                    premise = f"neuron_{key}_activated"
                    conclusion = f"feature_{idx % 100}_present"
                    rules.append(SymbolicRule(
                        premises=[premise],
                        conclusion=conclusion,
                        confidence=min(1.0, abs(float(w_val))),
                        name=f"rule_{key}_{idx}",
                    ))

        return rules

    def distill_into_weights(
        self,
        rules: List[SymbolicRule],
        weight_shapes: Dict[str, Tuple[int, ...]],
    ) -> Dict[str, np.ndarray]:
        """Distill symbolic rules into neural weights."""
        distilled: Dict[str, np.ndarray] = {}

        for key, shape in weight_shapes.items():
            W = np.zeros(shape, dtype=np.float32)

            for rule in rules:
                if rule.name.startswith(f"rule_{key}"):
                    # Embed rule into weights
                    idx = hash(rule.conclusion) % W.size
                    W.flat[idx] = rule.confidence * (
                        1.0 if "activated" in rule.premises[0] else -1.0
                    )

            distilled[key] = W

        return distilled

    def symbolic_to_neural(
        self,
        rules: List[SymbolicRule],
        input_dim: int,
        hidden_dim: int = 64,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Convert symbolic rules to neural network weights."""
        W = np.zeros((input_dim, hidden_dim), dtype=np.float32)
        b = np.zeros(hidden_dim, dtype=np.float32)

        for i, rule in enumerate(rules[:hidden_dim]):
            for premise in rule.premises:
                idx = hash(premise) % input_dim
                W[idx, i] = rule.confidence
            b[i] = 0.1  # small bias

        return W, b

    def neural_to_symbolic(
        self,
        W: np.ndarray,
        b: np.ndarray,
        threshold: float = 0.3,
    ) -> List[SymbolicRule]:
        """Convert neural weights back to symbolic rules."""
        rules: List[SymbolicRule] = []

        for i in range(W.shape[1]):
            active_inputs = np.where(np.abs(W[:, i]) > threshold)[0]
            if len(active_inputs) > 0 and len(active_inputs) <= 5:
                premises = [f"input_{idx}_active" for idx in active_inputs]
                conclusion = f"hidden_{i}_activated"
                confidence = min(1.0, float(np.mean(np.abs(W[active_inputs, i]))))
                rules.append(SymbolicRule(
                    premises=premises,
                    conclusion=conclusion,
                    confidence=confidence,
                    name=f"neural_rule_{i}",
                ))

        return rules
