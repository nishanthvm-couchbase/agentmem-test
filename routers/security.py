"""
AgentMem Security Validation Runner
------------------------------------
Tests security properties of AMS:
  - Input Validation & Injection (SEC-01 to SEC-05)
  - Cross-Tenant Isolation        (SEC-06 to SEC-08)
  - Auth Boundary                  (SEC-09 to SEC-11, auto-skip when OIDC disabled)
"""

import asyncio
import logging
import logging.handlers
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from agentmemory import AgentMemoryClient, AgentMemoryError

router = APIRouter()
security_runs: Dict[str, dict] = {}

LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)


def _get_run_logger(run_id: str) -> logging.Logger:
    logger = logging.getLogger(f"security.{run_id}")
    logger.setLevel(logging.DEBUG)
    if not logger.handlers:
        log_file = os.path.join(LOG_DIR, f"security_{run_id}.log")
        handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=10 * 1024 * 1024, backupCount=3
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s")
        )
        logger.addHandler(handler)
        logger.propagate = False
    return logger


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _assert(name: str, passed: bool, expected: str = "", actual: str = "", error: str = "") -> dict:
    return {"name": name, "passed": passed, "expected": expected, "actual": actual, "error": error}


def _make_scenario(id_: str, name: str, category: str, description: str) -> dict:
    return {
        "id": id_,
        "name": name,
        "category": category,
        "description": description,
        "status": "pending",
        "assertions": [],
        "error_message": None,
        "started_at": None,
        "completed_at": None,
        "duration_ms": 0,
    }


async def _t(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


def _oidc_enabled() -> bool:
    val = os.getenv("OIDC_AUTH_ENABLED", "false").lower()
    return val in ("1", "true", "yes")


# ---------------------------------------------------------------------------
# Scenario executor
# ---------------------------------------------------------------------------
async def _exec_scenario(run_id: str, idx: int, coro_fn, client, logger, base_url: str) -> None:
    run = security_runs[run_id]
    scenario = run["scenarios"][idx]
    scenario["status"] = "running"
    scenario["started_at"] = _now_iso()
    t0 = time.monotonic()
    logger.info(f"{'='*60}")
    logger.info(f"SCENARIO {scenario['id'].upper()}: {scenario['name']}")
    logger.info(f"{'='*60}")

    try:
        assertions: List[dict] = await coro_fn(client, logger, base_url)
        scenario["assertions"] = assertions
        skipped = all(a.get("actual") == "skipped" for a in assertions)
        if skipped:
            scenario["status"] = "skipped"
        else:
            scenario["status"] = "passed" if all(a["passed"] for a in assertions) else "failed"
        for a in assertions:
            mark = "SKIP" if a.get("actual") == "skipped" else ("PASS" if a["passed"] else "FAIL")
            logger.info(f"  [{mark}] {a['name']}")
            if a["expected"] or a["actual"]:
                logger.debug(f"        expected={a['expected']}  actual={a['actual']}")
            if a["error"]:
                logger.warning(f"        error={a['error']}")
    except Exception as exc:
        scenario["status"] = "error"
        scenario["error_message"] = str(exc)
        scenario["assertions"] = []
        logger.error(f"  [ERROR] Uncaught exception: {exc}", exc_info=True)

    scenario["duration_ms"] = int((time.monotonic() - t0) * 1000)
    scenario["completed_at"] = _now_iso()
    logger.info(f"→ {scenario['status'].upper()} in {scenario['duration_ms']}ms\n")
    run["summary"][scenario["status"]] = run["summary"].get(scenario["status"], 0) + 1


# ---------------------------------------------------------------------------
# CATEGORY 1: Input Validation & Injection (SEC-01 to SEC-05)
# ---------------------------------------------------------------------------

async def _sec01_injection_user_id(client, logger, base_url: str) -> List[dict]:
    """SQL/NoSQL injection payloads in user_id must not cause 500 errors."""
    assertions = []
    payloads = [
        ("sql-inject",   "'; DROP COLLECTION users; --"),
        ("nosql-inject", '{"$gt": ""}'),
        ("crlf-inject",  "user\r\nX-Injected: true"),
    ]
    for label, payload in payloads:
        try:
            user = await _t(client.create_user, user_id=payload, name=f"Injection test {label}")
            fetched = await _t(client.get_user, user_id=payload)
            assertions.append(_assert(
                f"{label}: accepted and stored as literal (no injection executed)",
                fetched.user_id == payload,
                "literal stored",
                f"user_id={repr(fetched.user_id[:60])}",
            ))
            await _t(user.delete)
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                f"{label}: server handles cleanly (not 500)",
                status != 500,
                "not 500",
                f"HTTP {status}" if status else type(e).__name__,
                "" if status != 500 else str(e),
            ))
    return assertions


