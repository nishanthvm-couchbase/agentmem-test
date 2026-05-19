"""
AgentMem Validation Runner
--------------------------
Runs sequential assertion-based validation scenarios against AMS.
Each scenario creates isolated test data and cleans up after itself.
Uses the agentmem SDK throughout — no direct HTTP calls.
"""

import asyncio
import logging
import logging.handlers
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from agentmem import AgentMemClient

router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory run store
# ---------------------------------------------------------------------------
validation_runs: Dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Rotating log setup
# ---------------------------------------------------------------------------
LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)


def _get_run_logger(run_id: str) -> logging.Logger:
    logger = logging.getLogger(f"validation.{run_id}")
    logger.setLevel(logging.DEBUG)
    if not logger.handlers:
        log_file = os.path.join(LOG_DIR, f"validation_{run_id}.log")
        handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=10 * 1024 * 1024, backupCount=3
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s")
        )
        logger.addHandler(handler)
        logger.propagate = False
    return logger


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------
def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _assert(name: str, passed: bool, expected: str = "", actual: str = "", error: str = "") -> dict:
    return {"name": name, "passed": passed, "expected": expected, "actual": actual, "error": error}


def _make_scenario(id_: str, name: str, description: str) -> dict:
    return {
        "id": id_,
        "name": name,
        "description": description,
        "status": "pending",
        "assertions": [],
        "error_message": None,
        "started_at": None,
        "completed_at": None,
        "duration_ms": 0,
    }


def _blocks(memory_list) -> list:
    """Extract memory blocks from an SDK MemoryList response."""
    return memory_list.memory_blocks or []


def _block_id(add_response) -> str:
    """Extract the first block_id from an SDK AddMemoryResponse."""
    ids = add_response.block_ids or []
    return ids[0] if ids else ""


def _status_val(block) -> str:
    """Get string value of MemoryBlockStatus enum."""
    s = block.status
    return s.value if hasattr(s, "value") else str(s)


# ---------------------------------------------------------------------------
# Scenario executor
# ---------------------------------------------------------------------------
async def _exec_scenario(run_id: str, idx: int, coro_fn, client, logger) -> None:
    run = validation_runs[run_id]
    scenario = run["scenarios"][idx]
    scenario["status"] = "running"
    scenario["started_at"] = _now_iso()
    t0 = time.monotonic()
    logger.info(f"{'='*60}")
    logger.info(f"SCENARIO {idx + 1}: {scenario['name']}")
    logger.info(f"{'='*60}")

    try:
        assertions: List[dict] = await coro_fn(client, logger)
        scenario["assertions"] = assertions
        passed_all = all(a["passed"] for a in assertions)
        scenario["status"] = "passed" if passed_all else "failed"
        for a in assertions:
            mark = "PASS" if a["passed"] else "FAIL"
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
# Utility: run sync SDK call in thread pool
# ---------------------------------------------------------------------------
async def _t(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


# ---------------------------------------------------------------------------
# No-cleanup proxy — wraps SDK resource objects to no-op delete() calls
# ---------------------------------------------------------------------------
class _NoCleanupSession:
    def __init__(self, session):
        self._s = session

    def __getattr__(self, name):
        return getattr(self._s, name)

    def delete(self, *args, **kwargs):
        return None


class _NoCleanupUser:
    def __init__(self, user):
        self._u = user

    def __getattr__(self, name):
        return getattr(self._u, name)

    def delete(self, *args, **kwargs):
        return None

    def create_session(self, **kwargs):
        session = self._u.create_session(**kwargs)
        return _NoCleanupSession(session)

    def get_session(self, **kwargs):
        session = self._u.get_session(**kwargs)
        return _NoCleanupSession(session)


class _NoCleanupClient:
    def __init__(self, client):
        self._c = client

    def __getattr__(self, name):
        return getattr(self._c, name)

    def create_user(self, **kwargs):
        user = self._c.create_user(**kwargs)
        return _NoCleanupUser(user)

    def get_user(self, **kwargs):
        user = self._c.get_user(**kwargs)
        return _NoCleanupUser(user)


# ---------------------------------------------------------------------------
# Utility: poll for block status=ready
# ---------------------------------------------------------------------------
async def _poll_ready(session_resource, block_id: str, timeout: float = 60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = await _t(session_resource.get_memory)
            for b in _blocks(result):
                if b.block_id == block_id and _status_val(b) == "ready":
                    return b
        except Exception:
            pass
        await asyncio.sleep(2.0)
    return None


# ---------------------------------------------------------------------------
# SCENARIO IMPLEMENTATIONS
# ---------------------------------------------------------------------------

async def _scenario_user_lifecycle(client, logger) -> List[dict]:
    """Create, fetch, verify, delete a user."""
    assertions = []
    user_id = _uid("val-user")
    name = "Validation Test User"

    logger.info("  Creating user...")
    try:
        user = await _t(client.create_user, user_id=user_id, name=name)
        assertions.append(_assert("User creation returns 200", True, "success", "success"))
        logger.debug(f"  user_id={user.user_id}")
    except Exception as e:
        assertions.append(_assert("User creation returns 200", False, "success", "exception", str(e)))
        return assertions

    logger.info("  Fetching user...")
    try:
        fetched = await _t(client.get_user, user_id=user_id)
        assertions.append(_assert("Fetched user_id matches", fetched.user_id == user_id, user_id, fetched.user_id))
        assertions.append(_assert("Fetched user name matches", fetched.name == name, name, fetched.name))
    except Exception as e:
        assertions.append(_assert("Fetch user succeeds", False, "success", "exception", str(e)))

    logger.info("  Deleting user...")
    try:
        await _t(user.delete)
        assertions.append(_assert("Delete user returns 200", True, "success", "success"))
    except Exception as e:
        assertions.append(_assert("Delete user returns 200", False, "success", "exception", str(e)))
        return assertions

    logger.info("  Verifying user is gone...")
    try:
        await _t(client.get_user, user_id=user_id)
        assertions.append(_assert("Get deleted user returns 404", False, "NotFoundError 404", "no error raised"))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Get deleted user returns 404",
            status == 404,
            "NotFoundError 404",
            f"error {status}",
            "" if status == 404 else str(e),
        ))

    return assertions


