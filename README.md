# GovPal-GovGuard

An AI-powered, retrieval-augmented (RAG) chatbot proof of concept for data governance teams. It lets users ask natural-language questions about governance policies, glossary terms, and data contracts, and returns cited, role-aware answers — running entirely on local infrastructure with no external API calls.

> This is a Phase 1 proof-of-concept built with synthetic/demo data for a fictional organisation ("Nexum Financial S.A."). No real client, employee, or company data is included.

## Key Features

- **Grounded Q&A** — hybrid retrieval (BM25 keyword search + vector similarity search, fused with Reciprocal Rank Fusion) feeds a locally-hosted LLM (Ollama, `mistral` or `phi3:mini`), with citation verification to flag unsupported claims.
- **Role-Based Access Control (RBAC)** — three tiers (Analyst, Manager, Partner), each seeing only the document classifications they're authorised for, enforced at retrieval time.
- **Knowledge Graph** — a graph of governance entities (clients, engagements, partners, regulators, policies, teams, domains) with lineage queries and JSON-LD export.
- **Policy Gap Analysis** — scores any pasted or uploaded document against six governance dimensions (classification, retention, quality, access control, lineage, regulatory compliance) and drafts template remediation clauses.
- **PII Protection** — regex-based detection and masking of emails, IBANs, phone numbers, and national IDs before any query is logged or sent to the LLM.
- **Audit Trail** — every query is logged with a one-way SHA-256 hash (raw text is never stored), with configurable retention and export.
- **Multilingual** — full UI and response translation across English, French, and German.
- **Document Ingestion** — upload PDF, DOCX, or TXT files; parsed, chunked, embedded, and indexed automatically.
- **Governance Maturity Dashboard** — coverage heatmaps, KPI cards, and a one-click summary report.

## Architecture

```
Browser (SPA)  →  FastAPI backend (app.py)
                     ├── Auth (JWT, RBAC)
                     ├── RAG pipeline (BM25 + ChromaDB vector search → RRF fusion → local LLM)
                     ├── Knowledge graph (NetworkX, built from YAML ontology)
                     ├── PII detection & masking
                     ├── Audit logging (SQLite, hashed queries only)
                     └── Document ingestion (PDF/DOCX/TXT → chunk → embed → index)
```

All processing (embeddings, vector search, LLM inference) runs on local/on-premises infrastructure via [Ollama](https://ollama.com/); no governance data leaves the host machine.

## Setup

**Prerequisites**: Python 3.10+, [Ollama](https://ollama.com/) with the `mistral` and/or `phi3:mini` models pulled.

```powershell
git clone <your-repo-url>
cd GovPal-GovGuard
python -m venv .venv
./.venv/Scripts/Activate.ps1      # Windows PowerShell
# source .venv/bin/activate       # macOS / Linux
pip install -r requirements.txt
cp .env.example .env              # then edit JWT_SECRET etc. for your environment
```

Start Ollama (`ollama serve`) and pull a model if you haven't already:

```powershell
ollama pull mistral
```

Run the app:

```powershell
uvicorn app:app --host 127.0.0.1 --port 8000
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

### Demo Accounts

| Email | Password | Role |
|---|---|---|
| analyst@example.com | Analyst123! | Analyst (PUBLIC + INTERNAL docs) |
| manager@example.com | Manager123! | Manager (+ CONFIDENTIAL docs) |
| partner@example.com | Partner123! | Partner (+ RESTRICTED docs) |

These are fictional demo accounts for local evaluation only.

## Project Structure

```
app.py                  FastAPI entry point and routes
retriever.py             BM25 keyword retrieval (fallback path)
translations.py          UI string translations (EN/FR/DE)
src/
  auth.py                Demo authentication + JWT issuance
  rag_pipeline.py         RAG orchestration (retrieval, fusion, LLM call, citation check)
  vector_store.py         ChromaDB wrapper
  embeddings.py           Embedding model loading (sentence-transformers / Ollama)
  kg_builder.py           Knowledge graph construction from YAML ontology
  pii.py                  PII detection and masking
  audit.py                Hashed query logging + retention purge
  ingest.py / indexer.py  Document upload, chunking, and indexing
data/                     Synthetic demo policies, glossary, contracts, ontology
templates/, static/       Frontend (Jinja2 + vanilla JS SPA)
copilot-agent/            Optional Microsoft Teams / Copilot Studio integration package
```

## Known Limitations

- Demo account passwords are compared using constant-time comparison but are **not hashed** — acceptable for this local demo, but a production deployment should replace demo auth with an enterprise identity provider (e.g. Azure AD) and hashed credentials.
- Knowledge graph visibility is not yet filtered by role (a known Phase 2 item).
- First LLM response after a cold start can take up to 90 seconds on CPU-only hardware.

## Security & Data Notes

This repository contains **only synthetic, fictional demo data** (a fictional company, fictional policies, and fictional people). It is safe for public review. No real credentials, API keys, or production data are included; see `.env.example` for required environment variables (values must be supplied locally and never committed).

## License

See [LICENSE](LICENSE).
