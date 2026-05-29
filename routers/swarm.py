import asyncio
import logging
import logging.handlers
import os
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, List
from fastapi import APIRouter, Request
from pydantic import BaseModel

from agentmemory import AgentMemoryClient, AsyncAgentMemoryClient, AgentMemoryError
from agentmemory import (
    RateLimitError,
    ServiceUnavailableError,
    ConflictError,
    TimeoutError as AMSTimeoutError,
    ServerError,
)
from agentmemory import ValidationError as AMSValidationError

router = APIRouter(prefix="/api/swarm", tags=["Swarm Load Tester"])

# ---------------------------------------------------------------------------
# Per-run rotating log
# ---------------------------------------------------------------------------
LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)


def _get_run_logger(run_id: str) -> logging.Logger:
    logger = logging.getLogger(f"swarm.{run_id}")
    logger.setLevel(logging.DEBUG)
    if not logger.handlers:
        log_file = os.path.join(LOG_DIR, f"swarm_{run_id}.log")
        handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=20 * 1024 * 1024, backupCount=2
        )
        handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
    return logger

# ---------------------------------------------------------------------------
# Mock data
# ---------------------------------------------------------------------------
TRAVEL_QUERIES = [
    ("I need a flight to Tokyo next Monday.", "I found 3 flights to Tokyo for next Monday. Economy or business?"),
    ("Make sure the hotel has a vegan menu.", "Noted your vegan preference. Filtering hotels accordingly."),
    ("Cancel the rental car, I'll take the train.", "Done. Rental car cancelled."),
    ("What's my loyalty number for Delta?", "Your Delta SkyMiles number is DL123456789."),
    ("I prefer aisle seats.", "Got it. I'll prioritise aisle seats for all future bookings."),
    ("Check visa requirements for Japan.", "US citizens can enter Japan visa-free for up to 90 days."),
    ("Book me into the Hilton near Shibuya.", "Reserved a room at Hilton Tokyo in Shibuya for your dates."),
    ("What time is checkout?", "Standard checkout is 11:00 AM. Late checkout until 2 PM is available."),
    ("Can I get airport transfer arranged?", "I've booked a private transfer from Narita to your hotel."),
    ("What's the weather forecast for Kyoto?", "Kyoto in spring averages 15-20°C. Light layers recommended."),
]

TRAVEL_FACTS = [
    "User prefers window seats on flights longer than 4 hours.",
    "User is allergic to shellfish.",
    "User's passport expires on 2027-08-15.",
    "User has Global Entry and TSA PreCheck.",
    "User's home airport is SFO.",
    "User prefers boutique hotels over chain hotels.",
    "User travels with carry-on only when possible.",
    "User's frequent flyer number for United is UA987654321.",
    "User requires gluten-free meal options on long-haul flights.",
    "User always books refundable rates.",
]

OVERSIZED_PADDING = "This is filler content to exceed the per-request token limit. " * 600

# ---------------------------------------------------------------------------
# In-memory run store
# ---------------------------------------------------------------------------
swarm_runs: Dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class SwarmConfig(BaseModel):
    num_users: int = 5
    sessions_per_user: int = 1
    messages_per_session: int = 4
    include_facts: bool = True
    facts_per_session: int = 2
    include_oversized: bool = False
    oversized_per_session: int = 1
    async_processing: bool = True
    context_required: Optional[bool] = None
    max_concurrency: int = 20
    delay_between_requests: float = 0.0


# ---------------------------------------------------------------------------
# Error categorisation — uses SDK exception hierarchy
# ---------------------------------------------------------------------------
def _categorize_error(exc: Exception) -> str:
    if isinstance(exc, RateLimitError):
        return "rate_limited"
    if isinstance(exc, ServiceUnavailableError):
        return "queue_full"
    if isinstance(exc, ConflictError):
        return "conflict"
    if isinstance(exc, AMSValidationError):
        return "validation_error"
    if isinstance(exc, AMSTimeoutError):
        return "timeout"
    if isinstance(exc, ServerError):
        return "server_error"
    if isinstance(exc, AgentMemoryError):
        return f"http_{exc.status_code}" if exc.status_code else "ams_error"
    return "network_error"