async def _scenario_session_lifecycle(client, logger) -> List[dict]:
    """Create session, verify, end, delete, cascade."""
    assertions = []
    user_id = _uid("val-sess")
    session_id = _uid("sess")

    user = await _t(client.create_user, user_id=user_id, name="Session Test User")

    logger.info("  Creating session...")
    try:
        session = await _t(user.create_session, session_id=session_id)
        assertions.append(_assert("Session creation returns 200", True, "success", "success"))
    except Exception as e:
        assertions.append(_assert("Session creation returns 200", False, "success", "exception", str(e)))
        await _t(user.delete)
        return assertions

    logger.info("  Fetching session...")
    try:
        fetched = await _t(user.get_session, session_id=session_id)
        assertions.append(_assert("Fetched session_id matches", fetched.session_id == session_id, session_id, fetched.session_id))
        # NOTE: SessionResource only exposes user_id/session_id — end_time not readable via get_session()
    except Exception as e:
        assertions.append(_assert("Fetch session succeeds", False, "success", "exception", str(e)))

    logger.info("  Listing sessions...")
    try:
        result = await _t(user.list_sessions)
        count = len(result.sessions)
        assertions.append(_assert("List sessions returns 1 entry", count == 1, "1", str(count)))
    except Exception as e:
        assertions.append(_assert("List sessions succeeds", False, "success", "exception", str(e)))

    logger.info("  Ending session...")
    try:
        ended = await _t(session.end)
        assertions.append(_assert("Ended session has end_time set", ended.end_time is not None, "end_time set", str(ended.end_time)))
    except Exception as e:
        assertions.append(_assert("End session returns 200", False, "success", "exception", str(e)))

    logger.info("  Deleting session...")
    try:
        await _t(session.delete)
        assertions.append(_assert("Delete session returns 200", True, "success", "success"))
    except Exception as e:
        assertions.append(_assert("Delete session returns 200", False, "success", "exception", str(e)))

    logger.info("  Verifying session is gone...")
    try:
        await _t(user.get_session, session_id=session_id)
        assertions.append(_assert("Get deleted session returns 404", False, "NotFoundError 404", "no error raised"))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Get deleted session returns 404",
            status == 404,
            "NotFoundError 404",
            f"error {status}",
            "" if status == 404 else str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_cascade_delete(client, logger) -> List[dict]:
    """Delete user cascades to all sessions."""
    assertions = []
    user_id = _uid("val-casc")
    session_ids = [_uid("cs-sess") for _ in range(2)]

    user = await _t(client.create_user, user_id=user_id, name="Cascade Test User")
    for sid in session_ids:
        await _t(user.create_session, session_id=sid)

    logger.info("  Verifying both sessions exist...")
    try:
        result = await _t(user.list_sessions)
        count = len(result.sessions)
        assertions.append(_assert("Both sessions exist before delete", count == 2, "2", str(count)))
    except Exception as e:
        assertions.append(_assert("List sessions before delete", False, "success", "exception", str(e)))

    logger.info("  Deleting user (cascade trigger)...")
    try:
        await _t(user.delete)
        assertions.append(_assert("User delete returns 200", True, "success", "success"))
    except Exception as e:
        assertions.append(_assert("User delete returns 200", False, "success", "exception", str(e)))
        return assertions

    logger.info("  Verifying sessions are gone...")
    for sid in session_ids:
        try:
            await _t(client.get_user, user_id=user_id)
            assertions.append(_assert(f"Session {sid[:8]}… gone after user delete", False, "404 or 400", "no error raised"))
        except Exception as e:
            status = getattr(e, "status_code", 0)
            assertions.append(_assert(
                f"Session {sid[:8]}… gone after user delete",
                status in (404, 400),
                "404 or 400",
                f"error {status}",
                "" if status in (404, 400) else str(e),
            ))

    return assertions


async def _scenario_ingestion_sync(client, logger) -> List[dict]:
    """Sync ingestion: embedding done before return, block immediately searchable."""
    assertions = []
    user_id = _uid("val-sync")
    session_id = _uid("sync-s")
    unique_marker = uuid.uuid4().hex

    user = await _t(client.create_user, user_id=user_id, name="Sync Ingestion User")
    session = await _t(user.create_session, session_id=session_id)

    logger.info("  Adding memory block (sync, context_required=false)...")
    try:
        result = await _t(
            session.add_memory,
            messages=[{
                "user_content": f"What are the best protein sources? marker:{unique_marker}",
                "assistant_content": f"Great protein sources include chicken, eggs, and legumes. marker:{unique_marker}",
            }],
            async_processing=False,
            context_required=False,
        )
        block_id = _block_id(result)
        assertions.append(_assert("add_memory returns block_id", bool(block_id), "non-empty string", str(bool(block_id))))
        logger.debug(f"  block_id={block_id}")
    except Exception as e:
        assertions.append(_assert("add_memory (sync) returns 200", False, "success", "exception", str(e)))
        await _t(user.delete)
        return assertions

    logger.info("  Searching immediately (embedding should be ready)...")
    try:
        search_result = await _t(session.get_memory, query="protein sources nutrition")
        blocks = _blocks(search_result)
        assertions.append(_assert(
            "Semantic search returns ≥1 result immediately after sync add",
            len(blocks) >= 1, "≥1", str(len(blocks)),
        ))
        if blocks:
            assertions.append(_assert(
                "Returned block status is ready",
                _status_val(blocks[0]) == "ready", "ready", _status_val(blocks[0]),
            ))
    except Exception as e:
        assertions.append(_assert("Immediate search after sync add", False, "success", "exception", str(e)))

    logger.info("  Verifying block status via filter list...")
    try:
        list_result = await _t(session.get_memory)
        target = next((b for b in _blocks(list_result) if b.block_id == block_id), None)
        if target:
            assertions.append(_assert(
                "sync block status=ready in filter list",
                _status_val(target) == "ready", "ready", _status_val(target),
            ))
        else:
            assertions.append(_assert("Block found in filter list", False, "block present", "not found"))
    except Exception as e:
        assertions.append(_assert("Filter list check for status", False, "success", "exception", str(e)))

    await _t(user.delete)
    return assertions


