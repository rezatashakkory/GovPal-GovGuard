"""
src/rag_pipeline.py – Full RAG chain.

Pipeline:
  1. Embed query (Ollama nomic-embed-text)
  2. Vector search top-10 from ChromaDB
  3. BM25 keyword search top-10 from retriever.py
  4. Reciprocal Rank Fusion → top-5 chunks (RBAC filtered)
  5. Build grounded prompt
  6. Generate answer via Ollama LLM (mistral)

Graceful fallback: if Ollama / ChromaDB are unavailable the function still
returns a result using BM25 only with the top document's content as answer.
"""

import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Generator

from src.embeddings import embed, OllamaUnavailableError
from src.embeddings import is_available as _embed_ok
from src.vector_store import query as _vec_query
from src.vector_store import is_available as _chroma_ok

_OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
_LLM_MODEL       = os.getenv("OLLAMA_LLM_MODEL", "mistral")

log = logging.getLogger("govguard.rag_pipeline")

_ROLE_PERMISSIONS: dict[str, list[str]] = {
    "Analyst": ["PUBLIC", "INTERNAL"],
    "Manager": ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    "Partner": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "PARTNER_ONLY"],
}

_LANG_NAMES: dict[str, str] = {
    "EN": "English",
    "FR": "French",
    "DE": "German",
}

# Minimum cosine similarity (1 - distance) for a vector hit to be considered
# relevant. Below this, the embedding match is coincidental (e.g. off-topic
# chit-chat) rather than a genuine semantic match, and must be dropped before
# it reaches the LLM context — otherwise weaker/faster models (e.g. phi3:mini)
# tend to blend irrelevant retrieved snippets into a fabricated-sounding answer
# instead of triggering the fallback message.
_MIN_VECTOR_SCORE = 0.55

_FALLBACK_MSG: dict[str, str] = {
    "EN": "The available governance documents do not contain sufficient information to "
          "answer this question. Please contact the Central Data Office Governance Team directly.",
    "FR": "Les documents de gouvernance disponibles ne contiennent pas suffisamment d'informations "
          "pour répondre à cette question. Veuillez contacter directement l'équipe de gouvernance "
          "du Centre de Données.",
    "DE": "Die verfügbaren Governance-Dokumente enthalten nicht genügend Informationen, um diese "
          "Frage zu beantworten. Bitte wenden Sie sich direkt an das Governance-Team des Central "
          "Data Office.",
}


def _build_system_prompt(language: str) -> str:
    """Build the system prompt with an explicit, language-aware fallback message."""
    lang_code = (language or "EN").upper()
    lang_name = _LANG_NAMES.get(lang_code, "English")
    fallback  = _FALLBACK_MSG.get(lang_code, _FALLBACK_MSG["EN"])
    return f"""You are GovGuard, the Central Data Office's intelligent governance \
assistant at Nexum Financial S.A. Your role is to answer questions about data governance \
policies, glossary terms, data contracts, and regulatory compliance.

You must write your ENTIRE answer in {lang_name} only, from the first word to the last. \
Do not mix languages, do not switch to English partway through, and do not add English (or \
any other language) parenthetical remarks, translations, or clarifications anywhere in your \
answer — every sentence and every parenthesis must be in {lang_name}. Never use "===", "---", \
or similar separators anywhere in your answer. The context documents below are written in \
English — you must translate every fact you use into {lang_name} yourself; never quote or \
copy English sentences from the context into your answer, and never repeat the user's \
question back in English.

Rules:
- Answer ONLY based on the provided context documents. Do NOT add any information \
  that is not explicitly stated in those documents.
- Provide thorough, well-structured answers, entirely in {lang_name}. Use clear headings, \
  numbered lists, or bullet points to organise information. Aim for 150-300 words unless \
  the topic is simple.
- If the context documents do not contain a clear answer, respond with ONLY this exact \
  sentence and nothing else — no parenthetical English translation, no follow-up \
  sentence, no additional information: "{fallback}"
- NEVER infer, guess, extrapolate, or fill in missing details — silence on a topic \
  is always preferable to a fabricated answer.
- Always cite the source document ID (e.g. POL-001, GLO-002) for every factual claim.
- You may ONLY cite document IDs that literally appear in the Context documents block \
  above (e.g. if only POL-002 and DC-002 are given, never write POL-001, DC-999, or any \
  other ID that was not provided to you). If you are not certain a fact is supported by \
  the given context, omit that fact and its citation entirely rather than inventing one.
- When a policy or term has multiple aspects (scope, requirements, responsibilities, \
  exceptions), address each one separately and clearly, in {lang_name}.
- If a question involves personal data processing, remind the user to consult the DPO, \
  in {lang_name}.
- If the user asks about penalties, fines, or legal consequences and the context does \
  not explicitly state them, say so clearly in {lang_name} — do not speculate.
- Before finalising your answer, re-read it and rewrite any word, phrase, or sentence \
  that is not in {lang_name}."""


