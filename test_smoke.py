"""
test_smoke.py - pytest smoke tests for GovPal-GovGuard.

Runs in-process against the FastAPI app via TestClient, so no live server
or Ollama instance is required. This makes the tests safe to run in CI
(GitHub Actions), where Ollama is not available.

Run locally or in CI with:
    pytest test_smoke.py -v
"""

import pytest
from fastapi.testclient import TestClient

from app import app

client = TestClient(app)

CASES = [
    ("analyst@example.com", "Analyst123!", "Reza", "Analyst"),
    ("manager@example.com", "Manager123!", "Philippe", "Manager"),
    ("partner@example.com", "Partner123!", "David", "Partner"),
]


def _login(email: str, password: str) -> dict:
    resp = client.post("/api/login", json={"email": email, "password": password})
    resp.raise_for_status()
    return resp.json()


@pytest.mark.parametrize("email,password,expected_name,expected_role", CASES)
def test_login_returns_expected_name_and_role(email, password, expected_name, expected_role):
    data = _login(email, password)
    assert data["name"] == expected_name
    assert data["role"] == expected_role
    assert data["access_token"]


def test_login_rejects_invalid_credentials():
    resp = client.post("/api/login", json={"email": "analyst@example.com", "password": "wrong"})
    assert resp.status_code == 401


def test_docs_role_filtering():
    tokens = {role: _login(email, pw)["access_token"] for email, pw, _, role in CASES}

    docs_a = client.get("/api/docs", headers={"Authorization": f"Bearer {tokens['Analyst']}"}).json()
    docs_p = client.get("/api/docs", headers={"Authorization": f"Bearer {tokens['Partner']}"}).json()

    assert docs_a["role"] == "Analyst"
    assert docs_p["role"] == "Partner"

    # A Partner must see at least as many documents as an Analyst, since
    # Partner-visible classification tiers are a superset of Analyst's.
    assert docs_p["total"] >= docs_a["total"]

    cls_a = {d["classification"] for d in docs_a["docs"]}
    cls_p = {d["classification"] for d in docs_p["docs"]}
    assert cls_a <= {"PUBLIC", "INTERNAL"}
    assert cls_a <= cls_p


def test_docs_requires_authentication():
    resp = client.get("/api/docs")
    assert resp.status_code == 401