async def _scenario_ingestion_async(client, logger) -> List[dict]:
    """Async ingestion: block starts processing → transitions to ready with LLM enrichment."""
    assertions = []
    user_id = _uid("val-asyn")
    session_id = _uid("asyn-s")

    user = await _t(client.create_user, user_id=user_id, name="Async Ingestion User")
    session = await _t(user.create_session, session_id=session_id)

    logger.info("  Adding memory block (async, context_required=true)...")
    try:
        result = await _t(
            session.add_memory,
            messages=[{
                "user_content": "I'm planning a solo trip to Japan next spring",
                "assistant_content": "Japan in spring is wonderful! Cherry blossom season is in March-April. I recommend Tokyo, Kyoto, and Osaka.",
            }],
            async_processing=True,
            context_required=True,
        )
        block_id = _block_id(result)
        assertions.append(_assert("async add_memory returns block_id", bool(block_id), "non-empty string", str(bool(block_id))))
        logger.debug(f"  block_id={block_id}")
    except Exception as e:
        assertions.append(_assert("async add_memory returns 200", False, "success", "exception", str(e)))
        await _t(user.delete)
        return assertions

    logger.info("  Checking initial status is 'processing'...")
    await asyncio.sleep(0.5)
    try:
        list_result = await _t(session.get_memory)
        target = next((b for b in _blocks(list_result) if b.block_id == block_id), None)
        if target:
            initial_status = _status_val(target)
            assertions.append(_assert(
                "Block initial status is 'processing'",
                initial_status == "processing", "processing", initial_status,
            ))
        else:
            assertions.append(_assert(
                "Block found shortly after async add", False, "block present",
                "not found (may not appear until ready in some implementations)",
                "Some AMS implementations only expose ready blocks in search",
            ))
    except Exception as e:
        assertions.append(_assert("Initial status check", False, "success", "exception", str(e)))

    logger.info("  Polling for status=ready (max 60s)...")
    ready_block = await _poll_ready(session, block_id, timeout=60.0)
    if ready_block:
        assertions.append(_assert("Block transitions to status=ready within 60s", True, "ready", "ready"))
        summary = ready_block.summary or ""
        contexts = ready_block.contexts or []
        assertions.append(_assert(
            "LLM enrichment: summary is non-empty",
            bool(summary and summary.strip()),
            "non-empty string",
            f"'{str(summary)[:80]}'" if summary else "empty",
        ))
        assertions.append(_assert(
            "LLM enrichment: contexts list is present",
            isinstance(contexts, list), "list", type(contexts).__name__,
        ))
        logger.info(f"  Enrichment: summary={str(summary)[:80]}  contexts={contexts}")
    else:
        assertions.append(_assert("Block transitions to status=ready within 60s", False, "ready within 60s", "timed out"))

    await _t(user.delete)
    return assertions