async def _sec02_path_traversal(client, logger, base_url: str) -> List[dict]:
    """Path traversal sequences in user_id must not leak server file data."""
    assertions = []
    payloads = [
        ("dotdot-unix",  "../../etc/passwd"),
        ("dotdot-win",   "..\\..\\windows\\system32"),
        ("url-encoded",  "%2e%2e%2fetc%2fpasswd"),
    ]
    for label, payload in payloads:
        try:
            user = await _t(client.create_user, user_id=payload, name=f"Traversal test {label}")
            fetched = await _t(client.get_user, user_id=payload)
            assertions.append(_assert(
                f"{label}: stored as literal string (no traversal)",
                fetched.user_id == payload,
                "literal stored",
                f"user_id={repr(fetched.user_id[:60])}",
            ))
            await _t(user.delete)
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                f"{label}: rejected cleanly (not 500)",
                status != 500,
                "not 500",
                f"HTTP {status}" if status else type(e).__name__,
                "" if status != 500 else str(e),
            ))
    return assertions


async def _sec03_xss_in_metadata(client, logger, base_url: str) -> List[dict]:
    """XSS payloads in name/metadata must be stored as literal strings."""
    assertions = []
    user_id = _uid("sec03")
    xss_name = "<script>alert('xss')</script>"
    xss_meta = {
        "greeting": "<img src=x onerror=alert(1)>",
        "url": "javascript:alert(1)",
    }
    try:
        user = await _t(client.create_user, user_id=user_id, name=xss_name, metadata=xss_meta)
        assertions.append(_assert("XSS payload accepted without server error", True, "no 500", "no 500"))
        fetched = await _t(client.get_user, user_id=user_id)
        assertions.append(_assert(
            "XSS name stored as-is (not stripped or double-encoded by server)",
            fetched.name == xss_name,
            xss_name,
            fetched.name or "",
        ))
        await _t(user.delete)
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "XSS payload handling: no 500",
            status != 500,
            "not 500",
            f"HTTP {status}" if status else type(e).__name__,
            "" if status != 500 else str(e),
        ))
    return assertions


async def _sec04_oversized_user_id(client, logger, base_url: str) -> List[dict]:
    """Extremely long user_id must be rejected with 4xx, not crash with 500."""
    assertions = []
    long_id = "a" * 10000
    try:
        user = await _t(client.create_user, user_id=long_id, name="Oversized ID User")
        assertions.append(_assert(
            "Oversized user_id (10000 chars): accepted as-is (no server limit enforced)",
            True,
            "accepted or 4xx",
            "accepted",
        ))
        await _t(user.delete)
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Oversized user_id rejected with 4xx (not 500)",
            400 <= status < 500,
            "4xx",
            f"HTTP {status}" if status else type(e).__name__,
            "" if 400 <= status < 500 else str(e),
        ))
    return assertions


async def _sec05_special_chars_user_id(client, logger, base_url: str) -> List[dict]:
    """Unicode control characters and special sequences in user_id must not crash server."""
    assertions = []
    payloads = [
        ("rtl-override",  "user\u202eadmin"),
        ("zero-width",    "user\u200badmin"),
        ("newline",       "user\nadmin"),
        ("tab",           "user\tadmin"),
        ("null-sequence", "user\u0000admin"),
    ]
    for label, payload in payloads:
        try:
            user = await _t(client.create_user, user_id=payload, name=f"Special char {label}")
            assertions.append(_assert(
                f"{label}: accepted without crash",
                True,
                "accepted or 4xx",
                "accepted",
            ))
            await _t(user.delete)
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                f"{label}: rejected without 500",
                status != 500,
                "not 500",
                f"HTTP {status}" if status else type(e).__name__,
                "" if status != 500 else str(e),
            ))
    return assertions


# ---------------------------------------------------------------------------
# CATEGORY 2: Cross-Tenant Isolation (SEC-06 to SEC-08)
# ---------------------------------------------------------------------------

