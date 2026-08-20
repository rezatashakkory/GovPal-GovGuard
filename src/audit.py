"""
src/audit.py – GDPR-compliant SQLite audit log.

Schema: audit_log(id, timestamp, session_id, query_hash, role,
                  response_type, n_sources, model, latency_ms, pii_detected)

- Queries are PII-masked, then stored as SHA-256 hashes — NEVER in plaintext.
- startup_purge() deletes entries older than LOG_RETENTION_DAYS (default 90).
- feedback(session_id, msg_id, type) persists thumbs up/down across restarts.
"""

import hashlib
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from src.pii import mask as _mask_pii

_DB_PATH        = os.getenv("AUDIT_DB_PATH", str(Path(__file__).parent.parent / "data" / "audit.db"))
_RETENTION_DAYS = int(os.getenv("LOG_RETENTION_DAYS", "90"))

_DDL = """
CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    query_hash    TEXT    NOT NULL,
    role          TEXT    NOT NULL,
    response_type TEXT    NOT NULL,
    n_sources     INTEGER DEFAULT 0,
    model         TEXT    DEFAULT '',
    latency_ms    INTEGER DEFAULT 0,
    pii_detected  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ts ON audit_log(timestamp);
CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    msg_id     TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    timestamp  TEXT    NOT NULL,
    UNIQUE(session_id, msg_id)
);
"""

_conn: Optional[sqlite3.Connection] = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        Path(_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
        _conn.executescript(_DDL)
        _conn.commit()
    return _conn


def startup_purge() -> int:
    """Delete audit rows older than the retention period. Returns count removed."""
    cutoff = (datetime.utcnow() - timedelta(days=_RETENTION_DAYS)).isoformat()
    conn   = _get_conn()
    cur    = conn.execute("DELETE FROM audit_log WHERE timestamp < ?", (cutoff,))
    conn.commit()
    return cur.rowcount


def log_query(
    session_id:    str,
    query:         str,
    role:          str,
    response_type: str,
    n_sources:     int  = 0,
    model:         str  = "",
    latency_ms:    int  = 0,
    pii_detected:  bool = False,
) -> None:
    """Append one audit row. The query is PII-masked, then hashed — raw query text
    (including any detected PII) is never written to disk."""
    query_hash = hashlib.sha256(_mask_pii(query).encode()).hexdigest()
    conn       = _get_conn()
    conn.execute(
        """INSERT INTO audit_log
               (timestamp, session_id, query_hash, role, response_type,
                n_sources, model, latency_ms, pii_detected)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.utcnow().isoformat(),
            session_id,
            query_hash,
            role,
            response_type,
            n_sources,
            model,
            latency_ms,
            int(pii_detected),
        ),
    )
    conn.commit()


def save_feedback(session_id: str, msg_id: str, fb_type: str) -> str:
    """Persist a thumbs up/down for one chat response, keyed on (session_id, msg_id).

    Mirrors the previous in-memory toggle behavior: submitting the same feedback type
    twice removes it; submitting a different type overwrites the previous one.
    Returns "removed" or "saved".
    """
    conn = _get_conn()
    row  = conn.execute(
        "SELECT type FROM feedback WHERE session_id = ? AND msg_id = ?",
        (session_id, msg_id),
    ).fetchone()

    if row is not None and row[0] == fb_type:
        conn.execute(
            "DELETE FROM feedback WHERE session_id = ? AND msg_id = ?",
            (session_id, msg_id),
        )
        conn.commit()
        return "removed"

    conn.execute(
        """INSERT INTO feedback (session_id, msg_id, type, timestamp)
               VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, msg_id) DO UPDATE SET
               type = excluded.type, timestamp = excluded.timestamp""",
        (session_id, msg_id, fb_type, datetime.utcnow().isoformat()),
    )
    conn.commit()
    return "saved"


def get_recent(n: int = 100) -> list[dict]:
    """Return the *n* most recent audit rows for the admin endpoint."""
    conn = _get_conn()
    cur  = conn.execute(
        """SELECT id, timestamp, session_id, query_hash, role, response_type,
                  n_sources, model, latency_ms, pii_detected
           FROM audit_log ORDER BY id DESC LIMIT ?""",
        (n,),
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_stats() -> dict:
    """Return aggregate statistics for the analytics dashboard."""
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    by_role: dict[str, int] = {}
    for row in conn.execute("SELECT role, COUNT(*) FROM audit_log GROUP BY role"):
        by_role[row[0]] = row[1]
    by_type: dict[str, int] = {}
    for row in conn.execute(
        "SELECT response_type, COUNT(*) FROM audit_log GROUP BY response_type"
    ):
        by_type[row[0]] = row[1]
    pii_count = conn.execute(
        "SELECT COUNT(*) FROM audit_log WHERE pii_detected = 1"
    ).fetchone()[0]
    return {
        "total_queries": total,
        "by_role":       by_role,
        "by_response":   by_type,
        "pii_detected":  pii_count,
    }
