"""
src/vector_store.py – ChromaDB wrapper for governance document chunks.

Collection : govdocs
Persistence: data/chroma_db/  (configurable via VECTOR_DB_PATH env var)

All methods degrade silently when ChromaDB is unavailable so the app
continues working in BM25-only mode.
"""

import os
from pathlib import Path
from typing import Optional

_DB_PATH = os.getenv(
    "VECTOR_DB_PATH",
    str(Path(__file__).parent.parent / "data" / "chroma_db"),
)

_client     = None
_collection = None
_HAS_CHROMA = False

try:
    import chromadb
    from chromadb.config import Settings

    Path(_DB_PATH).mkdir(parents=True, exist_ok=True)
    _client = chromadb.PersistentClient(
        path=_DB_PATH,
        settings=Settings(anonymized_telemetry=False),
    )
    _collection = _client.get_or_create_collection(
        name="govdocs",
        metadata={"hnsw:space": "cosine"},
    )
    _HAS_CHROMA = True
except Exception:
    pass


def is_available() -> bool:
    return _HAS_CHROMA and _collection is not None


def add(doc_id: str, text: str, embedding: list[float], metadata: dict) -> None:
    """Upsert a single chunk into the collection."""
    if not is_available():
        return
    _collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[text],
        metadatas=[metadata],
    )


def add_batch(
    ids:        list[str],
    texts:      list[str],
    embeddings: list[list[float]],
    metadatas:  list[dict],
) -> None:
    """Upsert a batch of chunks. Silently skips if ChromaDB unavailable."""
    if not is_available() or not ids:
        return
    _collection.upsert(
        ids=ids,
        embeddings=embeddings,
        documents=texts,
        metadatas=metadatas,
    )


def query(
    embedding: list[float],
    n:         int = 10,
    where:     Optional[dict] = None,
) -> list[dict]:
    """Return top-n chunks most similar to *embedding*.

    Each result dict: {id, text, score, metadata}
    score is 1 - cosine_distance  (1.0 = identical).
    """
    if not is_available():
        return []
    total = count()
    if total == 0:
        return []
    n_results = min(n, total)
    kwargs: dict = {
        "query_embeddings": [embedding],
        "n_results":        n_results,
        "include":          ["documents", "metadatas", "distances"],
    }
    if where:
        kwargs["where"] = where

    results = _collection.query(**kwargs)
    output  = []
    for i, doc_id in enumerate(results["ids"][0]):
        distance   = results["distances"][0][i]
        similarity = max(0.0, 1.0 - distance)
        output.append({
            "id":       doc_id,
            "text":     results["documents"][0][i],
            "score":    round(similarity, 4),
            "metadata": results["metadatas"][0][i],
        })
    return output


def count() -> int:
    """Return total number of chunks currently stored."""
    if not is_available():
        return 0
    return _collection.count()


def delete_by_prefix(prefix: str) -> None:
    """Delete all chunks whose IDs start with *prefix*."""
    if not is_available():
        return
    all_ids = _collection.get(where_document=None)["ids"]
    to_delete = [i for i in all_ids if i.startswith(prefix)]
    if to_delete:
        _collection.delete(ids=to_delete)