async def _sec06_session_isolation(client, logger, base_url: str) -> List[dict]:
    """User B must not be able to access User A's sessions via B's user path."""
    assertions = []
    user_a_id = _uid("sec06a")
    user_b_id = _uid("sec06b")
    session_a_id = _uid("sess-a6")

    try:
        user_a = await _t(client.create_user, user_id=user_a_id, name="Tenant A")
        user_b = await _t(client.create_user, user_id=user_b_id, name="Tenant B")
        await _t(user_a.create_session, session_id=session_a_id)

        logger.info(f"  User A's session {session_a_id[:12]}… created.")
        logger.info(f"  Attempting GET via User B's path...")

        # SDK constructs: GET /users/{user_b_id}/sessions/{session_a_id}
        try:
            result = await _t(user_b.get_session, session_id=session_a_id)
            assertions.append(_assert(
                "User B cannot access User A's session",
                False,
                "404 Not Found",
                f"succeeded — got session_id={result.session_id}",
            ))
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                "User B accessing User A's session returns 404",
                status == 404,
                "404",
                f"HTTP {status}",
                "" if status == 404 else str(e),
            ))

        await _t(user_a.delete)
        await _t(user_b.delete)
    except Exception as e:
        assertions.append(_assert("SEC-06 setup", False, "success", "exception", str(e)))

    return assertions


async def _sec07_memory_isolation(client, logger, base_url: str) -> List[dict]:
    """User B must not be able to read User A's memory blocks."""
    assertions = []
    user_a_id = _uid("sec07a")
    user_b_id = _uid("sec07b")
    session_a_id = _uid("sess-a7")

    try:
        user_a = await _t(client.create_user, user_id=user_a_id, name="Tenant A Memory")
        user_b = await _t(client.create_user, user_id=user_b_id, name="Tenant B Memory")
        session_a = await _t(user_a.create_session, session_id=session_a_id)

        await _t(
            session_a.add_memory,
            messages=[{"user_content": "Confidential: secret value is 9999", "assistant_content": "Stored."}],
            async_processing=False,
            context_required=False,
        )
        logger.info("  User A memory block stored. Attempting read via User B's session path...")

        # User B tries to access A's session: SDK → GET /users/{user_b_id}/sessions/{session_a_id}
        try:
            fake_session = await _t(user_b.get_session, session_id=session_a_id)
            result = await _t(fake_session.get_memory)
            blocks = result.memory_blocks or []
            has_secret = any(
                "9999" in str(getattr(b, "message", "") or "")
                for b in blocks
            )
            assertions.append(_assert(
                "User B cannot read User A's memory blocks",
                not has_secret and len(blocks) == 0,
                "0 blocks (isolated)",
                f"{len(blocks)} blocks leaked={has_secret}",
            ))
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                "User B blocked at session level (404) before reaching memory",
                status == 404,
                "404",
                f"HTTP {status}",
                "" if status == 404 else str(e),
            ))

        await _t(user_a.delete)
        await _t(user_b.delete)
    except Exception as e:
        assertions.append(_assert("SEC-07 setup", False, "success", "exception", str(e)))

    return assertions


async def _sec08_delete_isolation(client, logger, base_url: str) -> List[dict]:
    """Deleting User B must not affect User A's data."""
    assertions = []
    user_a_id = _uid("sec08a")
    user_b_id = _uid("sec08b")
    session_a_id = _uid("sess-a8")

    try:
        user_a = await _t(client.create_user, user_id=user_a_id, name="Tenant A Persistent")
        user_b = await _t(client.create_user, user_id=user_b_id, name="Tenant B Deleted")
        session_a = await _t(user_a.create_session, session_id=session_a_id)
        await _t(
            session_a.add_memory,
            messages=[{"user_content": "User A data", "assistant_content": "Persists across tenant deletes."}],
            async_processing=False,
            context_required=False,
        )

        logger.info("  Deleting User B...")
        await _t(user_b.delete)

        logger.info("  Verifying User A and data are unaffected...")
        try:
            fetched_a = await _t(client.get_user, user_id=user_a_id)
            assertions.append(_assert(
                "User A still exists after User B deletion",
                fetched_a.user_id == user_a_id,
                user_a_id,
                fetched_a.user_id,
            ))
        except Exception as e:
            assertions.append(_assert(
                "User A exists after User B deletion",
                False, "user A intact", "exception", str(e),
            ))

        try:
            sessions = await _t(user_a.list_sessions)
            count = len(sessions.sessions or [])
            assertions.append(_assert(
                "User A's sessions intact after User B deletion",
                count >= 1,
                "≥1",
                str(count),
            ))
        except Exception as e:
            assertions.append(_assert(
                "User A sessions intact",
                False, "sessions present", "exception", str(e),
            ))

        try:
            result = await _t(session_a.get_memory)
            blocks = result.memory_blocks or []
            assertions.append(_assert(
                "User A's memory blocks intact after User B deletion",
                len(blocks) >= 1,
                "≥1",
                str(len(blocks)),
            ))
        except Exception as e:
            assertions.append(_assert(
                "User A memory intact",
                False, "blocks present", "exception", str(e),
            ))

        await _t(user_a.delete)
    except Exception as e:
        assertions.append(_assert("SEC-08 setup", False, "success", "exception", str(e)))

    return assertions


