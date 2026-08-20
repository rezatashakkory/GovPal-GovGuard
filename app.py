r"""
================================================================================
app.py  --  FastAPI entry point for GovPal-GovGuard
================================================================================

PREREQUISITES  (one-time setup, already done on this machine)
-------------------------------------------------------------
  Python 3.10+, Node not required.
  Virtual environment:  GovPal-GovGuard/.venv/
  Dependencies:         pip install -r requirements.txt
  Ollama models:        mistral:latest (4.4 GB)  --  primary LLM
                        phi3:mini      (2.4 GB)  --  faster alternative
                        Models are blocked on corporate VPN. To install:
                        1. Download GGUF file via browser from huggingface.co
                        2. Create a Modelfile containing: FROM path/to/file.gguf
                        3. Run: ollama create <model-name> -f Modelfile

HOW TO START  (every session)
------------------------------
Step 1 -- Open a terminal (PowerShell) and go to the project root folder:

  cd path/to/GovPal-GovGuard        # relative path from wherever you are
                                    # e.g. from Projects/: cd GovPal-GovGuard

Step 2 -- Activate the virtual environment:

  .\.venv\Scripts\Activate.ps1      # Windows PowerShell
  source .venv/bin/activate         # macOS / Linux / Git Bash

Step 3 -- Start the server:

  uvicorn app:app --host 127.0.0.1 --port 8000

Step 4 -- Open in browser:  http://127.0.0.1:8000
          Stop server:       Ctrl+C in this terminal.

FULL ONE-LINERS  (paste into ANY fresh PowerShell terminal, e.g. after a
reboot -- no need to cd or activate the venv manually first, it's all included):

  -- Option A: MISTRAL (default, higher quality, ~60s first response) --
cd "<path-to-project>/GovPal-GovGuard"; $p=(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){Stop-Process -Id $p -Force}; ./.venv/Scripts/Activate.ps1; $env:OLLAMA_LLM_MODEL="mistral"; uvicorn app:app --host 127.0.0.1 --port 8000

  -- Option B: PHI3 (faster, ~30s response, slightly lower quality) --
cd "<path-to-project>/GovPal-GovGuard"; $p=(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){Stop-Process -Id $p -Force}; ./.venv/Scripts/Activate.ps1; $env:OLLAMA_LLM_MODEL="phi3:mini"; uvicorn app:app --host 127.0.0.1 --port 8000

  Run only ONE of the two. The $p check safely skips the kill step when
  port 8000 is already free (the old one-liner crashed with "Cannot bind
  argument ... null" in that case). The kill step is only needed when VS
  Code was previously closed without stopping the server -- [Errno 10048].
  If Ollama itself isn't running (fresh reboot), start the Ollama app first
  or run `ollama serve` in a separate terminal.

DEV MODE  (for active development only -- not for demos)
---------------------------------------------------------
  Adds --reload so the server restarts automatically when you save any file
  inside src/, templates/, or static/. Do NOT use for demos as it adds a
  few-second restart delay on every save.

  uvicorn app:app --reload --reload-dir src --reload-dir templates --reload-dir static --host 127.0.0.1 --port 8000

SWITCH LLM MODEL  (optional -- run this BEFORE uvicorn in the same terminal)
-----------------------------------------------------------------------------
  The default model is mistral (~60s first response on CPU, ~15s after warm-up).
  Switch to phi3:mini for faster responses (~30s) at slightly lower quality.
  The switch only applies to the current terminal session.

  $env:OLLAMA_LLM_MODEL = "phi3:mini"   # then run uvicorn as normal
  $env:OLLAMA_LLM_MODEL = "mistral"     # revert to default

  This variable is read in src/rag_pipeline.py at startup.

How to STOP
$p = (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($p) { Stop-Process -Id $p -Force; Write-Host "Stopped process $p" } else { Write-Host "Nothing running on port 8000" }
  
DEMO CREDENTIALS
----------------
  analyst@example.com  /  Analyst123!   role: Analyst  (PUBLIC + INTERNAL docs)
  manager@example.com  /  Manager123!   role: Manager  (+ CONFIDENTIAL docs)
  partner@example.com  /  Partner123!   role: Partner  (+ RESTRICTED docs)
================================================================================
"""


import io
import json
import logging
import threading
import asyncio
import yaml
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from retriever import retrieve
from translations import TRANSLATIONS
from src.auth import authenticate, create_token, decode_token, AuthError
from src.audit import log_query, startup_purge, get_recent, get_stats as audit_stats, save_feedback
from src.pii import has_pii, mask as mask_pii
from src.kg_builder import KnowledgeGraph
from src.ingest import ingest_text, get_status as ingest_status_fn

