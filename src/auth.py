"""
src/auth.py – JWT-based authentication for GovPal-GovGuard.

Demo users are defined with passwords configurable via environment variables.
Uses HMAC constant-time comparison to prevent timing attacks.
In production: replace with Azure AD / LDAP and bcrypt-hashed passwords
stored in a secure vault.

JWT signed with HS256. Secret must be overridden via JWT_SECRET env var
before any production deployment.
"""

import hmac
import os
from datetime import datetime, timedelta

_JWT_SECRET = os.getenv("JWT_SECRET", "govguard-dev-secret-CHANGE-IN-PRODUCTION")
_JWT_ALGO   = "HS256"
_JWT_EXPIRE = int(os.getenv("JWT_EXPIRE_MINUTES", "30"))

# ── Demo user store ────────────────────────────────────────────────────────────
# Passwords are loaded from env vars so they never appear in git history.
# Defaults are intentionally obvious demo values — not used in production.
_DEMO_USERS: dict[str, dict] = {
    "analyst@example.com": {
        "password": os.getenv("ANALYST_PW", "Analyst123!"),
        "role":     "Analyst",
        "name":     "Reza",
    },
    "manager@example.com": {
        "password": os.getenv("MANAGER_PW", "Manager123!"),
        "role":     "Manager",
        "name":     "Philippe",
    },
    "partner@example.com": {
        "password": os.getenv("PARTNER_PW", "Partner123!"),
        "role":     "Partner",
        "name":     "David",
    },
}

# ── Optional dependencies ──────────────────────────────────────────────────────
try:
    from jose import JWTError, jwt as _jwt
    _HAS_JOSE = True
except ImportError:
    _HAS_JOSE = False


class AuthError(Exception):
    """Raised on authentication or token validation failure."""


def _verify_password(plain: str, stored: str) -> bool:
    """Constant-time password comparison (prevents timing side-channel attacks)."""
    if not plain or not stored:
        return False
    return hmac.compare_digest(plain.encode("utf-8"), stored.encode("utf-8"))


def authenticate(email: str, password: str) -> dict:
    """Verify *email* / *password*. Returns user dict on success.

    Raises AuthError with a generic message on failure (no enumeration).
    """
    user = _DEMO_USERS.get(email.strip().lower())
    if not user or not _verify_password(password, user["password"]):
        raise AuthError("Invalid email or password.")
    return {
        "email": email.strip().lower(),
        "role":  user["role"],
        "name":  user["name"],
    }


def create_token(user: dict) -> str:
    """Create a signed JWT for *user*. Raises AuthError if jose not installed."""
    if not _HAS_JOSE:
        raise AuthError("python-jose not installed. Run: pip install python-jose[cryptography]")
    payload = {
        "sub":  user["email"],
        "role": user["role"],
        "name": user.get("name", ""),
        "exp":  datetime.utcnow() + timedelta(minutes=_JWT_EXPIRE),
    }
    return _jwt.encode(payload, _JWT_SECRET, algorithm=_JWT_ALGO)


def decode_token(token: str) -> dict:
    """Decode and validate *token*. Returns claims dict.

    Raises AuthError if the token is invalid, expired, or jose is missing.
    """
    if not _HAS_JOSE:
        raise AuthError("python-jose not installed.")
    try:
        payload = _jwt.decode(token, _JWT_SECRET, algorithms=[_JWT_ALGO])
        return payload
    except JWTError as exc:
        raise AuthError(f"Invalid or expired token: {exc}") from exc