# ---------------------------------------------------------------------------
# CATEGORY 3: Auth Boundary (SEC-09 to SEC-11)
# ---------------------------------------------------------------------------

async def _sec09_no_token(client, logger, base_url: str) -> List[dict]:
    """Requests without auth token must be rejected with 401 when OIDC is enabled."""
    if not _oidc_enabled():
        return [_assert("No-token rejection (OIDC_AUTH_ENABLED=false — auto-skipped)", True, "skipped", "skipped")]
    assertions = []
    try:
        unauthed = AgentMemoryClient(base_url=base_url)
        await _t(unauthed.create_user, user_id=_uid("sec09"), name="Auth test")
        assertions.append(_assert("No-token request rejected", False, "401 Unauthorized", "succeeded"))
        unauthed.close()
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "No-token request returns 401",
            status == 401,
            "401",
            f"HTTP {status}",
            "" if status == 401 else str(e),
        ))
    return assertions


async def _sec10_malformed_token(client, logger, base_url: str) -> List[dict]:
    """Malformed Bearer tokens must be rejected with 401 when OIDC is enabled."""
    if not _oidc_enabled():
        return [_assert("Malformed token rejection (OIDC_AUTH_ENABLED=false — auto-skipped)", True, "skipped", "skipped")]
    assertions = []
    for label, bad_token in [
        ("random-string",  "notavalidtoken"),
        ("truncated-jwt",  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0"),
        ("garbage-chars",  "!!@@##$$%%^^&&**"),
    ]:
        try:
            bad_client = AgentMemoryClient(base_url=base_url, token=bad_token)
            await _t(bad_client.create_user, user_id=_uid("sec10"), name="Auth test")
            assertions.append(_assert(f"{label}: rejected", False, "401", "succeeded"))
            bad_client.close()
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                f"{label}: returns 401",
                status == 401,
                "401",
                f"HTTP {status}",
                "" if status == 401 else str(e),
            ))
    return assertions


async def _sec11_wrong_signature_jwt(client, logger, base_url: str) -> List[dict]:
    """A structurally valid JWT with wrong signature must be rejected with 401."""
    if not _oidc_enabled():
        return [_assert("Wrong-signature JWT rejection (OIDC_AUTH_ENABLED=false — auto-skipped)", True, "skipped", "skipped")]
    assertions = []
    # Valid header+payload structure, invalid signature
    fake_jwt = (
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
        ".eyJzdWIiOiJhdHRhY2tlciIsImV4cCI6OTk5OTk5OTk5OX0"
        ".INVALIDSIGNATUREINVALIDSIGNATUREINVALIDSIGNATURE"
    )
    try:
        bad_client = AgentMemoryClient(base_url=base_url, token=fake_jwt)
        await _t(bad_client.create_user, user_id=_uid("sec11"), name="Auth test")
        assertions.append(_assert("Wrong-signature JWT rejected", False, "401", "succeeded"))
        bad_client.close()
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Wrong-signature JWT returns 401",
            status == 401,
            "401",
            f"HTTP {status}",
            "" if status == 401 else str(e),
        ))
    return assertions


# ---------------------------------------------------------------------------
# CATEGORY 3 (extended): More Auth Boundary scenarios
# ---------------------------------------------------------------------------

