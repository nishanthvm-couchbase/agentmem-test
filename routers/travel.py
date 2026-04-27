from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, Dict

from ams_client import AMSClient, AMSError

router = APIRouter(prefix="/api/travel", tags=["Travel App Hub"])


# --- Request Models ---
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


def _get_ams(request: Request) -> AMSClient:
    return request.app.state.ams_client


# --- Routes ---

@router.post("/users")
async def create_traveler(user: UserCreate, request: Request):
    try:
        ams = _get_ams(request)
        result = ams.create_user(
            user_id=user.user_id,
            name=user.name,
            metadata=user.preferences,
        )
        return {"status": "success", "user_id": result["id"]}
    except AMSError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/sessions")
async def start_travel_session(user_id: str, session_data: SessionCreate, request: Request):
    try:
        ams = _get_ams(request)
        result = ams.create_session(
            user_id=user_id,
            session_id=session_data.session_id,
            annotations={"agent": session_data.agent_type},
            metadata={"domain": "travel"},
        )
        return {"status": "success", "session_id": result["session_id"]}
    except AMSError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/sessions/{session_id}/memory")
async def chat_with_agent(user_id: str, session_id: str, memory: MemoryAdd, request: Request):
    try:
        ams = _get_ams(request)
        result = ams.add_memory(
            user_id=user_id,
            session_id=session_id,
            messages=[{
                "user_content": memory.user_message,
                "assistant_content": memory.assistant_response,
            }],
            annotations={"agent": memory.agent_type},
            async_processing=True,
        )
        return {"status": "success", "blocks_added": result["count"]}
    except AMSError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/users/{user_id}/sessions/{session_id}/recall")
async def recall_context(user_id: str, session_id: str, query_data: MemoryQuery, request: Request):
    try:
        ams = _get_ams(request)
        filters = None
        if query_data.agent_type:
            filters = {"annotations": {"agent": query_data.agent_type}}

        result = ams.search_memory(
            user_id=user_id,
            session_id=session_id,
            query=query_data.query,
            filters=filters,
        )

        context = []
        for block in result.get("memory_blocks", []):
            msg = block.get("message")
            fact = block.get("fact")
            if msg:
                context.append(f"User: {msg['user_content']} | Agent: {msg.get('assistant_content', '')}")
            elif fact:
                context.append(f"Fact: {fact}")

        return {"status": "success", "retrieved_context": context}
    except AMSError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