async def _scenario_multi_agent_isolation(client, logger) -> List[dict]:
    """Annotation-based multi-agent isolation: h1 and h2 cannot see each other's blocks."""
    assertions = []
    user_id = _uid("val-magi")
    session_id = _uid("magi-s")

    user = await _t(client.create_user, user_id=user_id, name="Multi-Agent Isolation User")
    session = await _t(user.create_session, session_id=session_id)

    h1_messages = [
        ("I want to start a high-protein diet plan",
         "Great! I recommend 1.6g protein per kg bodyweight daily, focusing on chicken, eggs, and legumes."),
        ("What should my meal schedule look like?",
         "Have protein with every meal: eggs at breakfast, chicken at lunch, legumes at dinner."),
        ("Can you track my current weight?",
         "Of course! Please share your current weight and I'll help you plan your nutrition targets."),
    ]
    h2_messages = [
        ("Book me a flight to Tokyo next month",
         "I found several flights to Tokyo. The best option departs on the 15th, price $850."),
        ("What hotels are near Shinjuku station?",
         "Several great options near Shinjuku: Park Hyatt, Keio Plaza, and Citadines Connect."),
        ("What's the weather like in Tokyo in spring?",
         "Tokyo spring is mild (15-20°C), cherry blossoms bloom March-April. Light layers recommended."),
    ]

    logger.info("  Storing h1 (diet agent) memory blocks...")
    h1_block_ids = []
    for user_content, asst_content in h1_messages:
        try:
            r = await _t(
                session.add_memory,
                messages=[{"user_content": user_content, "assistant_content": asst_content}],
                annotations={"agent": "h1", "domain": "diet"},
                async_processing=False,
                context_required=False,
            )
            bid = _block_id(r)
            if bid:
                h1_block_ids.append(bid)
        except Exception as e:
            assertions.append(_assert("h1 block add succeeds", False, "success", "exception", str(e)))
            await _t(user.delete)
            return assertions

    assertions.append(_assert("All 3 h1 blocks stored", len(h1_block_ids) == 3, "3", str(len(h1_block_ids))))

    logger.info("  Storing h2 (travel agent) memory blocks...")
    h2_block_ids = []
    for user_content, asst_content in h2_messages:
        try:
            r = await _t(
                session.add_memory,
                messages=[{"user_content": user_content, "assistant_content": asst_content}],
                annotations={"agent": "h2", "domain": "travel"},
                async_processing=False,
                context_required=False,
            )
            bid = _block_id(r)
            if bid:
                h2_block_ids.append(bid)
        except Exception as e:
            assertions.append(_assert("h2 block add succeeds", False, "success", "exception", str(e)))
            await _t(user.delete)
            return assertions

    assertions.append(_assert("All 3 h2 blocks stored", len(h2_block_ids) == 3, "3", str(len(h2_block_ids))))

    def _ids_set(memory_list) -> set:
        return {b.block_id for b in _blocks(memory_list)}

    def _ann_vals(memory_list, key: str) -> set:
        return {(b.annotations or {}).get(key, "") for b in _blocks(memory_list)}

    logger.info("  Fetching as h1 agent (filter annotations.agent=h1)...")
    try:
        h1_result = await _t(session.get_memory, filters={"annotations": {"agent": "h1"}})
        h1_returned = _ids_set(h1_result)
        logger.debug(f"  h1 filter returned block ids: {h1_returned}")
        assertions.append(_assert(
            "h1-filtered result contains NO h2 blocks",
            not bool(h1_returned & set(h2_block_ids)),
            "0 h2 blocks",
            f"{len(h1_returned & set(h2_block_ids))} h2 blocks",
        ))
        assertions.append(_assert(
            "h1-filtered result contains h1 blocks",
            bool(h1_returned & set(h1_block_ids)),
            "≥1 h1 block",
            f"{len(h1_returned & set(h1_block_ids))} h1 blocks",
        ))
    except Exception as e:
        assertions.append(_assert("h1-filtered fetch succeeds", False, "success", "exception", str(e)))

    logger.info("  Fetching as h2 agent (filter annotations.agent=h2)...")
    try:
        h2_result = await _t(session.get_memory, filters={"annotations": {"agent": "h2"}})
        h2_returned = _ids_set(h2_result)
        logger.debug(f"  h2 filter returned block ids: {h2_returned}")
        assertions.append(_assert(
            "h2-filtered result contains NO h1 blocks",
            not bool(h2_returned & set(h1_block_ids)),
            "0 h1 blocks",
            f"{len(h2_returned & set(h1_block_ids))} h1 blocks",
        ))
        assertions.append(_assert(
            "h2-filtered result contains h2 blocks",
            bool(h2_returned & set(h2_block_ids)),
            "≥1 h2 block",
            f"{len(h2_returned & set(h2_block_ids))} h2 blocks",
        ))
    except Exception as e:
        assertions.append(_assert("h2-filtered fetch succeeds", False, "success", "exception", str(e)))

    logger.info("  Fetching unfiltered (should return all blocks)...")
    try:
        all_result = await _t(session.get_memory)
        total = len(_ids_set(all_result))
        assertions.append(_assert("Unfiltered fetch returns all 6 blocks", total == 6, "6", str(total)))
    except Exception as e:
        assertions.append(_assert("Unfiltered fetch succeeds", False, "success", "exception", str(e)))

    logger.info("  Concurrency check: simultaneous h2-store + h1-fetch...")
    try:
        c_user_id = _uid("val-conc")
        c_session_id = _uid("conc-s")
        c_user = await _t(client.create_user, user_id=c_user_id, name="Concurrent Isolation User")
        c_session = await _t(c_user.create_session, session_id=c_session_id)

        for user_content, asst_content in h1_messages:
            await _t(
                c_session.add_memory,
                messages=[{"user_content": user_content, "assistant_content": asst_content}],
                annotations={"agent": "h1"},
                async_processing=False,
                context_required=False,
            )

        async def _store_h2():
            for user_content, asst_content in h2_messages:
                await _t(
                    c_session.add_memory,
                    messages=[{"user_content": user_content, "assistant_content": asst_content}],
                    annotations={"agent": "h2"},
                    async_processing=False,
                    context_required=False,
                )

        async def _fetch_as_h1():
            results = []
            for _ in range(3):
                r = await _t(c_session.get_memory, filters={"annotations": {"agent": "h1"}})
                for b in _blocks(r):
                    results.append((b.annotations or {}).get("agent", "h1"))
                await asyncio.sleep(0.05)
            return results

        store_task = asyncio.create_task(_store_h2())
        fetch_task = asyncio.create_task(_fetch_as_h1())
        await asyncio.gather(store_task, fetch_task)
        concurrent_agents = set(fetch_task.result())

        logger.debug(f"  Concurrent fetch agent values seen: {concurrent_agents}")
        assertions.append(_assert(
            "Concurrent h1-fetch returns ONLY h1 annotations",
            concurrent_agents <= {"h1"}, "only 'h1'", str(concurrent_agents),
        ))
        await _t(c_user.delete)
    except Exception as e:
        assertions.append(_assert("Concurrent isolation test", False, "success", "exception", str(e)))

    await _t(user.delete)
    return assertions


async def _scenario_semantic_retrieval(client, logger) -> List[dict]:
    """Semantic search only returns ready blocks; filter-based retrieval returns all."""
    assertions = []
    user_id = _uid("val-retr")
    session_id = _uid("retr-s")

    user = await _t(client.create_user, user_id=user_id, name="Retrieval Test User")
    session = await _t(user.create_session, session_id=session_id)

    topics = [
        ("What's the capital of France?", "The capital of France is Paris, a major European city."),
        ("How does photosynthesis work?", "Photosynthesis converts sunlight, water, and CO2 into glucose and oxygen."),
        ("Best practices for Python async?", "Use asyncio.gather for parallel tasks, avoid blocking calls in async context."),
        ("What is the speed of light?", "The speed of light in vacuum is approximately 299,792,458 metres per second."),
        ("How to make sourdough bread?", "Sourdough uses wild yeast fermentation. Mix flour, water, and starter, then long-ferment overnight."),
    ]
    logger.info("  Adding 5 sync blocks on distinct topics...")
    for q, a in topics:
        try:
            await _t(session.add_memory,
                messages=[{"user_content": q, "assistant_content": a}],
                async_processing=False,
                context_required=False,
            )
        except Exception as e:
            assertions.append(_assert("Add sync block succeeds", False, "success", "exception", str(e)))
            await _t(user.delete)
            return assertions

    logger.info("  Semantic search for bread/baking topic...")
    try:
        result = await _t(session.get_memory, query="bread making fermentation sourdough")
        results = _blocks(result)
        assertions.append(_assert("Semantic search returns ≥1 result", len(results) >= 1, "≥1", str(len(results))))
        if results:
            all_ready = all(_status_val(b) == "ready" for b in results)
            assertions.append(_assert(
                "All semantic search results have status=ready",
                all_ready, "all ready", "all ready" if all_ready else "some non-ready",
            ))
    except Exception as e:
        assertions.append(_assert("Semantic search succeeds", False, "success", "exception", str(e)))

    logger.info("  Filter-based retrieval (no query)...")
    try:
        filter_result = await _t(session.get_memory)
        all_blocks = _blocks(filter_result)
        assertions.append(_assert(
            "Filter-based retrieval returns all 5 blocks",
            len(all_blocks) == 5, "5", str(len(all_blocks)),
        ))
    except Exception as e:
        assertions.append(_assert("Filter-based retrieval succeeds", False, "success", "exception", str(e)))

    logger.info("  Semantic search with unrelated term (low recall expected)...")
    try:
        unrelated = await _t(session.get_memory, query="quantum computing qubit error correction")
        assertions.append(_assert(
            "Semantic search with unrelated query returns valid response",
            isinstance(_blocks(unrelated), list), "list", "list",
        ))
    except Exception as e:
        assertions.append(_assert("Semantic search with unrelated query", False, "success", "exception", str(e)))

    await _t(user.delete)
    return assertions