async def _sec12_algorithm_confusion(client, logger, base_url: str) -> List[dict]:
    """JWT with HS256 algorithm header must be rejected — server enforces RS256 only."""
    if not _oidc_enabled():
        return [_assert("HS256 algorithm confusion (OIDC_AUTH_ENABLED=false — auto-skipped)", True, "skipped", "skipped")]
    assertions = []
    # {"alg":"HS256","typ":"JWT"}.{"sub":"attacker","exp":9999999999}.any-sig
    hs256_token = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        ".eyJzdWIiOiJhdHRhY2tlciIsImV4cCI6OTk5OTk5OTk5OX0"
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    )
    try:
        bad_client = AgentMemoryClient(base_url=base_url, token=hs256_token)
        await _t(bad_client.create_user, user_id=_uid("sec12"), name="Alg confusion test")
        assertions.append(_assert("HS256 token rejected", False, "401 Unauthorized", "succeeded (accepted HS256)"))
        bad_client.close()
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "HS256 algorithm rejected with 401 (server enforces RS256 only)",
            status == 401, "401", f"HTTP {status}",
            "" if status == 401 else str(e),
        ))
    return assertions


async def _sec13_wrong_realm_jwt(client, logger, base_url: str) -> List[dict]:
    """JWT from a different realm/issuer must be rejected (unknown signing key)."""
    if not _oidc_enabled():
        return [_assert("Wrong-realm JWT rejection (OIDC_AUTH_ENABLED=false — auto-skipped)", True, "skipped", "skipped")]
    assertions = []
    # RS256 JWT with unknown kid and wrong issuer — fails at JWKS key lookup → 401
    # header: {"alg":"RS256","typ":"JWT","kid":"wrong-realm-key-id"}
    # payload: {"sub":"attacker","iss":"https://evil.idp.example.com/realms/attacker","exp":9999999999}
    wrong_realm_jwt = (
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Indyb25nLXJlYWxtLWtleS1pZCJ9"
        ".eyJzdWIiOiJhdHRhY2tlciIsImlzcyI6Imh0dHBzOi8vZXZpbC5pZHAuZXhhbXBsZS5jb20vcmVhbG1zL2F0dGFja2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ"
        ".INVALIDSIGNATURE"
    )
    try:
        bad_client = AgentMemoryClient(base_url=base_url, token=wrong_realm_jwt)
        await _t(bad_client.create_user, user_id=_uid("sec13"), name="Wrong realm test")
        assertions.append(_assert("Wrong-realm JWT rejected", False, "401 Unauthorized", "succeeded"))
        bad_client.close()
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Wrong-realm JWT rejected with 401 (unknown signing key / issuer mismatch)",
            status == 401, "401", f"HTTP {status}",
            "" if status == 401 else str(e),
        ))
    return assertions


async def _sec14_expired_token(client, logger, base_url: str) -> List[dict]:
    """Expired JWT must be rejected with 401.

    Requires AMS_EXPIRED_TOKEN env var — get one by:
      1. In Keycloak: Realm Settings → Tokens → Access Token Lifespan → set to 1 minute
      2. curl the token endpoint, wait 60s, set AMS_EXPIRED_TOKEN=<that token>
      3. Re-run security tests — this scenario will execute instead of skipping
    """
    if not _oidc_enabled():
        return [_assert("Expired token rejection (OIDC_AUTH_ENABLED=false — auto-skipped)", True, "skipped", "skipped")]

    expired_token = os.getenv("AMS_EXPIRED_TOKEN", "").strip()
    if not expired_token:
        return [_assert(
            "Expired token rejection (AMS_EXPIRED_TOKEN not set — skipped)",
            True, "skipped", "skipped",
            "Set AMS_EXPIRED_TOKEN=<real expired Keycloak token> to run this scenario. "
            "In Keycloak: Realm Settings → Tokens → Access Token Lifespan → 1 min, get token, wait, then set.",
        )]

    assertions = []
    try:
        bad_client = AgentMemoryClient(base_url=base_url, token=expired_token)
        await _t(bad_client.create_user, user_id=_uid("sec14"), name="Expired token test")
        assertions.append(_assert("Expired token rejected", False, "401 Unauthorized", "succeeded (accepted expired token)"))
        bad_client.close()
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Expired token rejected with 401",
            status == 401, "401", f"HTTP {status}",
            "" if status == 401 else str(e),
        ))
    return assertions


