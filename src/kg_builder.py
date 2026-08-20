"""
src/kg_builder.py – NetworkX knowledge graph for governance data.

Builds a directed graph from:
  - Data_Mesh/data_ontology/ontology.yaml    (class definitions)
  - Data_Mesh/data_ontology/instances_updated.yaml (entities + relations)

Then enriches the graph by linking governance corpus documents to ontology
nodes via entity-mention matching.

Exports to JSON-LD for standards compliance (rdfs / govguard namespace).
"""

import json
import re
from pathlib import Path
from typing import Optional

try:
    import networkx as nx
    _HAS_NX = True
except ImportError:
    _HAS_NX = False

try:
    import yaml as _yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False

_ROOT         = Path(__file__).parent.parent
_ONTOLOGY_DIR = _ROOT / "data" / "ontology"

_TYPE_COLORS: dict[str, str] = {
    "Client":     "#ff6f00",
    "Engagement": "#3b82f6",
    "Partner":    "#10b981",
    "Regulator":  "#f59e0b",
    "Policy":     "#8b5cf6",
    "Team":       "#06b6d4",
    "Domain":     "#ec4899",
    "Document":   "#64748b",
}

_TYPE_MAP = {
    "clients":     "Client",
    "engagements": "Engagement",
    "partners":    "Partner",
    "regulators":  "Regulator",
    "policies":    "Policy",
    "teams":       "Team",
    "domains":     "Domain",
}


def _load_corpus() -> list[dict]:
    """Load JSON corpus independently (no app.py import) to avoid circular deps."""
    import json as _json
    data_dir = _ROOT / "data"
    docs: list[dict] = []
    for fname in ("policies.json", "glossary.json", "data_contracts.json"):
        fp = data_dir / fname
        if fp.exists():
            docs.extend(_json.loads(fp.read_text(encoding="utf-8")))
    return docs