_RAG_AVAILABLE = False
try:
    from src.rag_pipeline import run as rag_run, stream as rag_stream
    _RAG_AVAILABLE = True
except Exception:
    pass

try:
    import pdfplumber as _pdfplumber
    _HAS_PDF = True
except ImportError:
    _HAS_PDF = False

try:
    from docx import Document as _DocxDocument
    _HAS_DOCX = True
except ImportError:
    _HAS_DOCX = False

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("govguard")

app = FastAPI(title="GovPal-GovGuard")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

_security = HTTPBearer(auto_error=False)
_MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB

_GAP_DIMS = [
    {"name": "Data Classification",  "keys": ["classif", "tier", "confidential", "restricted", "public", "internal", "personal", "sensitive"]},
    {"name": "Data Retention",        "keys": ["retention", "retain", "archive", "delet", "expir", "7 year", "gdpr", "disposal", "purpose"]},
    {"name": "Data Quality",          "keys": ["quality", "accuracy", "accurat", "completeness", "validat", "error", "cleanse", "integrity"]},
    {"name": "Access Control",        "keys": ["access", "permission", "role", "rbac", "authoris", "restrict", "entitlement", "least privilege"]},
    {"name": "Data Lineage",          "keys": ["lineage", "source", "origin", "transformation", "pipeline", "upstream", "downstream", "provenance"]},
    {"name": "Regulatory Compliance", "keys": ["cssf", "gdpr", "regulat", "comply", "compliance", "audit", "legal", "obligation", "directive"]},
]


def _load_all_docs() -> list[dict]:
    data_dir = Path(__file__).parent / "data"
    docs: list[dict] = []
    for fname in ["policies.json", "glossary.json", "data_contracts.json"]:
        fp = data_dir / fname
        if fp.exists():
            docs.extend(json.loads(fp.read_text(encoding="utf-8")))
    return docs


_ALL_DOCS = _load_all_docs()
_KG = KnowledgeGraph().build()

_ROLE_VISIBLE: dict[str, set[str]] = {
    "Analyst": {"PUBLIC", "INTERNAL"},
    "Manager": {"PUBLIC", "INTERNAL", "CONFIDENTIAL"},
    "Partner": {"PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "PARTNER_ONLY"},
}
log.info("Knowledge graph: %d nodes, %d edges", _KG.node_count, _KG.edge_count)


@app.on_event("startup")
async def on_startup():
    purged = startup_purge()
    log.info("Audit purge: removed %d old entries", purged)

    def _bg_index():
        try:
            from src.vector_store import count as _count
            if _count() > 0:
                log.info("ChromaDB already has %d chunks – skipping re-index", _count())
                return
            from src.indexer import run as idx_run
            result = idx_run()
            log.info("Indexer result: %s", result)
        except Exception as exc:
            log.warning("Indexer error: %s", exc)

    threading.Thread(target=_bg_index, daemon=True).start()


# ── Auth helpers ───────────────────────────────────────────────────────────────
def _get_user(credentials: HTTPAuthorizationCredentials = Depends(_security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        return decode_token(credentials.credentials)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc))


def _require_manager(user: dict = Depends(_get_user)) -> dict:
    if user.get("role") not in ("Manager", "Partner"):
        raise HTTPException(status_code=403, detail="Insufficient permissions.")
    return user


# ── Request / response models ──────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email:    str
    password: str


class ChatRequest(BaseModel):
    query:    str
    language: str = "EN"


class FeedbackRequest(BaseModel):
    msg_id: str
    type:   str


class GapRequest(BaseModel):
    text:  str
    title: str = "Untitled Document"


import time as _time

# ── Routes ─────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        request=request, name="index.html",
        context={"translations": TRANSLATIONS, "cache_bust": int(_time.time())},
    )


@app.post("/api/login")
async def login(body: LoginRequest):
    try:
        user = authenticate(body.email, body.password)
    except AuthError:
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    token = create_token(user)
    return {
        "access_token": token,
        "token_type":   "bearer",
        "role":         user["role"],
        "name":         user.get("name", ""),
    }