@dataclass
class Source:
    id:             str
    title:          str
    excerpt:        str
    score:          float
    classification: str
    category:       str


@dataclass
class RagResult:
    answer:               str
    sources:               list[Source] = field(default_factory=list)
    model:                 str = "bm25-fallback"
    latency_ms:            int = 0
    fallback:              bool = False
    unverified_citations:  list[str] = field(default_factory=list)


_CITATION_RE = re.compile(r"\b(?:POL|DC|GLO)-\d{3}\b")

# Some quantised instruct models (observed with mistral) occasionally emit stray
# redaction/anonymisation placeholder tokens mid-sentence (e.g. "[NAME_REDACTED]"),
# likely a residual artefact from privacy-scrubbed training data. These are not
# hallucinated facts, but they look broken to an end user, so strip them out.
# The model sometimes wraps the artefact in quotes (e.g. `"AI [NAME_REDACTED]"`) —
# handle that whole-quoted-span case first, then strip any remaining bare tokens.
_QUOTED_ARTIFACT_RE = re.compile(
    r'["\u201c]([^"\u201c\u201d]*?)\[(?:[A-Za-z]+_)*'
    r'(?:REDACTED|ANONYMIZED|ANONYMISED|MASKED|PLACEHOLDER)\]([^"\u201c\u201d]*?)["\u201d]',
    re.IGNORECASE,
)
_ARTIFACT_RE = re.compile(r"\[(?:[A-Za-z]+_)*(?:REDACTED|ANONYMIZED|ANONYMISED|MASKED|PLACEHOLDER)\]", re.IGNORECASE)


