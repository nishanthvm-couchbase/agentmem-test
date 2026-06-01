"""
SDK Explorer — fixed 3-turn scenario run on two paths side-by-side.

Without AgentMem : stateless, all three turns fire in parallel.
With AgentMem    : two sessions, two agents, sequential per turn.

  Turn 1 — Session A / advisor   : no recall (fresh start)
  Turn 2 — Session A / advisor   : off-topic → get_memory returns []
                                    then session_a.end()
  Turn 3 — Session B / specialist: cross-session recall from ended Session A
"""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from openai import OpenAI

from agentmemory import AgentMemoryClient, AgentMemoryError

router = APIRouter(prefix="/api/explorer", tags=["SDK Explorer"])

# Minimum cosine similarity for a memory block to be injected into the prompt.
# Blocks returned by get_memory below this score are discarded.
# Raise this if loosely-related turns are picking up irrelevant context;
# lower it if relevant context is being missed.
MIN_RELEVANCE: float = 0.78

# ---------------------------------------------------------------------------
# Scenario definitions
# Turn 2 is deliberately off-topic so semantic search returns no context,
# demonstrating that memory retrieval is selective, not unconditional.
# ---------------------------------------------------------------------------
SCENARIOS = {
    "travel": {
        "id": "travel",
        "label": "Travel Planning",
        "icon": "travel",
        "description": "Plan a Tokyo trip across 3 turns",
        "persona": (
            "You are a knowledgeable travel assistant. "
            "Be helpful and concise — 2 to 3 sentences max. "
            "If memory context is available, use it to personalise your answer."
        ),
        "turns": [
            "I'm planning a 10-day trip to Tokyo with my partner. We love street food and traditional architecture — places like Yanaka and Tsukiji are high on our list.",
            "Quick one — can you draft a short out-of-office email for while I'm away?",
            "Is 10 days in Tokyo enough to do justice to our interests, or should we extend the trip?",
        ],
    },
    "health": {
        "id": "health",
        "label": "Health Coach",
        "icon": "health",
        "description": "Build a personalised fitness plan across 3 turns",
        "persona": (
            "You are a personal health and fitness coach. "
            "Be encouraging and concise — 2 to 3 sentences max. "
            "If memory context is available, use it to personalise your answer."
        ),
        "turns": [
            "I want to lose 8 kg in 3 months. I'm vegetarian, have a bad left knee, and can only exercise before my 7am shift.",
            "Random question — any good audiobook app recommendations? I'm into mysteries.",
            "Design me a workout routine that actually fits my situation.",
        ],
    },
    "work": {
        "id": "work",
        "label": "Work Assistant",
        "icon": "work",
        "description": "Navigate a high-stakes product launch across 3 turns",
        "persona": (
            "You are a work and productivity coach. "
            "Be practical and concise — 2 to 3 sentences max. "
            "If memory context is available, use it to personalise your answer."
        ),
        "turns": [
            "I'm leading a mobile app launch in 6 weeks. My team is 4 devs and 2 QA with no dedicated PM, and we just had a major feature added to scope last week.",
            "Switching gears — any tips for giving better code review feedback to junior devs?",
            "What's the biggest risk threatening our launch right now, and what should I do about it this week?",
        ],
    },
}


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------
class ExplorerRunRequest(BaseModel):
    name: str
    scenario_id: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_ams(request: Request) -> AgentMemoryClient:
    return request.app.state.ams_client


def _get_openai() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")
    return OpenAI(api_key=api_key)


def _user_id(name: str) -> str:
    slug = name.lower().strip().replace(" ", "-")
    safe = "".join(c for c in slug if c.isalnum() or c == "-")[:40]
    return f"explorer-{safe}"


def _extract_snippets(mem, min_score: float = MIN_RELEVANCE) -> list:
    """Return top-5 relevant snippets as {text, score} dicts.

    Blocks whose rel_score is below min_score are silently dropped so that
    off-topic queries don't inject irrelevant context into the prompt.
    Blocks without a score (e.g. from list_memories) are always included.
    """
    results = []
    for b in (mem.memory_blocks or []):
        if b.rel_score is not None and b.rel_score < min_score:
            continue
        text = (
            b.fact
            or b.summary
            or (f"Previously: {b.message.user_content}" if b.message else None)
        )
        if text:
            results.append({
                "text": text,
                "score": round(b.rel_score, 3) if b.rel_score is not None else None,
            })
    return results[:1]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/scenarios")
def get_scenarios():
    return {
        "scenarios": [
            {
                "id": s["id"],
                "label": s["label"],
                "icon": s["icon"],
                "description": s["description"],
                "turns": s["turns"],
            }
            for s in SCENARIOS.values()
        ]
    }