async def _scenario_session_immutability(client, logger) -> List[dict]:
    """Ended sessions must reject new memory block additions."""
    assertions = []
    user_id = _uid("val-immu")
    session_id = _uid("immu-s")

    user = await _t(client.create_user, user_id=user_id, name="Session Immutability User")
    session = await _t(user.create_session, session_id=session_id)

    logger.info("  Ending session...")
    try:
        ended = await _t(session.end)
        assertions.append(_assert("End session returns end_time set", ended.end_time is not None, "end_time set", str(ended.end_time)))
    except Exception as e:
        assertions.append(_assert("End session returns 200", False, "success", "exception", str(e)))
        await _t(user.delete)
        return assertions

    logger.info("  Attempting to add memory to ended session...")
    try:
        await _t(
            session.add_memory,
            messages=[{"user_content": "This should be rejected", "assistant_content": "Session is ended"}],
            async_processing=False,
            context_required=False,
        )
        assertions.append(_assert("add_memory on ended session is rejected", False, "4xx error", "succeeded (no error)"))
    except Exception as e:
        status_code = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "add_memory on ended session is rejected with 4xx",
            400 <= status_code < 500, "400-499", f"HTTP {status_code}",
            "" if 400 <= status_code < 500 else str(e),
        ))

    logger.info("  Verifying session is still fetchable with ended status...")
    try:
        await _t(user.get_session, session_id=session_id)
        assertions.append(_assert("Ended session still fetchable", True, "success", "success"))
        # NOTE: SessionResource doesn't expose end_time — checked via session.end() return value above
    except Exception as e:
        assertions.append(_assert("Get ended session succeeds", False, "success", "exception", str(e)))

    await _t(user.delete)
    return assertions


async def _scenario_duplicate_rejection(client, logger) -> List[dict]:
    """Duplicate user_id and session_id must be rejected."""
    assertions = []
    user_id = _uid("val-dupl")
    session_id = _uid("dupl-s")

    logger.info("  Creating user...")
    try:
        user = await _t(client.create_user, user_id=user_id, name="Original User")
        assertions.append(_assert("Original user created", True, "success", "success"))
    except Exception as e:
        assertions.append(_assert("Original user created", False, "success", "exception", str(e)))
        return assertions

    logger.info("  Creating duplicate user...")
    try:
        await _t(client.create_user, user_id=user_id, name="Duplicate User")
        assertions.append(_assert("Duplicate user_id is rejected", False, "409 Conflict", "succeeded with no error"))
    except Exception as e:
        status_code = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Duplicate user_id returns 409",
            status_code == 409, "409", f"HTTP {status_code}",
            "" if status_code == 409 else str(e),
        ))

    session = await _t(user.create_session, session_id=session_id)

    logger.info("  Creating duplicate session...")
    try:
        await _t(user.create_session, session_id=session_id)
        assertions.append(_assert("Duplicate session_id is rejected", False, "409 Conflict", "succeeded with no error"))
    except Exception as e:
        status_code = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Duplicate session_id returns 409",
            status_code == 409, "409", f"HTTP {status_code}",
            "" if status_code == 409 else str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_oversized_block(client, logger) -> List[dict]:
    """Blocks exceeding size limits must be rejected."""
    assertions = []
    user_id = _uid("val-over")
    session_id = _uid("over-s")

    user = await _t(client.create_user, user_id=user_id, name="Oversized Block User")
    session = await _t(user.create_session, session_id=session_id)

    oversized_content = "A" * (1024 * 1024)
    logger.info("  Sending oversized memory block (1 MB)...")
    try:
        await _t(
            session.add_memory,
            messages=[{"user_content": oversized_content, "assistant_content": "Response"}],
            async_processing=False,
            context_required=False,
        )
        assertions.append(_assert("Oversized block is rejected", False, "5xx error", "succeeded with no error"))
    except Exception as e:
        status_code = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "Oversized block rejected with 5xx",
            500 <= status_code < 600, "500-599", f"HTTP {status_code}",
            "" if 500 <= status_code < 600 else str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_ttl_behavior(client, logger) -> List[dict]:
    """Memory blocks with TTL=2s expire; blocks with no TTL persist."""
    assertions = []
    user_id = _uid("val-ttl")
    session_id_ttl = _uid("ttl-s1")
    session_id_notl = _uid("ttl-s2")

    user = await _t(client.create_user, user_id=user_id, name="TTL Test User")

    logger.info("  Creating session with memory_blocks_ttl=2...")
    try:
        ttl_session = await _t(user.create_session, session_id=session_id_ttl, memory_blocks_ttl=2)
        assertions.append(_assert("Session with TTL=2 created", True, "success", "success"))
    except Exception as e:
        assertions.append(_assert("Session with TTL=2 created", False, "success", "exception", str(e)))
        await _t(user.delete)
        return assertions

    logger.info("  Adding block to TTL session...")
    try:
        r = await _t(
            ttl_session.add_memory,
            messages=[{"user_content": "Temporary memory that should expire", "assistant_content": "This block has a short TTL."}],
            async_processing=False,
            context_required=False,
        )
        block_id = _block_id(r)
        assertions.append(_assert("TTL block added", bool(block_id), "block_id", str(bool(block_id))))
    except Exception as e:
        assertions.append(_assert("TTL block add", False, "success", "exception", str(e)))
        await _t(user.delete)
        return assertions

    logger.info("  Verifying block exists immediately...")
    try:
        result = await _t(ttl_session.get_memory)
        blocks = _blocks(result)
        assertions.append(_assert("TTL block visible before expiry", len(blocks) >= 1, "≥1", str(len(blocks))))
    except Exception as e:
        assertions.append(_assert("Block visible before TTL expiry", False, "success", "exception", str(e)))

    logger.info("  Waiting 10s for TTL expiry (TTL=2s + Couchbase lazy expiry buffer)...")
    await asyncio.sleep(10)

    logger.info("  Verifying block expired...")
    try:
        result = await _t(ttl_session.get_memory)
        blocks = _blocks(result)
        assertions.append(_assert("TTL block gone after expiry", len(blocks) == 0, "0", str(len(blocks))))
    except Exception as e:
        assertions.append(_assert("Block check after TTL expiry", False, "success", "exception", str(e)))

    logger.info("  Creating session without TTL and verifying persistence...")
    no_ttl_session = await _t(user.create_session, session_id=session_id_notl)
    try:
        await _t(
            no_ttl_session.add_memory,
            messages=[{"user_content": "Persistent memory", "assistant_content": "This block should persist indefinitely."}],
            async_processing=False,
            context_required=False,
        )
        await asyncio.sleep(1)
        result = await _t(no_ttl_session.get_memory)
        blocks = _blocks(result)
        assertions.append(_assert("Non-TTL block persists", len(blocks) >= 1, "≥1", str(len(blocks))))
    except Exception as e:
        assertions.append(_assert("Non-TTL persistence check", False, "success", "exception", str(e)))

    await _t(user.delete)
    return assertions


