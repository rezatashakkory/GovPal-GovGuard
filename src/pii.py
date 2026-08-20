"""
src/pii.py – PII detection and masking for GDPR compliance.

Detects:
  EMAIL      – standard email addresses
  IBAN       – EU-format IBANs (LU, FR, GB, DE, BE, NL)
  PHONE_EU   – European phone numbers with country dialling code
  NAT_ID_LU  – Luxembourg 13-digit national register number
  PERS_NAME  – Two or three consecutive Title-Case words (heuristic)

Queries are masked before being hashed into the audit log.
Uploaded document text is scanned before indexing.
"""

import re
from dataclasses import dataclass


@dataclass
class PIIMatch:
    type:  str
    value: str
    start: int
    end:   int


_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("EMAIL",     re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}", re.I)),
    ("IBAN",      re.compile(r"\b(LU|FR|GB|DE|BE|NL|AT|ES|IT|PT|IE|FI|SE|DK|NO|CH)[0-9]{2}[A-Z0-9]{4,30}\b")),
    ("PHONE_EU",  re.compile(
        r"(?:\+352|\+33|\+44|\+49|\+32|\+31|\+43|\+34|\+39|00352|0033|0044)[\s\-.]?\d[\d\s\-\.]{6,14}\d"
    )),
    ("NAT_ID_LU", re.compile(r"\b\d{4}[012]\d[0-3]\d\d{5}\b")),   # 13-digit LU RNPP pattern
    ("PERS_NAME", re.compile(
        r"\b[A-Z][a-z]{2,15}\s+[A-Z][a-z]{2,15}(?:\s+[A-Z][a-z]{2,15})?\b"
    )),
]

_REPLACEMENTS: dict[str, str] = {
    "EMAIL":     "[EMAIL_REDACTED]",
    "IBAN":      "[IBAN_REDACTED]",
    "PHONE_EU":  "[PHONE_REDACTED]",
    "NAT_ID_LU": "[ID_REDACTED]",
    "PERS_NAME": "[NAME_REDACTED]",
}

# Common words that would be false-positive NAME matches (title-cased non-names)
_NAME_EXCLUSIONS: set[str] = {
    "Data Governance", "Data Quality", "Data Mesh", "Data Steward",
    "Access Control", "Risk Management", "Model Risk", "Chief Data",
    "Data Officer", "Data Protection", "Personal Data", "Golden Record",
    "Master Data", "Public Data", "Internal Data", "Finance Reporting",
    "Market Data", "General Ledger", "Human Resources",
}


def detect(text: str) -> list[PIIMatch]:
    """Return all PII matches found in *text*, sorted by start position."""
    matches: list[PIIMatch] = []
    for pii_type, pattern in _PATTERNS:
        for m in pattern.finditer(text):
            value = m.group()
            # Skip known false positives for name detection
            if pii_type == "PERS_NAME" and any(exc in value for exc in _NAME_EXCLUSIONS):
                continue
            matches.append(PIIMatch(type=pii_type, value=value, start=m.start(), end=m.end()))
    matches.sort(key=lambda x: x.start)
    return matches


def mask(text: str) -> str:
    """Replace all detected PII in *text* with generic placeholders."""
    matches = detect(text)
    if not matches:
        return text
    result = text
    # Process right-to-left to preserve character positions
    for m in reversed(matches):
        replacement = _REPLACEMENTS.get(m.type, "[REDACTED]")
        result = result[: m.start] + replacement + result[m.end :]
    return result


def has_pii(text: str) -> bool:
    """Return True if any PII pattern is found in *text*."""
    for pii_type, pattern in _PATTERNS:
        for m in pattern.finditer(text):
            value = m.group()
            if pii_type == "PERS_NAME" and any(exc in value for exc in _NAME_EXCLUSIONS):
                continue
            return True
    return False
