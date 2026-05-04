from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Dict

from agentmem import AgentMemClient, AgentMemError

router = APIRouter(prefix="/api/travel", tags=["Travel App Hub"])


class UserCreate(BaseModel):
    user_id: str
    name: str
    preferences: Optional[Dict[str, str]] = None


class SessionCreate(BaseModel):
    session_id: str
    agent_type: str


class MemoryAdd(BaseModel):
    user_message: str
    assistant_response: str
    agent_type: str


class MemoryQuery(BaseModel):
    query: str
    agent_type: Optional[str] = None


def _get_ams(request: Request) -> AgentMemClient:
    return request.app.state.ams_client


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


@router.post("/users/{user_id}/sessions/{session_id}/recall")
async def recall_context(user_id: str, session_id: str, query_data: MemoryQuery, request: Request):
    try:
        ams = _get_ams(request)
        user = ams.get_user(user_id=user_id)
        session = user.get_session(session_id=session_id)

        filters = None
        if query_data.agent_type:
            filters = {"annotations": {"agent": query_data.agent_type}}

        result = session.get_memory(query=query_data.query, filters=filters)

        context = []
        for block in result.memory_blocks or []:
            if block.message:
                context.append(f"User: {block.message.user_content} | Agent: {block.message.assistant_content or ''}")
            elif block.fact:
                context.append(f"Fact: {block.fact}")

        return {"status": "success", "retrieved_context": context}
    except AgentMemError as e:
        raise HTTPException(status_code=e.status_code or 500, detail=e.message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