@router.post("/run")
def run_comparison(req: ExplorerRunRequest, request: Request):
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="name is required")

    scenario = SCENARIOS.get(req.scenario_id)
    if not scenario:
        raise HTTPException(status_code=400, detail=f"unknown scenario: {req.scenario_id}")

    ams = _get_ams(request)
    oai = _get_openai()
    turns = scenario["turns"]
    persona = scenario["persona"]

    # ── WITHOUT AgentMem — submit all 3 in parallel, stateless ───────────────
    def _call_without(msg: str) -> str:
        try:
            c = oai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": persona},
                    {"role": "user", "content": msg},
                ],
                max_tokens=220,
            )
            return c.choices[0].message.content
        except Exception as e:
            return f"[LLM error: {e}]"

    pool = ThreadPoolExecutor(max_workers=3)
    without_futures = [(msg, pool.submit(_call_without, msg)) for msg in turns]

    # ── WITH AgentMem — two sessions, two agents, sequential ─────────────────
    user_id = _user_id(req.name)
    session_a_id = f"exp-a-{uuid.uuid4().hex[:8]}"
    session_b_id = f"exp-b-{uuid.uuid4().hex[:8]}"

    # Wipe any prior data for this name so every run starts fresh.
    try:
        existing = ams.get_user(user_id=user_id)
        existing.delete()
    except Exception:
        pass  # user didn't exist — fine

    try:
        ams.create_user(user_id=user_id, name=req.name)
    except Exception as e:
        pool.shutdown(wait=False)
        raise HTTPException(status_code=500, detail=f"Failed to create user: {e}")

    try:
        user = ams.get_user(user_id=user_id)
        session_a = user.create_session(
            session_id=session_a_id,
            annotations={"domain": "explorer", "agent": "advisor", "scenario": req.scenario_id},
        )
        session_b = user.create_session(
            session_id=session_b_id,
            annotations={"domain": "explorer", "agent": "specialist", "scenario": req.scenario_id},
        )
    except AgentMemoryError as e:
        pool.shutdown(wait=False)
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        pool.shutdown(wait=False)
        raise HTTPException(status_code=500, detail=str(e))

    with_results = []

    for i, msg in enumerate(turns):
        context_snippets = []

        if i == 0:
            # Turn 1 — fresh start, no recall
            pass

        elif i == 1:
            # Turn 2 — off-topic, retrieve from Session A only.
            # Apply the strict MIN_RELEVANCE threshold so loosely-related
            # blocks (e.g. "away" matching "travel") are filtered out.
            try:
                mem = session_a.get_memory(query=msg)  # no filters → current session only
                context_snippets = _extract_snippets(mem, min_score=MIN_RELEVANCE)
            except Exception:
                pass

        else:
            # Turn 3 — cross-session recall: Session B reads from ALL sessions.
            # No client-side threshold here: the server's vector search already
            # filters by its own relevance floor, so anything returned is
            # meaningful. We only suppress low-score blocks for the off-topic
            # Turn 2 check.
            try:
                mem = session_b.get_memory(
                    query=msg,
                    filters={"session_ids": "all"},
                )
                context_snippets = _extract_snippets(mem, min_score=0.0)
            except Exception:
                pass

        system = persona
        if context_snippets:
            system += "\n\nRelevant memory from prior conversations:\n" + "\n".join(
                f"• {s['text']}" for s in context_snippets
            )

        try:
            completion = oai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": msg},
                ],
                max_tokens=220,
            )
            reply = completion.choices[0].message.content
        except Exception as e:
            reply = f"[LLM error: {e}]"

        # Session A stores Turns 1 & 2 synchronously
        if i < 2:
            try:
                session_a.add_memory(
                    messages=[{"user_content": msg, "assistant_content": reply}],
                    annotations={"scenario": req.scenario_id, "agent": "advisor"},
                    async_processing=False,
                )
            except Exception:
                pass

        # End Session A after Turn 2 — demonstrates session lifecycle
        if i == 1:
            try:
                session_a.end()
            except Exception:
                pass

        is_specialist = (i == 2)
        with_results.append({
            "user": msg,
            "reply": reply,
            "context_used": context_snippets,
            "agent": "specialist" if is_specialist else "advisor",
            "session_id": session_b_id if is_specialist else session_a_id,
            "is_new_session": is_specialist,
        })

    # ── Collect WITHOUT results (parallel calls are done by now) ─────────────
    pool.shutdown(wait=True)
    without_results = [
        {"user": msg, "reply": fut.result(), "context_used": []}
        for msg, fut in without_futures
    ]

    # ── Fetch stored blocks for the memory inspector (Session A) ─────────────
    memory_blocks = []
    try:
        list_resp = session_a.list_memories(limit=20)
        for block in list_resp.memory_blocks or []:
            if block.fact:
                memory_blocks.append({"type": "fact", "content": block.fact})
            elif block.summary:
                memory_blocks.append({"type": "summary", "content": block.summary})
            elif block.message:
                memory_blocks.append({
                    "type": "message",
                    "user": block.message.user_content,
                    "agent": block.message.assistant_content,
                })
    except Exception:
        pass

    return {
        "user_id": user_id,
        "session_a_id": session_a_id,
        "session_b_id": session_b_id,
        "scenario": scenario["label"],
        "turns": turns,
        "without_mem": without_results,
        "with_mem": with_results,
        "memory_blocks": memory_blocks,
    }