# ---------------------------------------------------------------------------
# Latency helpers
# ---------------------------------------------------------------------------
def _percentile(sorted_samples: list, pct: float) -> Optional[float]:
    if not sorted_samples:
        return None
    idx = min(int(len(sorted_samples) * pct / 100), len(sorted_samples) - 1)
    return round(sorted_samples[idx], 1)


# ---------------------------------------------------------------------------
# Run state initialisation
# ---------------------------------------------------------------------------
def _init_run(run_id: str, config: SwarmConfig) -> dict:
    cfg = config.model_dump()
    log_file = os.path.join(LOG_DIR, f"swarm_{run_id}.log")
    run = {
        "run_id": run_id,
        "status": "running",
        "completed": False,
        "config": cfg,
        "log_file": log_file,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "elapsed_seconds": None,
        "users_created": 0,
        "sessions_created": 0,
        "messages_sent": 0,
        "messages_succeeded": 0,
        "facts_sent": 0,
        "facts_succeeded": 0,
        "oversized_sent": 0,
        "oversized_rejected": 0,
        "errors_total": 0,
        "errors_by_type": {},
        "recent_errors": [],
        "_latency_samples": [],
        "_logger": _get_run_logger(run_id),
        "user_ids": [],
    }
    swarm_runs[run_id] = run
    return run


