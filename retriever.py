"""
retriever.py – keyword-based document retrieval with role-based access control.
Mirrors the logic from the original fakeRetriever.js.
"""

import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

# Role → allowed classification tiers
ROLE_PERMISSIONS: dict[str, list[str]] = {
    "Analyst": ["PUBLIC", "INTERNAL"],
    "Manager": ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    "Partner": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "PARTNER_ONLY"],
}


def _load_all_docs() -> list[dict]:
    docs: list[dict] = []
    for fname in ("policies.json", "glossary.json", "data_contracts.json"):
        path = DATA_DIR / fname
        if path.exists():
            docs.extend(json.loads(path.read_text(encoding="utf-8")))
    return docs


ALL_DOCS: list[dict] = _load_all_docs()


# Common English words excluded from matching so generic chit-chat (e.g. "Are you a
# Messi fan or what?") doesn't spuriously score against governance documents.
_STOPWORDS = {
    "are", "you", "your", "yours", "what", "this", "that", "these", "those",
    "have", "has", "had", "the", "and", "for", "with", "from", "was", "were",
    "been", "being", "does", "did", "can", "could", "would", "should", "will",
    "shall", "may", "might", "must", "not", "but", "all", "any", "some", "than",
    "then", "they", "them", "their", "there", "here", "out", "about", "into",
    "over", "under", "only", "just", "more", "most", "such", "own", "same",
    "few", "both", "each", "other", "which", "who", "whom", "whose", "why",
    "how", "when", "where", "also", "its", "our", "ours", "fan", "whats",
}


def _tokenize(text: str) -> list[str]:
    """Lower-case, strip punctuation, return meaningful words of 3+ characters."""
    cleaned = re.sub(r"[^a-z0-9\s]", " ", text.lower())
    return [t for t in cleaned.split() if len(t) >= 3 and t not in _STOPWORDS]


def _score(doc: dict, tokens: list[str]) -> tuple[int, list[str]]:
    haystack = " ".join([
        doc.get("title", ""),
        doc.get("content", ""),
        " ".join(doc.get("tags", [])),
        doc.get("category", ""),
        doc.get("id", ""),
        doc.get("owner", ""),
    ]).lower()
    # Word-level lookup set: prevents false positives from substring matches
    # (e.g. token "are" matching inside "hardware" or "aware").
    haystack_words = set(re.findall(r"[a-z0-9]+", haystack))

    score = 0
    matched: list[str] = []

    for token in tokens:
        if token in haystack_words:
            score += 3 if len(token) > 6 else 2 if len(token) > 4 else 1
            matched.append(token)

    # Title-match bonus
    title_words = set(re.findall(r"[a-z0-9]+", doc.get("title", "").lower()))
    for token in tokens:
        if token in title_words:
            score += 3

    return score, list(set(matched))


def retrieve(query: str, role: str = "Analyst") -> dict | None:
    """
    Returns one of:
      None                                    → no answer
      {"restricted": True, "doc": {...}}      → access denied
      {"doc": {...}, "matched_keywords": [...], "score": int}
    """
    allowed = ROLE_PERMISSIONS.get(role, ROLE_PERMISSIONS["Analyst"])
    tokens = _tokenize(query)

    if not tokens:
        return None

    scored = []
    for doc in ALL_DOCS:
        s, matched = _score(doc, tokens)
        if s > 0:
            scored.append((s, matched, doc))

    if not scored:
        return None

    scored.sort(key=lambda x: x[0], reverse=True)
    best_score, best_matched, best_doc = scored[0]

    threshold = 2 if len(tokens) <= 2 else 3
    if best_score < threshold:
        return None

    if best_doc["classification"] not in allowed:
        return {"restricted": True, "doc": best_doc}

    return {
        "doc": best_doc,
        "matched_keywords": best_matched,
        "score": best_score,
    }


def bm25_retrieve(query: str, role: str = "Analyst", n: int = 10) -> list[dict]:
    """Return up to *n* scored documents for the RAG pipeline's BM25 stage.

    Each item: {doc, score, matched_keywords}
    Only documents the *role* is allowed to access are returned.
    """
    allowed = ROLE_PERMISSIONS.get(role, ROLE_PERMISSIONS["Analyst"])
    tokens  = _tokenize(query)
    if not tokens:
        return []

    scored = []
    for doc in ALL_DOCS:
        if doc["classification"] not in allowed:
            continue
        s, matched = _score(doc, tokens)
        if s > 0:
            scored.append({"doc": doc, "score": s, "matched_keywords": matched})

    scored.sort(key=lambda x: x["score"], reverse=True)

    # Same relevance floor as retrieve(): drop weak/incidental matches so
    # off-topic questions don't pull unrelated documents into the RAG context.
    threshold = 2 if len(tokens) <= 2 else 3
    scored = [s for s in scored if s["score"] >= threshold]

    return scored[:n]