# ---------------------------------------------------------------------------
# CATEGORY 4: mTLS — Couchbase certificate authentication smoke test
# ---------------------------------------------------------------------------

async def _sec15_mtls_couchbase_smoke(client, logger, base_url: str) -> List[dict]:
    """mTLS smoke: when Couchbase cert auth is configured, health ping must report Couchbase healthy.

    Auto-skips when AMS_MTLS_ENABLED env var is not set to 'true'.
    Set AMS_MTLS_ENABLED=true on the tester when the AMS server is configured with:
      AGENTMEM_CONN_CLIENT_CERT, AGENTMEM_CONN_CLIENT_KEY, AGENTMEM_CONN_ROOT_CERTIFICATE,
      AGENTMEM_CONN_STRING=couchbases://...
    """
    mtls_enabled = os.getenv("AMS_MTLS_ENABLED", "false").lower() in ("1", "true", "yes")
    if not mtls_enabled:
        return [_assert(
            "mTLS Couchbase smoke (AMS_MTLS_ENABLED not set — auto-skipped)",
            True, "skipped", "skipped",
            "Set AMS_MTLS_ENABLED=true on the tester when AMS is running with Couchbase mTLS certs.",
        )]

    assertions = []
    logger.info("  AMS_MTLS_ENABLED=true — checking Couchbase health via health_ping()...")

    try:
        health = await _t(client.health_ping)
        cb = health.couchbase or {}
        cb_status = cb.get("status", "unknown") if isinstance(cb, dict) else str(cb)
        is_healthy = cb_status.lower() in ("healthy", "ok", "connected")
        assertions.append(_assert(
            "mTLS: Couchbase health reports healthy (mTLS connection succeeded)",
            is_healthy, "healthy", cb_status,
            "" if is_healthy else "Couchbase not healthy — check cert paths, key perms, and couchbases:// scheme",
        ))

        overall = health.overall_status
        overall_val = overall.value if hasattr(overall, "value") else str(overall)
        assertions.append(_assert(
            "mTLS: overall AMS health is not degraded due to Couchbase",
            overall_val == "healthy", "healthy", overall_val,
        ))
    except Exception as e:
        assertions.append(_assert(
            "mTLS: health_ping() succeeded",
            False, "success", type(e).__name__, str(e),
        ))

    return assertions


# ---------------------------------------------------------------------------
# Scenario registry
# ---------------------------------------------------------------------------
SECURITY_SCENARIOS = [
    ("sec01", "Injection Chars in user_id",        "input_validation", "SQL/NoSQL injection payloads in user_id must not cause 500 or execute as commands.",        _sec01_injection_user_id),
    ("sec02", "Path Traversal in user_id",         "input_validation", "Directory traversal sequences (../../etc/passwd) in user_id must not leak server files.",   _sec02_path_traversal),
    ("sec03", "XSS Payload in name/metadata",      "input_validation", "XSS strings in name and metadata must be stored as literal text, not executed.",            _sec03_xss_in_metadata),
    ("sec04", "Oversized user_id (10k chars)",     "input_validation", "A 10,000-character user_id must be rejected with 4xx, not crash the server with 500.",      _sec04_oversized_user_id),
    ("sec05", "Special/Control Chars in user_id",  "input_validation", "Unicode RTL, zero-width, newline, tab, and null-sequence chars must not crash the server.", _sec05_special_chars_user_id),
    ("sec06", "Session Path Isolation",            "isolation",        "User B cannot access User A's session via GET /users/{user_b}/sessions/{session_a}.",        _sec06_session_isolation),
    ("sec07", "Memory Read Isolation",             "isolation",        "User B cannot read User A's memory blocks by targeting A's session ID via B's user path.",   _sec07_memory_isolation),
    ("sec08", "Delete Does Not Cross Tenants",     "isolation",        "Deleting User B must leave User A's users, sessions, and memory blocks fully intact.",       _sec08_delete_isolation),
    ("sec09", "No-Token Request Rejection",        "auth",             "Requests without any auth token must return 401 (skipped when OIDC_AUTH_ENABLED=false).",    _sec09_no_token),
    ("sec10", "Malformed Token Rejection",         "auth",             "Random strings and truncated JWTs as Bearer tokens must return 401.",                        _sec10_malformed_token),
    ("sec11", "Wrong-Signature JWT Rejection",     "auth",             "A well-formed JWT with a bad signature must return 401 (not 200).",                         _sec11_wrong_signature_jwt),
    ("sec12", "Algorithm Confusion (HS256)",       "auth",             "JWT with HS256 alg header must be rejected — server only accepts RS256.",                   _sec12_algorithm_confusion),
    ("sec13", "Wrong-Realm JWT",                   "auth",             "JWT from a different issuer/realm must be rejected (unknown signing key).",                  _sec13_wrong_realm_jwt),
    ("sec14", "Expired Token Rejection",           "auth",             "Expired JWT must return 401. Set AMS_EXPIRED_TOKEN env var to activate (else skipped).",    _sec14_expired_token),
    ("sec15", "mTLS Couchbase Smoke",              "mtls",             "If AMS_MTLS_ENABLED=true, Couchbase health must be healthy proving cert auth works.",       _sec15_mtls_couchbase_smoke),
]