@app.post("/api/chat")
async def chat(body: ChatRequest, user: dict = Depends(_get_user)):
    role       = user.get("role", "Analyst")
    session_id = user.get("sub", "unknown")
    pii_found  = has_pii(body.query)
    safe_query = mask_pii(body.query) if pii_found else body.query

    if _RAG_AVAILABLE:
        try:
            loop   = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, rag_run, safe_query, role, body.language)
            if result.fallback and not result.sources:
                log_query(session_id, body.query, role, "no_answer", pii_detected=pii_found)
                return {"type": "no_answer"}
            resp_type = "answer" if not result.fallback else "bm25_fallback"
            log_query(session_id, body.query, role, resp_type,
                      n_sources=len(result.sources), model=result.model,
                      latency_ms=result.latency_ms, pii_detected=pii_found)
            return {
                "type":     "answer",
                "answer":   result.answer,
                "sources":  [
                    {
                        "id":             s.id,
                        "title":          s.title,
                        "excerpt":        s.excerpt,
                        "score":          s.score,
                        "classification": s.classification,
                        "category":       s.category,
                    }
                    for s in result.sources
                ],
                "model":    result.model,
                "fallback": result.fallback,
                "unverified_citations": result.unverified_citations,
            }
        except Exception as exc:
            log.warning("RAG pipeline error: %s", exc)

    # BM25 fallback path
    result_bm25 = retrieve(safe_query, role)
    if result_bm25 is None:
        log_query(session_id, body.query, role, "no_answer", pii_detected=pii_found)
        return {"type": "no_answer"}
    if result_bm25.get("restricted"):
        log_query(session_id, body.query, role, "restricted", pii_detected=pii_found)
        return {"type": "restricted", "doc": result_bm25["doc"]}
    doc = result_bm25["doc"]
    log_query(session_id, body.query, role, "answer", n_sources=1,
              model="bm25", pii_detected=pii_found)
    return {
        "type":             "answer",
        "answer":           doc.get("content", ""),
        "sources":          [{
            "id":             doc.get("id", ""),
            "title":          doc.get("title", ""),
            "excerpt":        doc.get("content", "")[:300],
            "score":          round(result_bm25["score"] / 20.0, 3),
            "classification": doc.get("classification", ""),
            "category":       doc.get("category", ""),
        }],
        "model":            "bm25",
        "fallback":         True,
        # Legacy fields kept for backward-compat with existing JS response card
        "doc":              doc,
        "matched_keywords": result_bm25.get("matched_keywords", []),
        "score":            result_bm25["score"],
    }


@app.get("/api/chat/stream")
async def chat_stream(
    query:    str,
    language: str  = "EN",
    user:     dict = Depends(_get_user),
):
    role       = user.get("role", "Analyst")
    safe_query = mask_pii(query) if has_pii(query) else query

    if not _RAG_AVAILABLE:
        async def _fallback_gen():
            import json as _j
            bm25 = retrieve(safe_query, role)
            if bm25 and not bm25.get("restricted"):
                doc = bm25["doc"]
                yield f"data: {_j.dumps({'token': doc.get('content', '')})}\n\n"
                yield f"data: {_j.dumps({'sources': [{'id': doc['id'], 'title': doc.get('title', '')}]})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(_fallback_gen(), media_type="text/event-stream")

    def _sync_gen():
        for event in rag_stream(safe_query, role, language):
            yield event

    return StreamingResponse(_sync_gen(), media_type="text/event-stream")


@app.post("/api/feedback")
async def feedback(body: FeedbackRequest, user: dict = Depends(_get_user)):
    session_id = user.get("sub", "unknown")
    status     = save_feedback(session_id, body.msg_id, body.type)
    return {"status": status}


@app.get("/api/translations/{lang}")
async def get_translations(lang: str):
    return TRANSLATIONS.get(lang.upper(), TRANSLATIONS["EN"])


@app.get("/api/docs")
async def list_docs(user: dict = Depends(_get_user)):
    role    = user.get("role", "Analyst")
    visible = _ROLE_VISIBLE.get(role, {"PUBLIC"})
    result  = []
    for doc in _ALL_DOCS:
        cls = doc.get("classification", "PUBLIC").upper()
        if cls in visible:
            result.append({
                "id":               doc["id"],
                "title":            doc.get("title") or doc.get("term", doc["id"]),
                "category":         doc.get("category", ""),
                "classification":   doc.get("classification", "PUBLIC"),
                "owner":            doc.get("owner", ""),
                "date":             doc.get("last_updated", doc.get("effective_date", "")),
                "tags":             doc.get("tags", []),
                "confidence_score": doc.get("confidence_score", 80),
            })
    return {"docs": result, "total": len(result), "role": role}


@app.get("/api/lineage/{node_label}")
async def lineage(node_label: str, user: dict = Depends(_get_user)):
    lineage_data = _KG.get_lineage(node_label)
    if lineage_data.get("found"):
        return lineage_data
    # Fallback: substring search
    label_lower = node_label.lower()
    hits = []
    for doc in _ALL_DOCS:
        searchable = " ".join([
            doc.get("title", ""), doc.get("term", ""),
            doc.get("content", ""), doc.get("definition", ""),
            " ".join(doc.get("tags", [])),
        ]).lower()
        if label_lower in searchable:
            hits.append({
                "id":             doc["id"],
                "title":          doc.get("title") or doc.get("term", doc["id"]),
                "category":       doc.get("category", ""),
                "classification": doc.get("classification", ""),
            })
    return {"node": node_label, "found": False, "docs": hits}