def _clean_answer(answer: str) -> str:
    """Remove stray redaction-placeholder artefacts and tidy up whitespace left behind.

    These placeholders (e.g. "[NAME_REDACTED]") come from src/pii.py masking PII in the
    *query* before it reaches the LLM (correct, privacy-preserving behaviour) — but the
    LLM sometimes quotes the masked question back verbatim in its answer, leaking the
    internal token. Mistral has also been observed markdown-escaping the underscore
    (e.g. "[NAME\\_REDACTED]"), so that escape is normalised away first.
    """
    cleaned = answer.replace("\\_", "_")
    cleaned = _QUOTED_ARTIFACT_RE.sub(lambda m: (m.group(1) + m.group(2)).strip(), cleaned)
    cleaned = _ARTIFACT_RE.sub("", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
    return cleaned.strip()


def _verify_citations(answer: str, sources: list[Source]) -> list[str]:
    """Return citation IDs mentioned in *answer* that are NOT among the retrieved *sources*.

    This catches LLM hallucinations where a plausible-looking document ID (e.g. POL-001)
    is cited even though it was never part of the retrieved/grounded context.
    """
    cited     = set(_CITATION_RE.findall(answer))
    retrieved = {s.id for s in sources}
    return sorted(cited - retrieved)


# ── Reciprocal Rank Fusion ─────────────────────────────────────────────────────
def _rrf_fuse(
    vector_hits: list[dict],
    bm25_hits:   list[dict],
    k:           int = 60,
) -> list[dict]:
    scores:  dict[str, float] = {}
    doc_map: dict[str, dict]  = {}

    for rank, hit in enumerate(vector_hits):
        doc_id = hit.get("metadata", {}).get("doc_id", hit["id"])
        scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
        doc_map[doc_id] = hit

    for rank, hit in enumerate(bm25_hits):
        doc_id = hit.get("id", "")
        scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
        if doc_id not in doc_map:
            doc_map[doc_id] = hit

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [{**doc_map[did], "rrf_score": s} for did, s in ranked if did in doc_map]


# ── Main run function ──────────────────────────────────────────────────────────
def run(query_text: str, role: str = "Analyst", language: str = "EN") -> RagResult:
    """Execute the full RAG pipeline and return a RagResult."""
    start   = time.monotonic()
    allowed = _ROLE_PERMISSIONS.get(role, _ROLE_PERMISSIONS["Analyst"])

    # 1. BM25 (always available)
    from retriever import bm25_retrieve
    bm25_results = bm25_retrieve(query_text, role)

    # 2. Vector search (optional)
    vector_results: list[dict] = []
    if _chroma_ok() and _embed_ok():
        try:
            q_emb          = embed(query_text)
            vector_results = _vec_query(q_emb, n=10)
            vector_results = [
                h for h in vector_results
                if h.get("metadata", {}).get("classification", "PUBLIC") in allowed
                and h.get("score", 0.0) >= _MIN_VECTOR_SCORE
            ]
        except OllamaUnavailableError:
            pass

    # 3. RRF fusion
    bm25_normalised = [
        {
            "id":       r["doc"]["id"],
            "text":     r["doc"].get("content", ""),
            "score":    r["score"] / 20.0,
            "metadata": {
                **r["doc"],
                "doc_id": r["doc"]["id"],
            },
        }
        for r in bm25_results
    ]
    fused = _rrf_fuse(vector_results, bm25_normalised)[:5]

    if not fused:
        return RagResult(answer="", model="bm25-fallback", latency_ms=0, fallback=True)

    # 4. Build source list
    # Display each source's own absolute retriever score (vector cosine similarity, or
    # normalised BM25 score), clipped to [0, 1]. This reflects genuine relevance instead
    # of rescaling the top hit to always show 100%, which hid low-confidence / irrelevant
    # matches (e.g. off-topic questions, or the best-available doc after RBAC filtering).
    sources: list[Source] = []
    for hit in fused:
        meta = hit.get("metadata", {})
        sources.append(Source(
            id             = meta.get("doc_id", hit.get("id", "")),
            title          = meta.get("title", ""),
            excerpt        = (hit.get("text") or meta.get("content", ""))[:300],
            score          = round(min(1.0, max(0.0, hit.get("score", 0.0))), 4),
            classification = meta.get("classification", ""),
            category       = meta.get("category", ""),
        ))

    # 5. LLM generation
    context_blocks = "\n\n".join(
        f"[{s.id}] {s.title}:\n{s.excerpt}" for s in sources
    )
    user_prompt = f"Context documents:\n{context_blocks}\n\nUser question: {query_text}"

    try:
        import ollama as _ollama
        client = _ollama.Client(host=_OLLAMA_BASE_URL, timeout=300)
        resp   = client.chat(
            model    = _LLM_MODEL,
            messages = [
                {"role": "system", "content": _build_system_prompt(language)},
                {"role": "user",   "content": user_prompt},
            ],
        )
        answer        = resp["message"]["content"].strip()
        answer        = _clean_answer(answer)
        model         = _LLM_MODEL
        used_fallback = False
    except Exception as exc:
        log.warning("Ollama LLM call failed (model=%s, host=%s): %s",
                    _LLM_MODEL, _OLLAMA_BASE_URL, exc, exc_info=True)
        best          = fused[0]
        meta          = best.get("metadata", {})
        answer        = meta.get("content") or best.get("text") or meta.get("definition", "")
        model         = "bm25-fallback"
        used_fallback = True

    latency_ms = int((time.monotonic() - start) * 1000)
    return RagResult(
        answer               = answer,
        sources              = sources,
        model                = model,
        latency_ms           = latency_ms,
        fallback             = used_fallback,
        unverified_citations = [] if used_fallback else _verify_citations(answer, sources),
    )


# ── Streaming generator ────────────────────────────────────────────────────────
def stream(
    query_text: str,
    role:       str = "Analyst",
    language:   str = "EN",
) -> Generator[str, None, None]:
    """Yield SSE-formatted data events with LLM tokens, then sources, then [DONE]."""
    import json as _json

    allowed = _ROLE_PERMISSIONS.get(role, _ROLE_PERMISSIONS["Analyst"])

    from retriever import bm25_retrieve
    bm25_results = bm25_retrieve(query_text, role)

    vector_results: list[dict] = []
    if _chroma_ok() and _embed_ok():
        try:
            q_emb          = embed(query_text)
            vector_results = [
                h for h in _vec_query(q_emb, n=10)
                if h.get("metadata", {}).get("classification", "PUBLIC") in allowed
                and h.get("score", 0.0) >= _MIN_VECTOR_SCORE
            ]
        except OllamaUnavailableError:
            pass

    bm25_normalised = [
        {
            "id":       r["doc"]["id"],
            "text":     r["doc"].get("content", ""),
            "score":    r["score"] / 20.0,
            "metadata": {**r["doc"], "doc_id": r["doc"]["id"]},
        }
        for r in bm25_results
    ]
    fused = _rrf_fuse(vector_results, bm25_normalised)[:5]

    if not fused:
        fallback_text = _FALLBACK_MSG.get((language or "EN").upper(), _FALLBACK_MSG["EN"])
        yield f"data: {_json.dumps({'token': fallback_text})}\n\n"
        yield f"data: {_json.dumps({'sources': [], 'model': 'bm25-fallback'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    context_blocks = "\n\n".join(
        f"[{h.get('metadata', {}).get('doc_id', h.get('id',''))}] "
        f"{h.get('metadata', {}).get('title', '')}:\n"
        f"{(h.get('text') or h.get('metadata', {}).get('content', ''))[:300]}"
        for h in fused
    )
    user_prompt = f"Context documents:\n{context_blocks}\n\nUser question: {query_text}"

    model_used = _LLM_MODEL
    try:
        import ollama as _ollama
        client      = _ollama.Client(host=_OLLAMA_BASE_URL)
        stream_resp = client.chat(
            model    = _LLM_MODEL,
            messages = [
                {"role": "system", "content": _build_system_prompt(language)},
                {"role": "user",   "content": user_prompt},
            ],
            stream=True,
        )
        for chunk in stream_resp:
            token = chunk.get("message", {}).get("content", "")
            if token:
                yield f"data: {_json.dumps({'token': token})}\n\n"
    except Exception as exc:
        log.warning("Ollama LLM stream call failed (model=%s, host=%s): %s",
                    _LLM_MODEL, _OLLAMA_BASE_URL, exc, exc_info=True)
        # Fallback: emit the top result content as a single chunk
        best   = fused[0]
        meta   = best.get("metadata", {})
        answer = meta.get("content") or best.get("text") or ""
        yield f"data: {_json.dumps({'token': answer})}\n\n"
        model_used = "bm25-fallback"

    # Final event: sources + model metadata
    sources_payload = [
        {
            "id":             h.get("metadata", {}).get("doc_id", h.get("id", "")),
            "title":          h.get("metadata", {}).get("title", ""),
            "excerpt":        (h.get("text") or h.get("metadata", {}).get("content", ""))[:300],
            "score":          round(min(1.0, max(0.0, h.get("score", 0.0))), 4),
            "classification": h.get("metadata", {}).get("classification", ""),
            "category":       h.get("metadata", {}).get("category", ""),
        }
        for h in fused
    ]
    yield f"data: {_json.dumps({'sources': sources_payload, 'model': model_used})}\n\n"
    yield "data: [DONE]\n\n"