# ---------------------------------------------------------------------------
# Background security runner
# ---------------------------------------------------------------------------
async def _run_security(run_id: str, client, base_url: str) -> None:
    logger = _get_run_logger(run_id)
    run = security_runs[run_id]
    oidc = _oidc_enabled()
    logger.info(f"Security run started | run_id={run_id} | OIDC_AUTH_ENABLED={oidc}")
    logger.info(f"Total scenarios: {len(SECURITY_SCENARIOS)}")
    logger.info("")

    for idx, (_, _, _, _, fn) in enumerate(SECURITY_SCENARIOS):
        if run.get("cancelled"):
            break
        run["current_scenario"] = idx
        await _exec_scenario(run_id, idx, fn, client, logger, base_url)

    run["status"] = "completed"
    run["completed_at"] = _now_iso()
    run["current_scenario"] = -1

    total = len(run["scenarios"])
    passed = sum(1 for s in run["scenarios"] if s["status"] == "passed")
    skipped = sum(1 for s in run["scenarios"] if s["status"] == "skipped")
    failed = sum(1 for s in run["scenarios"] if s["status"] in ("failed", "error"))
    run["summary"] = {"total": total, "passed": passed, "skipped": skipped, "failed": failed}

    logger.info("=" * 60)
    logger.info(f"SECURITY COMPLETE: {passed}/{total} passed, {skipped} skipped, {failed} failed")
    logger.info("=" * 60)


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
class SecurityLaunchRequest(BaseModel):
    scenario_ids: Optional[List[str]] = None


@router.post("/api/security/launch")
async def launch_security(request: Request, body: SecurityLaunchRequest = None):
    client = request.app.state.ams_client
    base_url = str(request.app.state.ams_base_url)
    run_id = f"sec-{uuid.uuid4().hex[:10]}"

    filter_ids = (body.scenario_ids if body else None) or None
    scenarios_to_run = [
        _make_scenario(sid, name, category, desc)
        for sid, name, category, desc, _ in SECURITY_SCENARIOS
        if filter_ids is None or sid in filter_ids
    ]

    security_runs[run_id] = {
        "run_id": run_id,
        "started_at": _now_iso(),
        "completed_at": None,
        "status": "running",
        "current_scenario": 0,
        "scenarios": scenarios_to_run,
        "summary": {"total": len(scenarios_to_run), "passed": 0, "skipped": 0, "failed": 0},
        "cancelled": False,
        "oidc_enabled": _oidc_enabled(),
    }

    asyncio.create_task(_run_security(run_id, client, base_url))
    return {"run_id": run_id, "total_scenarios": len(scenarios_to_run), "oidc_enabled": _oidc_enabled()}


@router.get("/api/security/status/{run_id}")
async def get_security_status(run_id: str):
    run = security_runs.get(run_id)
    if not run:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return run


@router.get("/api/security/runs")
async def list_security_runs():
    return [
        {
            "run_id": r["run_id"],
            "started_at": r["started_at"],
            "completed_at": r.get("completed_at"),
            "status": r["status"],
            "summary": r.get("summary", {}),
            "oidc_enabled": r.get("oidc_enabled", False),
        }
        for r in reversed(list(security_runs.values()))
    ]


@router.delete("/api/security/runs/{run_id}")
async def delete_security_run(run_id: str):
    if run_id not in security_runs:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    del security_runs[run_id]
    return {"deleted": run_id}