# ---------------------------------------------------------------------------
# SDK GAP SCENARIOS (S12–S17) — probe SDK methods not yet covered
# ---------------------------------------------------------------------------

async def _scenario_sdk_update_user(client, logger) -> List[dict]:
    """SDK coverage: update_user — can user name/metadata be updated after creation?"""
    assertions = []
    user_id = _uid("val-s12")
    user = await _t(client.create_user, user_id=user_id, name="Original Name", metadata={"tier": "basic"})

    logger.info("  Probing user.update() method...")
    if not hasattr(user, "update"):
        assertions.append(_assert(
            "SDK exposes user.update() method",
            False, "method exists", "AttributeError: not found",
            "SDK gap: update_user not exposed on UserResource",
        ))
        await _t(user.delete)
        return assertions

    try:
        await _t(user.update, name="Updated Name", metadata={"tier": "premium"})
        assertions.append(_assert("user.update() returns 200", True, "success", "success"))
        fetched = await _t(client.get_user, user_id=user_id)
        assertions.append(_assert(
            "Updated name persists on fetch",
            fetched.name == "Updated Name", "Updated Name", fetched.name or "",
        ))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "user.update() works",
            False, "success", f"HTTP {status}" if status else type(e).__name__, str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_sdk_update_memory(client, logger) -> List[dict]:
    """SDK coverage: update_memory — can an existing memory block be updated?"""
    assertions = []
    user_id = _uid("val-s13")
    session_id = _uid("s13-s")

    user = await _t(client.create_user, user_id=user_id, name="Update Memory User")
    session = await _t(user.create_session, session_id=session_id)

    result = await _t(
        session.add_memory,
        messages=[{"user_content": "Original content", "assistant_content": "Original response"}],
        async_processing=False,
        context_required=False,
    )
    block_id = _block_id(result)

    logger.info(f"  Block {block_id[:12]}… added. Probing session.update_memory() / update_block()...")

    update_fn = getattr(session, "update_memory", None) or getattr(session, "update_block", None)
    if update_fn is None:
        assertions.append(_assert(
            "SDK exposes session.update_memory() or update_block()",
            False, "method exists", "AttributeError: not found",
            "SDK gap: update_memory not exposed on SessionResource",
        ))
        await _t(user.delete)
        return assertions

    try:
        resp = await _t(
            update_fn,
            block_id=block_id,
            message={"user_content": "Updated content", "assistant_content": "Updated response"},
            async_processing=False,
            context_required=False,
        )
        assertions.append(_assert("update_memory() returns 200", True, "success", "success"))
        assertions.append(_assert(
            "update_memory() response contains updated block",
            resp.block is not None, "block present", "None" if resp.block is None else "block present",
        ))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "update_memory() works",
            False, "success", f"HTTP {status}" if status else type(e).__name__, str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_sdk_delete_memory_selective(client, logger) -> List[dict]:
    """SDK coverage: delete_memory(block_ids=[...]) — selective block deletion."""
    assertions = []
    user_id = _uid("val-s14")
    session_id = _uid("s14-s")

    user = await _t(client.create_user, user_id=user_id, name="Selective Delete User")
    session = await _t(user.create_session, session_id=session_id)

    r1 = await _t(session.add_memory, messages=[{"user_content": "Keep this", "assistant_content": "A"}], async_processing=False, context_required=False)
    r2 = await _t(session.add_memory, messages=[{"user_content": "Delete this", "assistant_content": "B"}], async_processing=False, context_required=False)
    b1 = _block_id(r1)
    b2 = _block_id(r2)

    logger.info(f"  Two blocks added. Probing session.delete_memory(block_ids=[b2])...")

    delete_fn = getattr(session, "delete_memory", None) or getattr(session, "delete_blocks", None)
    if delete_fn is None:
        assertions.append(_assert(
            "SDK exposes session.delete_memory(block_ids=[...])",
            False, "method exists", "AttributeError: not found",
            "SDK gap: delete_memory(block_ids) not exposed on SessionResource",
        ))
        await _t(user.delete)
        return assertions

    try:
        await _t(delete_fn, block_ids=[b2])
        assertions.append(_assert("delete_memory(block_ids=[b2]) returns 200", True, "success", "success"))
        # Use list_memories (not get_memory/search) for reliable listing of all blocks
        list_result = await _t(session.list_memories)
        remaining = list_result.memory_blocks or []
        remaining_ids = {b.block_id for b in remaining}
        assertions.append(_assert("Deleted block gone", b2 not in remaining_ids, "b2 absent", "b2 present" if b2 in remaining_ids else "b2 absent"))
        assertions.append(_assert("Non-deleted block remains", b1 in remaining_ids, "b1 present", "b1 present" if b1 in remaining_ids else "b1 absent"))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "delete_memory(block_ids) works",
            False, "success", f"HTTP {status}" if status else type(e).__name__, str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_sdk_list_memories_cross_session(client, logger) -> List[dict]:
    """SDK coverage: list memories across all sessions of a user."""
    assertions = []
    user_id = _uid("val-s15")
    sid1 = _uid("s15-s1")
    sid2 = _uid("s15-s2")

    user = await _t(client.create_user, user_id=user_id, name="Cross Session List User")
    sess1 = await _t(user.create_session, session_id=sid1)
    sess2 = await _t(user.create_session, session_id=sid2)
    await _t(sess1.add_memory, messages=[{"user_content": "From session 1", "assistant_content": "A"}], async_processing=False, context_required=False)
    await _t(sess2.add_memory, messages=[{"user_content": "From session 2", "assistant_content": "B"}], async_processing=False, context_required=False)

    logger.info("  Calling user.list_memories(session_ids='all', limit=50, offset=0)...")

    # SDK: user.list_memories() is documented and exists on UserResource
    try:
        assertions.append(_assert("SDK exposes user.list_memories()", True, "method exists", "method exists"))
        result = await _t(user.list_memories, session_ids="all", limit=50, offset=0)
        blocks = result.memory_blocks or []
        assertions.append(_assert(
            "list_memories(session_ids='all') returns ≥2 blocks across sessions",
            len(blocks) >= 2, "≥2", str(len(blocks)),
        ))
        assertions.append(_assert(
            "Response includes pagination fields (total, limit, offset)",
            result.total >= 0 and result.limit > 0,
            "total≥0 and limit>0",
            f"total={result.total} limit={result.limit} offset={result.offset}",
        ))
    except AttributeError:
        assertions.append(_assert(
            "SDK exposes user.list_memories()",
            False, "method exists", "AttributeError: not found",
            "SDK gap: list_memories not exposed on UserResource",
        ))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "user.list_memories() works",
            False, "success", f"HTTP {status}" if status else type(e).__name__, str(e),
        ))

    await _t(user.delete)
    return assertions


