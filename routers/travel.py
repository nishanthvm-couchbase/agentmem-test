import os
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Dict, List
from openai import OpenAI

from agentmem import AgentMemClient, AgentMemError

router = APIRouter(prefix="/api/travel", tags=["Travel App Hub"])


class UserCreate(BaseModel):
    user_id: str
    name: str
    preferences: Optional[Dict[str, str]] = None


class SessionCreate(BaseModel):
    session_id: str
    agent_type: str = "general"


class MemoryAdd(BaseModel):
    user_message: str
    assistant_response: str
    agent_type: str


class MemoryQuery(BaseModel):
    query: Optional[str] = None
    agent_type: Optional[str] = None
    block_ids: Optional[List[str]] = None
    cross_session: bool = False


AGENT_PERSONAS = {
    "h1": "You are a personal diet and nutrition coach. Help users with meal planning, dietary advice, and health goals. Be concise.",
    "h2": "You are a travel assistant. Help users plan trips, book arrangements, and navigate travel requirements. Be concise.",
    "h3": "You are a work and productivity coach. Help users manage tasks, projects, and professional goals. Be concise.",
}


class ChatRequest(BaseModel):
    user_id: str
    session_id: str
    agent_id: str
    message: str
    context_blocks: Optional[List[str]] = None  # pre-fetched snippets; skips auto-recall when provided


def _get_ams(request: Request) -> AgentMemClient:
    return request.app.state.ams_client


def _get_openai() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")
    return OpenAI(api_key=api_key)


@router.post("/users")
async def create_traveler(user: UserCreate, request: Request):
    try:
        ams = _get_ams(request)
        result = ams.create_user(
            user_id=user.user_id,
            name=user.name,
            metadata=user.preferences,
        )
        return {"status": "success", "user_id": result.user_id}
    except AgentMemError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/sessions")
async def start_travel_session(user_id: str, session_data: SessionCreate, request: Request):
    try:
        ams = _get_ams(request)
        user = ams.get_user(user_id=user_id)
        session = user.create_session(
            session_id=session_data.session_id,
            annotations={"agent": session_data.agent_type},
            metadata={"domain": "travel"},
        )
        return {"status": "success", "session_id": session.session_id}
    except AgentMemError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/sessions/{session_id}/memory")
async def chat_with_agent(user_id: str, session_id: str, memory: MemoryAdd, request: Request):
    try:
        ams = _get_ams(request)
        user = ams.get_user(user_id=user_id)
        session = user.get_session(session_id=session_id)
        result = session.add_memory(
            messages=[{
                "user_content": memory.user_message,
                "assistant_content": memory.assistant_response,
            }],
            annotations={"agent": memory.agent_type},
            async_processing=True,
        )
        return {"status": "success", "blocks_added": result.accepted_count}
    except AgentMemError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat")
async def chat(req: ChatRequest, request: Request):
    ams = _get_ams(request)

    # Ensure user and session exist
    try:
        ams.create_user(user_id=req.user_id, name="Demo User")
    except Exception:
        pass
    try:
        user = ams.get_user(user_id=req.user_id)
        user.create_session(session_id=req.session_id, annotations={"agent": req.agent_id})
    except Exception:
        pass

    # Use explicitly provided context blocks, or auto-recall if none provided
    if req.context_blocks:
        recalled = req.context_blocks
    else:
        recalled = []

    # Build system prompt with context
    system = AGENT_PERSONAS.get(req.agent_id, "You are a helpful assistant.")
    if recalled:
        system += "\n\nRelevant memory from previous conversations:\n" + "\n".join(recalled[:5])

    # Call OpenAI
    try:
        oai = _get_openai()
        completion = oai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": req.message},
            ],
            max_tokens=300,
        )
        reply = completion.choices[0].message.content
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    return {
        "reply": reply,
        "context_used": len(recalled),
    }


@router.get("/users/{user_id}/sessions/{session_id}/memories")
async def list_memories(user_id: str, session_id: str, request: Request):
    try:
        ams = _get_ams(request)
        user = ams.get_user(user_id=user_id)
        session = user.get_session(session_id=session_id)
        result = session.list_memories(limit=20)
        blocks = []
        for block in result.memory_blocks or []:
            if block.message:
                blocks.append({"type": "message", "user": block.message.user_content, "agent": block.message.assistant_content})
            elif block.fact:
                blocks.append({"type": "fact", "content": block.fact})
            elif block.summary:
                blocks.append({"type": "summary", "content": block.summary})
        return {"blocks": blocks, "total": result.total}
    except AgentMemError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/sessions/{session_id}/recall")
async def recall_context(user_id: str, session_id: str, query_data: MemoryQuery, request: Request):
    try:
        ams = _get_ams(request)
        user = ams.get_user(user_id=user_id)

        session = user.get_session(session_id=session_id)
        filters = {}
        if query_data.cross_session:
            filters["session_ids"] = "all"
        if query_data.agent_type:
            filters["annotations"] = {"agent": query_data.agent_type}
        if query_data.block_ids:
            filters["block_ids"] = query_data.block_ids

        result = session.get_memory(
            query=query_data.query or None,
            filters=filters if filters else None,
        )
        raw_blocks = result.memory_blocks or []

        context = []
        blocks = []
        for block in raw_blocks:
            annotations = block.annotations or {}
            block_id = getattr(block, "block_id", None) or getattr(block, "id", None) or ""
            if block.message:
                snippet = f"Past exchange — User: {block.message.user_content} | Agent: {block.message.assistant_content or ''}"
                context.append(snippet)
                blocks.append({
                    "block_id": block_id,
                    "type": "message",
                    "user": block.message.user_content,
                    "agent": block.message.assistant_content,
                    "annotations": annotations,
                    "snippet": snippet,
                })
            elif block.fact:
                snippet = f"Known fact: {block.fact}"
                context.append(snippet)
                blocks.append({
                    "block_id": block_id,
                    "type": "fact",
                    "content": block.fact,
                    "annotations": annotations,
                    "snippet": snippet,
                })
            elif block.summary:
                snippet = f"Summary: {block.summary}"
                context.append(snippet)
                blocks.append({
                    "block_id": block_id,
                    "type": "summary",
                    "content": block.summary,
                    "annotations": annotations,
                    "snippet": snippet,
                })

        return {"status": "success", "retrieved_context": context, "blocks": blocks, "total": len(blocks)}
    except AgentMemError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
