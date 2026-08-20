"""
src/indexer.py – Startup corpus indexer.

Loads the governance corpus (JSON records in this project's own data/ folder)
→ chunks text → embeds with Ollama → upserts into ChromaDB.

Idempotent: if ChromaDB already contains chunks, skips re-indexing.
Call run(force=True) to force a full re-index.

NOTE: This indexer must only ever read from this project's own data/ folder.
Do not add paths that reach into sibling projects or other directories.
"""

import hashlib
import json
from pathlib import Path

from src.embeddings import embed, is_available as _embed_ok, OllamaUnavailableError
from src.vector_store import add_batch, count as _count, is_available as _chroma_ok

_ROOT        = Path(__file__).parent.parent
_DATA_DIR    = _ROOT / "data"

_CHUNK_SIZE    = 500
_CHUNK_OVERLAP = 100


def _chunk_text(text: str, size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    """Split *text* into overlapping character-level chunks."""
    if len(text) <= size:
        return [text.strip()] if text.strip() else []
    chunks, start = [], 0
    while start < len(text):
        end = min(start + size, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += size - overlap
    return chunks


def _chunk_id(doc_id: str, chunk_index: int, text: str) -> str:
    h = hashlib.md5(text.encode()).hexdigest()[:8]
    return f"{doc_id}__c{chunk_index}__{h}"


# ── JSON corpus ────────────────────────────────────────────────────────────────
def _index_json_corpus() -> tuple[int, int]:
    n_docs = n_chunks = 0
    for fname in ("policies.json", "glossary.json", "data_contracts.json"):
        fp = _DATA_DIR / fname
        if not fp.exists():
            continue
        records = json.loads(fp.read_text(encoding="utf-8"))
        for doc in records:
            full_text = " ".join(filter(None, [
                doc.get("title", ""),
                doc.get("content", ""),
                doc.get("definition", ""),
                " ".join(doc.get("tags", [])),
            ]))
            chunks = _chunk_text(full_text)
            ids, texts, embeddings, metadatas = [], [], [], []
            for i, chunk in enumerate(chunks):
                try:
                    emb = embed(chunk)
                except OllamaUnavailableError:
                    return n_docs, n_chunks  # abort silently
                cid = _chunk_id(doc["id"], i, chunk)
                ids.append(cid)
                texts.append(chunk)
                embeddings.append(emb)
                metadatas.append({
                    "doc_id":         doc["id"],
                    "title":          doc.get("title", ""),
                    "classification": doc.get("classification", "PUBLIC"),
                    "category":       doc.get("category", ""),
                    "source_file":    fname,
                    "chunk_index":    i,
                })
            if ids:
                add_batch(ids, texts, embeddings, metadatas)
                n_chunks += len(ids)
                n_docs   += 1
    return n_docs, n_chunks


# ── Public entry point ─────────────────────────────────────────────────────────
def run(force: bool = False) -> dict:
    """
    Index the full corpus into ChromaDB.

    Skips if ChromaDB already has content (idempotent by default).
    Pass force=True to re-index regardless.
    """
    if not _chroma_ok():
        return {"status": "skipped", "reason": "ChromaDB not available"}
    if not _embed_ok():
        return {"status": "skipped", "reason": "Embedding backend not available"}
    if not force and _count() > 0:
        return {"status": "skipped", "reason": f"Already indexed ({_count()} chunks)"}

    n_json_docs, n_json_chunks = _index_json_corpus()

    return {
        "status":       "ok",
        "json_docs":    n_json_docs,
        "json_chunks":  n_json_chunks,
        "total_chunks": n_json_chunks,
    }
