"""
src/embeddings.py – Embedding client with two backends.

Priority order:
  1. sentence-transformers (all-MiniLM-L6-v2, 384-dim)
     Pure Python, downloads via HuggingFace CDN, works on corporate networks.
  2. Ollama nomic-embed-text (768-dim)
     Requires Ollama service + model pulled locally.

Both expose the same interface: embed(text) → list[float].
Callers catch OllamaUnavailableError (kept for backward compat) on failure.
"""

import os
import logging
from pathlib import Path

log = logging.getLogger("govguard.embeddings")

_ST_MODEL_NAME   = os.getenv("ST_EMBED_MODEL",    "all-MiniLM-L6-v2")
_OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL",   "http://localhost:11434")
_EMBED_MODEL     = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")

# Path where HuggingFace caches models (standard default)
_HF_CACHE_DIR = Path.home() / ".cache" / "huggingface" / "hub"
_ST_CACHE_DIR = _HF_CACHE_DIR / ("models--sentence-transformers--" + _ST_MODEL_NAME.replace("/", "--"))

# ── Backend 1: sentence-transformers ─────────────────────────────────────────
_st_model    = None
_HAS_ST      = False

try:
    from sentence_transformers import SentenceTransformer as _SentenceTransformer
    _HAS_ST = True
except ImportError:
    pass

def _load_st_model():
    global _st_model
    if _st_model is None and _HAS_ST:
        # If the model is already cached locally, skip the network check entirely.
        # This avoids SSL failures on corporate networks with certificate inspection.
        cached = _ST_CACHE_DIR.exists()
        try:
            _st_model = _SentenceTransformer(_ST_MODEL_NAME, local_files_only=cached)
            log.info("Sentence-transformers loaded: %s (local_only=%s)", _ST_MODEL_NAME, cached)
        except Exception as exc:
            if cached:
                # Cache exists but local_files_only failed — try without restriction
                try:
                    _st_model = _SentenceTransformer(_ST_MODEL_NAME)
                    log.info("Sentence-transformers loaded via network fallback: %s", _ST_MODEL_NAME)
                except Exception as exc2:
                    log.warning("Failed to load sentence-transformers model: %s", exc2)
            else:
                log.warning("Failed to load sentence-transformers model: %s", exc)
    return _st_model

# ── Backend 2: Ollama ─────────────────────────────────────────────────────────
_HAS_OLLAMA = False
try:
    import ollama as _ollama
    _HAS_OLLAMA = True
except ImportError:
    pass


class OllamaUnavailableError(RuntimeError):
    """Raised when no embedding backend is available."""


def embed(text: str) -> list[float]:
    """Return the embedding vector for *text*.

    Tries sentence-transformers first, then Ollama.
    Raises OllamaUnavailableError if both are unavailable.
    """
    # --- sentence-transformers (primary) ---
    model = _load_st_model()
    if model is not None:
        try:
            vec = model.encode(text, normalize_embeddings=True)
            return vec.tolist()
        except Exception as exc:
            log.warning("sentence-transformers embed failed: %s", exc)

    # --- Ollama (secondary) ---
    if _HAS_OLLAMA:
        try:
            client   = _ollama.Client(host=_OLLAMA_BASE_URL)
            response = client.embeddings(model=_EMBED_MODEL, prompt=text)
            return response["embedding"]
        except Exception as exc:
            log.warning("Ollama embedding failed: %s", exc)

    raise OllamaUnavailableError(
        "No embedding backend available. "
        "Install sentence-transformers (pip install sentence-transformers) "
        "or start Ollama with nomic-embed-text pulled."
    )


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed multiple texts. Uses batch encoding when sentence-transformers is available."""
    model = _load_st_model()
    if model is not None:
        try:
            vecs = model.encode(texts, normalize_embeddings=True, batch_size=32)
            return [v.tolist() for v in vecs]
        except Exception as exc:
            log.warning("sentence-transformers batch embed failed: %s", exc)
    return [embed(t) for t in texts]


def is_available() -> bool:
    """Return True if any embedding backend is ready."""
    if _load_st_model() is not None:
        return True
    if _HAS_OLLAMA:
        try:
            embed("ping")
            return True
        except OllamaUnavailableError:
            pass
    return False