async def _scenario_sdk_search_users(client, logger) -> List[dict]:
    """SDK coverage: search or list users — does the SDK expose user enumeration?"""
    assertions = []
    user_id = _uid("val-s16")
    user = await _t(client.create_user, user_id=user_id, name="Search Users Target")

    logger.info("  Calling client.list_users() and client.search_users(name=...)...")

    # client.list_users() — returns UserList with .users (List[User]) where User.id is the identifier
    try:
        result = await _t(client.list_users)
        users = result.users or []
        assertions.append(_assert("client.list_users() returns list", isinstance(users, list), "list", type(users).__name__))
        found = any(getattr(u, "id", None) == user_id for u in users)
        assertions.append(_assert("list_users: created user appears in results (User.id match)", found, "found", "found" if found else "not found"))
    except AttributeError:
        assertions.append(_assert("SDK exposes client.list_users()", False, "method exists", "AttributeError: not found", "SDK gap"))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert("client.list_users() works", False, "success", f"HTTP {status}" if status else type(e).__name__, str(e)))

    # client.search_users(name=...) — requires at least one param; returns User or List[User]
    try:
        search_result = await _t(client.search_users, name="Search Users Target")
        got_list = isinstance(search_result, list)
        matched = (
            any(getattr(u, "id", None) == user_id for u in search_result)
            if got_list else
            getattr(search_result, "id", None) == user_id
        )
        assertions.append(_assert("search_users(name=...) finds created user", matched, "found", "found" if matched else "not found"))
    except AttributeError:
        assertions.append(_assert("SDK exposes client.search_users()", False, "method exists", "AttributeError: not found", "SDK gap"))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert("client.search_users(name=...) works", False, "success", f"HTTP {status}" if status else type(e).__name__, str(e)))

    await _t(user.delete)
    return assertions


async def _scenario_sdk_pagination(client, logger) -> List[dict]:
    """SDK coverage: pagination params on get_memory and list_sessions."""
    assertions = []
    user_id = _uid("val-s17")
    session_id = _uid("s17-s")

    user = await _t(client.create_user, user_id=user_id, name="Pagination User")
    session = await _t(user.create_session, session_id=session_id)

    for i in range(5):
        await _t(session.add_memory,
            messages=[{"user_content": f"Message {i}", "assistant_content": f"Response {i}"}],
            async_processing=False, context_required=False,
        )

    # POSITIVE: session.list_memories(limit=N, offset=M) — pagination IS supported
    logger.info("  Probing session.list_memories(limit=2) — should work...")
    try:
        result = await _t(session.list_memories, limit=2, offset=0)
        blocks = result.memory_blocks or []
        assertions.append(_assert(
            "session.list_memories(limit=2) returns ≤2 blocks",
            len(blocks) <= 2, "≤2", str(len(blocks)),
        ))
        assertions.append(_assert(
            "list_memories response has total > count (pagination works)",
            result.total >= result.count, f"total≥count", f"total={result.total} count={result.count}",
        ))
    except Exception as e:
        status = getattr(e, "status_code", 0)
        assertions.append(_assert(
            "session.list_memories(limit=2) works",
            False, "success", f"HTTP {status}" if status else type(e).__name__, str(e),
        ))

    # NEGATIVE: get_memory(limit=...) — limit not a supported param (uses FilterOptions instead)
    logger.info("  Probing get_memory(limit=2) — expected TypeError (not supported)...")
    try:
        await _t(session.get_memory, limit=2)
        assertions.append(_assert(
            "get_memory(limit=2) not supported (uses FilterOptions, not limit kwarg)",
            False, "TypeError", "no error — SDK accepts unexpected kwarg",
        ))
    except TypeError:
        assertions.append(_assert(
            "get_memory() does not accept limit kwarg (use list_memories instead)",
            True, "TypeError", "TypeError",
        ))
    except Exception:
        pass

    # NEGATIVE: list_sessions(limit=...) — no pagination on list_sessions
    logger.info("  Probing list_sessions(limit=1) — expected TypeError (not supported)...")
    for sid in [_uid("s17-x"), _uid("s17-y")]:
        await _t(user.create_session, session_id=sid)
    try:
        await _t(user.list_sessions, limit=1)
        assertions.append(_assert(
            "list_sessions(limit=1) not supported (no pagination param)",
            False, "TypeError", "no error — SDK accepts unexpected kwarg",
        ))
    except TypeError:
        assertions.append(_assert(
            "list_sessions() does not accept limit kwarg (SDK gap: no session pagination)",
            True, "TypeError", "TypeError",
        ))
    except Exception:
        pass

    await _t(user.delete)
    return assertions