def _record_error(run: dict, user_id: str, stage: str, exc: Exception):
    category = _categorize_error(exc)
    run["errors_total"] += 1
    run["errors_by_type"][category] = run["errors_by_type"].get(category, 0) + 1
    status_code = getattr(exc, "status_code", None)
    exc_type = type(exc).__name__
    raw_msg = str(getattr(exc, "message", None) or str(exc) or repr(exc))
    detail_str = f"{exc_type}: {raw_msg}"[:500]
    extra = getattr(exc, "details", None)
    if extra:
        detail_str = (detail_str + " | " + str(extra))[:500]
    entry = {
        "user_id": user_id[:8],
        "stage": stage,
        "category": category,
        "status_code": status_code,
        "detail": detail_str,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    if len(run["recent_errors"]) < 50:
        run["recent_errors"].append(entry)
    log = run["_logger"]
    sc = f"HTTP {status_code} " if status_code else ""
    log.warning(f"  [ERR] {stage} | user={user_id[:8]} | {sc}{category} | {detail_str}")


# ---------------------------------------------------------------------------
# Core simulation helpers
# ---------------------------------------------------------------------------
async def _send_memory(
    run: dict,
    session_resource,
    user_id: str,
    config: SwarmConfig,
    kind: str,
    payload_kwargs: dict,
    semaphore: asyncio.Semaphore,
):
    log = run["_logger"]
    async with semaphore:
        t0 = time.monotonic()
        try:
            await session_resource.add_memory(
                annotations={"agent": "swarm", "run_id": run["run_id"]},
                async_processing=config.async_processing,
                context_required=config.context_required,
                **payload_kwargs,
            )
            elapsed_ms = (time.monotonic() - t0) * 1000
            if len(run["_latency_samples"]) < 10_000:
                run["_latency_samples"].append(elapsed_ms)

            if kind == "message":
                run["messages_sent"] += 1
                run["messages_succeeded"] += 1
            elif kind == "fact":
                run["facts_sent"] += 1
                run["facts_succeeded"] += 1
            elif kind == "oversized":
                run["oversized_sent"] += 1

            log.debug(f"  [OK ] add_{kind} | user={user_id[:8]} | {elapsed_ms:.0f}ms")

        except Exception as e:
            if kind == "message":
                run["messages_sent"] += 1
            elif kind == "fact":
                run["facts_sent"] += 1
            elif kind == "oversized":
                run["oversized_sent"] += 1
                run["oversized_rejected"] += 1
            _record_error(run, user_id, f"add_{kind}", e)

    if config.delay_between_requests > 0:
        await asyncio.sleep(config.delay_between_requests)


async def _simulate_session(
    run: dict,
    user_resource,
    user_id: str,
    config: SwarmConfig,
    semaphore: asyncio.Semaphore,
):
    log = run["_logger"]
    session_id = str(uuid.uuid4())
    try:
        async with semaphore:
            session = await user_resource.create_session(
                session_id=session_id,
                annotations={"source": "swarm", "run_id": run["run_id"]},
            )
        run["sessions_created"] += 1
        log.debug(f"  [OK ] create_session | user={user_id[:8]} sess={session_id[:8]}")
    except Exception as e:
        _record_error(run, user_id, "create_session", e)
        return

    tasks = []

    for _ in range(config.messages_per_session):
        q, a = random.choice(TRAVEL_QUERIES)
        tasks.append(_send_memory(
            run, session, user_id, config, "message",
            {"messages": [{"user_content": q, "assistant_content": a}]},
            semaphore,
        ))

    if config.include_facts:
        for _ in range(config.facts_per_session):
            tasks.append(_send_memory(
                run, session, user_id, config, "fact",
                {"facts": [random.choice(TRAVEL_FACTS)]},
                semaphore,
            ))

    if config.include_oversized:
        for _ in range(config.oversized_per_session):
            tasks.append(_send_memory(
                run, session, user_id, config, "oversized",
                {"messages": [{"user_content": OVERSIZED_PADDING, "assistant_content": "padded " * 200}]},
                semaphore,
            ))

    await asyncio.gather(*tasks, return_exceptions=True)


async def _simulate_user(
    run: dict,
    user_id: str,
    config: SwarmConfig,
    ams: AsyncAgentMemoryClient,
    semaphore: asyncio.Semaphore,
):
    log = run["_logger"]
    try:
        async with semaphore:
            user = await ams.create_user(user_id=user_id, name=f"SwarmUser_{user_id[:8]}")
        run["users_created"] += 1
        log.debug(f"  [OK ] create_user | user={user_id[:8]}")
    except Exception as e:
        _record_error(run, user_id, "create_user", e)
        return

    session_tasks = [
        _simulate_session(run, user, user_id, config, semaphore)
        for _ in range(config.sessions_per_user)
    ]
    await asyncio.gather(*session_tasks, return_exceptions=True)


async def _run_swarm(run: dict, config: SwarmConfig, ams: AsyncAgentMemoryClient):
    log = run["_logger"]
    cfg = config
    log.info(f"Swarm run started | run_id={run['run_id']}")
    log.info(f"Config: {cfg.num_users} users × {cfg.sessions_per_user} sessions × {cfg.messages_per_session} messages")
    log.info(f"  async={cfg.async_processing}  context_required={cfg.context_required}  concurrency={cfg.max_concurrency}")
    log.info(f"  include_facts={cfg.include_facts}  include_oversized={cfg.include_oversized}")
    log.info(f"  log_file={run['log_file']}")
    log.info("")

    start = time.monotonic()
    user_ids = [str(uuid.uuid4()) for _ in range(config.num_users)]
    run["user_ids"] = user_ids

    semaphore = asyncio.Semaphore(config.max_concurrency)
    tasks = [_simulate_user(run, uid, config, ams, semaphore) for uid in user_ids]
    await asyncio.gather(*tasks, return_exceptions=True)

    elapsed = time.monotonic() - start
    run["elapsed_seconds"] = round(elapsed, 3)
    run["finished_at"] = datetime.now(timezone.utc).isoformat()
    run["status"] = "completed"
    run["completed"] = True

    total_succeeded = run["messages_succeeded"] + run["facts_succeeded"]
    total_sent = run["messages_sent"] + run["facts_sent"]
    log.info("")
    log.info("=" * 60)
    log.info(f"SWARM COMPLETE | elapsed={elapsed:.3f}s")
    log.info(f"  users={run['users_created']}/{cfg.num_users}  sessions={run['sessions_created']}")
    log.info(f"  succeeded={total_succeeded}/{total_sent}  errors={run['errors_total']}")
    log.info(f"  errors_by_type={run['errors_by_type']}")
    log.info("=" * 60)


# ---------------------------------------------------------------------------
# Status builder — flat dict for the UI
# ---------------------------------------------------------------------------
def _build_status(run: dict) -> dict:
    cfg = run["config"]
    samples = sorted(run["_latency_samples"])
    elapsed = run["elapsed_seconds"]
    total_succeeded = run["messages_succeeded"] + run["facts_succeeded"]
    throughput = round(total_succeeded / elapsed, 2) if elapsed and elapsed > 0 else None
    total_sent = run["messages_sent"] + run["facts_sent"]
    success_rate = round(total_succeeded / total_sent * 100, 1) if total_sent > 0 else None

    return {
        "run_id": run["run_id"],
        "completed": run["completed"],
        "status": run["status"],
        "num_users": cfg["num_users"],
        "sessions_per_user": cfg["sessions_per_user"],
        "messages_per_session": cfg["messages_per_session"],
        "async_processing": cfg["async_processing"],
        "context_required": cfg["context_required"],
        "max_concurrency": cfg["max_concurrency"],
        "include_facts": cfg["include_facts"],
        "include_oversized": cfg["include_oversized"],
        "started_at": run["started_at"],
        "finished_at": run["finished_at"],
        "elapsed_seconds": elapsed,
        "users_created": run["users_created"],
        "sessions_created": run["sessions_created"],
        "messages_sent": run["messages_sent"],
        "messages_succeeded": run["messages_succeeded"],
        "facts_sent": run["facts_sent"],
        "facts_succeeded": run["facts_succeeded"],
        "oversized_sent": run["oversized_sent"],
        "oversized_rejected": run["oversized_rejected"],
        "throughput_rps": throughput,
        "latency_p50_ms": _percentile(samples, 50),
        "latency_p95_ms": _percentile(samples, 95),
        "success_rate_pct": success_rate,
        "log_file": run.get("log_file"),
        "errors_total": run["errors_total"],
        "errors_by_type": run["errors_by_type"],
        "recent_errors": run["recent_errors"][-20:],
        "total_expected": {
            "users": cfg["num_users"],
            "sessions": cfg["num_users"] * cfg["sessions_per_user"],
            "messages": cfg["num_users"] * cfg["sessions_per_user"] * cfg["messages_per_session"],
            "facts": (
                cfg["num_users"] * cfg["sessions_per_user"] * cfg["facts_per_session"]
                if cfg["include_facts"] else 0
            ),
        },
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.post("/launch")
async def launch_swarm(config: SwarmConfig, request: Request):
    run_id = f"swarm-{uuid.uuid4().hex[:10]}"
    run = _init_run(run_id, config)
    ams: AsyncAgentMemoryClient = request.app.state.async_ams_client
    asyncio.create_task(_run_swarm(run, config, ams))
    return {"run_id": run_id, "total_expected": _build_status(run)["total_expected"]}


@router.get("/status/{run_id}")
async def get_swarm_status(run_id: str):
    run = swarm_runs.get(run_id)
    if not run:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return _build_status(run)


@router.get("/runs")
async def list_swarm_runs():
    return [
        {
            "run_id": r["run_id"],
            "completed": r["completed"],
            "status": r["status"],
            "started_at": r["started_at"],
            "finished_at": r["finished_at"],
            "elapsed_seconds": r["elapsed_seconds"],
            "num_users": r["config"]["num_users"],
            "sessions_per_user": r["config"]["sessions_per_user"],
            "messages_per_session": r["config"]["messages_per_session"],
            "async_processing": r["config"]["async_processing"],
            "messages_succeeded": r["messages_succeeded"],
            "errors_total": r["errors_total"],
        }
        for r in sorted(swarm_runs.values(), key=lambda x: x["started_at"], reverse=True)
    ]


@router.delete("/cleanup/{run_id}")
async def cleanup_swarm_run(run_id: str, request: Request):
    run = swarm_runs.get(run_id)
    if not run:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    if not run["completed"]:
        from fastapi import HTTPException
        raise HTTPException(status_code=409, detail="Cannot cleanup a running swarm")

    ams: AgentMemoryClient = request.app.state.ams_client
    deleted, cleanup_errors = 0, []
    for uid in run["user_ids"]:
        try:
            user = ams.get_user(user_id=uid)
            user.delete()
            deleted += 1
        except Exception as e:
            cleanup_errors.append({"user_id": uid[:8], "error": str(e)})

    del swarm_runs[run_id]
    return {"deleted_users": deleted, "cleanup_errors": cleanup_errors}
