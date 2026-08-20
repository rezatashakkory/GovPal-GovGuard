"""
src/ingest.py – Document ingestion pipeline.

Processes uploaded files (bytes or Path) through:
  extract text → PII masking → chunk → embed → ChromaDB upsert

Used by:
  - /api/upload-doc  (inline ingestion after upload)
  - Startup indexer  (batch processing of JSON corpus)
"""

import datetime
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from src.pii import mask as _mask_pii, has_pii as _has_pii
from src.embeddings import embed, is_available as _embed_ok, OllamaUnavailableError
from src.vector_store import add_batch, count as _count_chunks, is_available as _chroma_ok

_CHUNK_SIZE    = 500
_CHUNK_OVERLAP = 100

# In-process ingestion statistics (resets on server restart)
_status: dict = {"total_docs": 0, "total_chunks": 0, "last_indexed": None}


@dataclass
class IngestResult:
    filename:     str
    doc_id:       str
    n_chunks:     int
    skipped:      bool = False
    reason:       str  = ""
    pii_redacted: bool = False


def _chunk_text(text: str) -> list[str]:
    if len(text) <= _CHUNK_SIZE:
        return [text.strip()] if text.strip() else []
    chunks, start = [], 0
    while start < len(text):
        end   = min(start + _CHUNK_SIZE, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += _CHUNK_SIZE - _CHUNK_OVERLAP
    return chunks


def _make_doc_id(filename: str) -> str:
    base = re.sub(r"[^A-Z0-9]", "", Path(filename).stem.upper())[:16]
    return f"UP-{base}"


def ingest_text(
    text:           str,
    filename:       str,
    classification: str = "INTERNAL",
    category:       str = "Upload",
) -> IngestResult:
    """Ingest plain *text* originating from *filename* into ChromaDB."""
    if not _chroma_ok():
        return IngestResult(filename=filename, doc_id="", n_chunks=0, skipped=True,
                            reason="ChromaDB unavailable")
    if not _embed_ok():
        return IngestResult(filename=filename, doc_id="", n_chunks=0, skipped=True,
                            reason="Ollama embeddings unavailable")

    pii_found  = _has_pii(text)
    clean_text = _mask_pii(text) if pii_found else text
    doc_id     = _make_doc_id(filename)
    chunks     = _chunk_text(clean_text)

    ids, texts, embeddings, metadatas = [], [], [], []
    for i, chunk in enumerate(chunks):
        try:
            emb = embed(chunk)
        except OllamaUnavailableError:
            break
        h   = hashlib.md5(chunk.encode()).hexdigest()[:8]
        cid = f"{doc_id}__c{i}__{h}"
        ids.append(cid)
        texts.append(chunk)
        embeddings.append(emb)
        metadatas.append({
            "doc_id":         doc_id,
            "title":          Path(filename).stem,
            "classification": classification,
            "category":       category,
            "source_file":    filename,
            "chunk_index":    i,
        })

    if ids:
        add_batch(ids, texts, embeddings, metadatas)
        _status["total_docs"]   += 1
        _status["total_chunks"] += len(ids)
        _status["last_indexed"]  = datetime.datetime.utcnow().isoformat()

    return IngestResult(
        filename     = filename,
        doc_id       = doc_id,
        n_chunks     = len(ids),
        pii_redacted = pii_found,
    )


def ingest_file(path: Path, classification: str = "INTERNAL") -> IngestResult:
    """Extract text from *path* on disk and ingest into ChromaDB."""
    ext = path.suffix.lower()
    try:
        if ext == ".txt":
            text = path.read_text(encoding="utf-8", errors="replace")
        elif ext == ".docx":
            from docx import Document as _Doc
            doc  = _Doc(str(path))
            text = "\n".join(p.text.strip() for p in doc.paragraphs if p.text.strip())
        elif ext == ".pdf":
            import pdfplumber
            pages: list[str] = []
            with pdfplumber.open(str(path)) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        pages.append(t)
            text = "\n\n".join(pages)
        else:
            return IngestResult(filename=path.name, doc_id="", n_chunks=0, skipped=True,
                                reason=f"Unsupported file type: {ext}")
    except Exception as exc:
        return IngestResult(filename=path.name, doc_id="", n_chunks=0, skipped=True,
                            reason=str(exc))

    return ingest_text(text, path.name, classification)


def get_status() -> dict:
    """Return current ingestion statistics."""
    return {
        "total_docs":    _status["total_docs"],
        "total_chunks":  _status["total_chunks"],
        "last_indexed":  _status["last_indexed"],
        "chroma_chunks": _count_chunks(),
    }