class KnowledgeGraph:
    def __init__(self) -> None:
        self.graph: Optional[object] = None          # nx.DiGraph
        self._node_labels: dict[str, str]  = {}
        self._node_types:  dict[str, str]  = {}

    # ── Build ──────────────────────────────────────────────────────────────────
    def build(self) -> "KnowledgeGraph":
        if not _HAS_NX or not _HAS_YAML:
            return self

        G = nx.DiGraph()

        # Load ontology + instances
        try:
            ont  = _yaml.safe_load((_ONTOLOGY_DIR / "ontology.yaml").read_text(encoding="utf-8"))
            inst = _yaml.safe_load((_ONTOLOGY_DIR / "instances_updated.yaml").read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.graph = G
            return self

        # Add nodes
        for key, node_type in _TYPE_MAP.items():
            for item in inst.get(key, []):
                node_id = item["id"]
                G.add_node(
                    node_id,
                    label       = item["label"],
                    type        = node_type,
                    color       = _TYPE_COLORS.get(node_type, "#64748b"),
                    description = ont.get("classes", {}).get(node_type, {}).get("description", ""),
                )
                self._node_labels[node_id] = item["label"]
                self._node_types[node_id]  = node_type

        # Add explicit relations
        for triple in inst.get("relations", []):
            if len(triple) == 3 and G.has_node(triple[0]) and G.has_node(triple[2]):
                G.add_edge(triple[0], triple[2], label=triple[1])

        # Enrich: link corpus documents to nodes via entity-mention matching
        corpus = _load_corpus()
        for doc in corpus:
            searchable = " ".join(filter(None, [
                doc.get("title", ""),
                doc.get("content", ""),
                doc.get("definition", ""),
                " ".join(doc.get("tags", [])),
            ]))
            for node_id, label in self._node_labels.items():
                if label.lower() in searchable.lower() or node_id.lower() in searchable.lower():
                    doc_node_id = f"DOC_{doc['id']}"
                    if not G.has_node(doc_node_id):
                        G.add_node(
                            doc_node_id,
                            label          = doc.get("title") or doc.get("term", doc["id"]),
                            type           = "Document",
                            color          = _TYPE_COLORS["Document"],
                            classification = doc.get("classification", ""),
                            category       = doc.get("category", ""),
                        )
                    if not G.has_edge(node_id, doc_node_id):
                        G.add_edge(node_id, doc_node_id, label="HAS_REFERENCE")

        self.graph = G
        return self

    # ── Lineage query ─────────────────────────────────────────────────────────
    def get_lineage(self, node_id: str) -> dict:
        """Return node + its graph neighbours + referenced document nodes."""
        if not self.graph or not self.graph.has_node(node_id):
            return {"node": node_id, "found": False, "neighbors": [], "docs": []}

        G = self.graph
        node_data = dict(G.nodes[node_id])

        predecessors = [
            {
                "id":       n,
                "label":    G.nodes[n].get("label", n),
                "type":     G.nodes[n].get("type", ""),
                "relation": G.edges[n, node_id].get("label", ""),
            }
            for n in G.predecessors(node_id)
            if not n.startswith("DOC_")
        ]
        successors = [
            {
                "id":       n,
                "label":    G.nodes[n].get("label", n),
                "type":     G.nodes[n].get("type", ""),
                "relation": G.edges[node_id, n].get("label", ""),
            }
            for n in G.successors(node_id)
            if not n.startswith("DOC_")
        ]
        docs = [
            {
                "id":             G.nodes[n].get("label", n),
                "node_id":        n,
                "classification": G.nodes[n].get("classification", ""),
                "category":       G.nodes[n].get("category", ""),
            }
            for n in G.successors(node_id)
            if n.startswith("DOC_")
        ]

        return {
            "node":         node_id,
            "found":        True,
            "label":        node_data.get("label", node_id),
            "type":         node_data.get("type", ""),
            "description":  node_data.get("description", ""),
            "predecessors": predecessors,
            "successors":   successors,
            "docs":         docs,
        }

    # ── API format (compatible with existing /api/graph consumer) ─────────────
    def to_api_format(self) -> dict:
        if not self.graph:
            return {"nodes": [], "edges": [], "classes": {}}

        G = self.graph
        nodes = []
        for node_id, data in G.nodes(data=True):
            nodes.append({
                "id":          node_id,
                "label":       data.get("label", node_id),
                "type":        data.get("type", ""),
                "color":       data.get("color", "#64748b"),
                "description": data.get("description", ""),
                "doc_count":   sum(1 for n in G.successors(node_id) if n.startswith("DOC_")),
            })
        edges = [
            {"from": u, "to": v, "label": data.get("label", "")}
            for u, v, data in G.edges(data=True)
            if not u.startswith("DOC_") and not v.startswith("DOC_")
        ]
        return {"nodes": nodes, "edges": edges}

    # ── JSON-LD export ────────────────────────────────────────────────────────
    def export_jsonld(self) -> dict:
        if not self.graph:
            return {"@context": {}, "@graph": []}

        G = self.graph
        context = {
            "@vocab":    "https://govguard.nexum.lu/ontology#",
            "rdfs":      "http://www.w3.org/2000/01/rdf-schema#",
            "govguard":  "https://govguard.nexum.lu/ontology#",
            "label":     "rdfs:label",
            "type":      "@type",
        }
        graph_nodes = []
        for node_id, data in G.nodes(data=True):
            obj: dict = {
                "@id":   f"govguard:{node_id}",
                "@type": data.get("type", "Thing"),
                "label": data.get("label", node_id),
            }
            out_edges = list(G.out_edges(node_id, data=True))
            if out_edges:
                links_by_rel: dict[str, list] = {}
                for _, v, edata in out_edges:
                    rel = edata.get("label", "relatedTo")
                    links_by_rel.setdefault(rel, []).append(f"govguard:{v}")
                for rel, targets in links_by_rel.items():
                    obj[rel] = targets if len(targets) > 1 else targets[0]
            graph_nodes.append(obj)

        return {"@context": context, "@graph": graph_nodes}

    @property
    def node_count(self) -> int:
        return self.graph.number_of_nodes() if self.graph else 0

    @property
    def edge_count(self) -> int:
        return self.graph.number_of_edges() if self.graph else 0