@app.post("/api/gap-analysis")
async def gap_analysis(body: GapRequest, user: dict = Depends(_get_user)):
    text_lower = body.text.lower()
    scores = []
    for dim in _GAP_DIMS:
        found = [k for k in dim["keys"] if k in text_lower]
        score = min(100, round((len(found) / len(dim["keys"])) * 100))
        scores.append({"dimension": dim["name"], "score": score, "found": found})
    overall = round(sum(s["score"] for s in scores) / len(scores))
    gaps    = [s["dimension"] for s in scores if s["score"] < 40]
    return {"title": body.title, "scores": scores, "overall": overall, "gaps": gaps}


@app.get("/api/graph")
async def graph_data(user: dict = Depends(_get_user)):
    kg_data = _KG.to_api_format()
    if kg_data["nodes"]:
        return {**kg_data, "classes": {}}
    # Fallback: direct YAML read
    data_root = Path(__file__).parent / "data" / "ontology"
    try:
        ontology  = yaml.safe_load((data_root / "ontology.yaml").read_text(encoding="utf-8"))
        instances = yaml.safe_load((data_root / "instances_updated.yaml").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"nodes": [], "edges": [], "classes": {}, "error": "ontology files not found"}
    TYPE_COLORS = {"Client": "#ff6f00", "Engagement": "#3b82f6", "Partner": "#10b981", "Regulator": "#f59e0b"}
    TYPE_MAP    = {"clients": "Client", "engagements": "Engagement", "partners": "Partner", "regulators": "Regulator"}
    nodes = []
    for key, cls in TYPE_MAP.items():
        for item in instances.get(key, []):
            nodes.append({
                "id": item["id"], "label": item["label"], "type": cls,
                "color": TYPE_COLORS[cls],
                "description": ontology["classes"].get(cls, {}).get("description", ""),
            })
    edges = [{"from": r[0], "to": r[2], "label": r[1]} for r in instances.get("relations", [])]
    return {"nodes": nodes, "edges": edges, "classes": ontology.get("classes", {})}


@app.get("/api/graph/export")
async def graph_export(user: dict = Depends(_get_user)):
    return _KG.export_jsonld()


@app.get("/api/audit-log")
async def audit_log(n: int = 100, user: dict = Depends(_require_manager)):
    return {"entries": get_recent(n), "stats": audit_stats()}


@app.get("/api/ingest/status")
async def get_ingest_status(user: dict = Depends(_get_user)):
    return ingest_status_fn()


@app.post("/api/upload-doc")
async def upload_doc(
    file: UploadFile = File(...),
    user: dict       = Depends(_get_user),
):
    filename = (file.filename or "unknown").strip()
    ext      = Path(filename).suffix.lower()
    content  = await file.read()

    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 8 MB).")

    if ext == ".txt":
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            text = content.decode("latin-1", errors="replace")
        parsed = {"text": text.strip(), "filename": filename, "method": "text", "pages": 1}

    elif ext == ".pdf":
        if not _HAS_PDF:
            raise HTTPException(status_code=422,
                                detail="PDF parsing library not installed. Upload .txt instead.")
        try:
            pages_text: list[str] = []
            with _pdfplumber.open(io.BytesIO(content)) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t and t.strip():
                        pages_text.append(t.strip())
            if not pages_text:
                raise HTTPException(status_code=422, detail="No text extracted from PDF.")
            parsed = {"text": "\n\n".join(pages_text), "filename": filename,
                      "method": "pdfplumber", "pages": len(pages_text)}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"PDF parse error: {exc}")

    elif ext == ".docx":
        if not _HAS_DOCX:
            raise HTTPException(status_code=422,
                                detail="DOCX parsing library not installed. Upload .txt instead.")
        try:
            doc   = _DocxDocument(io.BytesIO(content))
            paras = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
            if not paras:
                raise HTTPException(status_code=422, detail="DOCX appears to be empty.")
            parsed = {"text": "\n\n".join(paras), "filename": filename,
                      "method": "python-docx", "pages": len(paras)}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"DOCX parse error: {exc}")

    else:
        raise HTTPException(status_code=400,
                            detail=f"Unsupported file type '{ext}'. Use .pdf, .docx, or .txt.")

    # Index into ChromaDB (best-effort, non-blocking)
    try:
        role_to_cls = {"Partner": "CONFIDENTIAL", "Manager": "INTERNAL"}
        cls = role_to_cls.get(user.get("role", ""), "INTERNAL")
        ingest_text(parsed["text"], filename, classification=cls)
    except Exception:
        pass

    return parsed