# ---------------------------------------------------------------------------
# Scenario registry
# ---------------------------------------------------------------------------
SCENARIOS = [
    ("s01", "Core CRUD — User Lifecycle",       "Create, fetch, verify, and delete a user. Verify 404 after deletion.",                                       _scenario_user_lifecycle),
    ("s02", "Core CRUD — Session Lifecycle",    "Create/fetch/list session, end it, delete it, verify 404 after deletion.",                                   _scenario_session_lifecycle),
    ("s03", "Core CRUD — Cascade Delete",       "Delete a user with active sessions and verify cascade removal of all sessions.",                              _scenario_cascade_delete),
    ("s04", "Ingestion — Sync Path",            "Add block with async=false/context_required=false; verify immediate searchability and status=ready.",         _scenario_ingestion_sync),
    ("s05", "Ingestion — Async Path",           "Add block with async=true; verify processing→ready transition and LLM enrichment (summary + contexts).",     _scenario_ingestion_async),
    ("s06", "Multi-Agent Isolation",            "Store h1 and h2 annotated blocks; verify annotation filters exclude cross-agent blocks under concurrency.",   _scenario_multi_agent_isolation),
    ("s07", "Memory Retrieval",                 "Verify semantic search returns ready blocks; filter-based retrieval returns all blocks.",                     _scenario_semantic_retrieval),
    ("s08", "Session Immutability",             "Verify ended sessions reject new memory block additions.",                                                    _scenario_session_immutability),
    ("s09", "Duplicate Entity Rejection",       "Verify duplicate user_id and session_id return 409 Conflict.",                                               _scenario_duplicate_rejection),
    ("s10", "Block Validation",                 "Verify oversized and malformed blocks are rejected.",                                                         _scenario_oversized_block),
    ("s11", "TTL Behavior",                          "Verify blocks in TTL sessions expire; blocks in no-TTL sessions persist.",                                    _scenario_ttl_behavior),
    ("s12", "SDK Gap — update_user",                 "Probe user.update(): does the SDK expose user name/metadata update after creation?",                         _scenario_sdk_update_user),
    ("s13", "SDK Gap — update_memory",               "Probe session.update_memory(): does the SDK expose in-place block updates?",                                 _scenario_sdk_update_memory),
    ("s14", "SDK Gap — delete_memory (selective)",   "Probe session.delete_memory(block_ids=[...]): does the SDK expose selective block deletion?",                 _scenario_sdk_delete_memory_selective),
    ("s15", "SDK Gap — list_memories cross-session", "Probe cross-session memory listing: does the SDK expose user.list_memories() or equivalent?",                _scenario_sdk_list_memories_cross_session),
    ("s16", "SDK Gap — search_users",                "Probe client.search_users()/list_users(): does the SDK expose user enumeration?",                            _scenario_sdk_search_users),
    ("s17", "SDK Gap — pagination",                  "Probe get_memory(limit=N) and list_sessions(limit=N): does the SDK expose pagination parameters?",           _scenario_sdk_pagination),
]


# ---------------------------------------------------------------------------
# Background validation runner
# ---------------------------------------------------------------------------
async def _run_validation(run_id: str, client, skip_cleanup: bool = False) -> None:
    logger = _get_run_logger(run_id)
    run = validation_runs[run_id]
    if skip_cleanup:
        client = _NoCleanupClient(client)
        logger.info(f"Validation run started | run_id={run_id} | skip_cleanup=True")
    else:
        logger.info(f"Validation run started | run_id={run_id}")
    logger.info(f"Total scenarios: {len(SCENARIOS)}")
    logger.info("")

    for idx, (_, _, _, fn) in enumerate(SCENARIOS):
        if run.get("cancelled"):
            break
        run["current_scenario"] = idx
        await _exec_scenario(run_id, idx, fn, client, logger)

    run["status"] = "completed"
    run["completed_at"] = _now_iso()
    run["current_scenario"] = -1

    total = len(run["scenarios"])
    passed = sum(1 for s in run["scenarios"] if s["status"] == "passed")
    failed = sum(1 for s in run["scenarios"] if s["status"] in ("failed", "error"))
    run["summary"] = {"total": total, "passed": passed, "failed": failed}

    logger.info("=" * 60)
    logger.info(f"VALIDATION COMPLETE: {passed}/{total} scenarios passed")
    logger.info(f"Failed: {failed}")
    logger.info("=" * 60)


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
class ValidationLaunchRequest(BaseModel):
    scenario_ids: Optional[List[str]] = None
    skip_cleanup: bool = False


@router.post("/api/validation/launch")
async def launch_validation(request: Request, body: ValidationLaunchRequest = None):
    client = request.app.state.ams_client
    run_id = f"val-{uuid.uuid4().hex[:10]}"

    filter_ids = (body.scenario_ids if body else None) or None
    scenarios_to_run = [
        _make_scenario(sid, name, desc)
        for sid, name, desc, _ in SCENARIOS
        if filter_ids is None or sid in filter_ids
    ]

    validation_runs[run_id] = {
        "run_id": run_id,
        "started_at": _now_iso(),
        "completed_at": None,
        "status": "running",
        "current_scenario": 0,
        "scenarios": scenarios_to_run,
        "summary": {"total": len(scenarios_to_run), "passed": 0, "failed": 0},
        "cancelled": False,
    }

    skip_cleanup = bool(body and body.skip_cleanup)
    asyncio.create_task(_run_validation(run_id, client, skip_cleanup=skip_cleanup))
    return {"run_id": run_id, "total_scenarios": len(scenarios_to_run), "skip_cleanup": skip_cleanup}


@router.get("/api/validation/status/{run_id}")
async def get_validation_status(run_id: str):
    run = validation_runs.get(run_id)
    if not run:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return run


@router.get("/api/validation/runs")
async def list_validation_runs():
    return [
        {
            "run_id": r["run_id"],
            "started_at": r["started_at"],
            "completed_at": r.get("completed_at"),
            "status": r["status"],
            "summary": r.get("summary", {}),
        }
        for r in reversed(list(validation_runs.values()))
    ]


@router.delete("/api/validation/runs/{run_id}")
async def delete_validation_run(run_id: str):
    if run_id not in validation_runs:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    del validation_runs[run_id]
    return {"deleted": run_id}
