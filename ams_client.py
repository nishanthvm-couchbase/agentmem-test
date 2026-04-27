import httpx
from typing import Optional, Dict, List, Any

DEFAULT_AMS_URL = "http://localhost:8080"
DEFAULT_TIMEOUT = 30.0
DEFAULT_ASYNC_TIMEOUT = 120.0


class AMSClient:
    """HTTP client for the AgentMem Server REST API."""

    def __init__(
        self,
        base_url: str = DEFAULT_AMS_URL,
        token: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(
            base_url=self.base_url, headers=headers, timeout=self.timeout
        )

    def close(self):
        self._client.close()

    def _raise_on_error(self, resp: httpx.Response):
        if resp.status_code >= 400:
            detail = resp.text
            try:
                detail = resp.json()
            except Exception:
                pass
            raise AMSError(resp.status_code, detail)

    # --- Health ---

    def health(self) -> dict:
        resp = self._client.get("/health")
        self._raise_on_error(resp)
        return resp.json()

    # --- Users ---

    def create_user(
        self,
        user_id: str,
        name: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> dict:
        payload = {"user_id": user_id, "name": name}
        if metadata:
            payload["metadata"] = metadata
        resp = self._client.post("/users", json=payload)
        self._raise_on_error(resp)
        return resp.json()

    def get_user(self, user_id: str) -> dict:
        resp = self._client.post("/users/search", json={"user_id": user_id})
        self._raise_on_error(resp)
        return resp.json()

    def delete_user(self, user_id: str) -> None:
        resp = self._client.delete(f"/users/{user_id}")
        self._raise_on_error(resp)

    def list_users(self) -> dict:
        resp = self._client.get("/users")
        self._raise_on_error(resp)
        return resp.json()

    # --- Sessions ---

    def create_session(
        self,
        user_id: str,
        session_id: str,
        annotations: Optional[Dict[str, str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        memory_blocks_ttl: Optional[int] = None,
    ) -> dict:
        payload: dict = {"session_id": session_id}
        if annotations:
            payload["annotations"] = annotations
        if metadata:
            payload["metadata"] = metadata
        if memory_blocks_ttl is not None:
            payload["memory_blocks_ttl"] = memory_blocks_ttl
        resp = self._client.post(f"/users/{user_id}/sessions", json=payload)
        self._raise_on_error(resp)
        return resp.json()

    def get_session(self, user_id: str, session_id: str) -> dict:
        resp = self._client.get(f"/users/{user_id}/sessions/{session_id}")
        self._raise_on_error(resp)
        return resp.json()

    def end_session(self, user_id: str, session_id: str) -> dict:
        resp = self._client.post(f"/users/{user_id}/sessions/{session_id}/end")
        self._raise_on_error(resp)
        return resp.json()

    def delete_session(self, user_id: str, session_id: str) -> None:
        resp = self._client.delete(f"/users/{user_id}/sessions/{session_id}")
        self._raise_on_error(resp)

    def list_sessions(self, user_id: str) -> dict:
        resp = self._client.get(f"/users/{user_id}/sessions")
        self._raise_on_error(resp)
        return resp.json()

    # --- Memory ---

    def add_memory(
        self,
        user_id: str,
        session_id: str,
        messages: Optional[List[Dict[str, str]]] = None,
        facts: Optional[List[str]] = None,
        annotations: Optional[Dict[str, str]] = None,
        async_processing: bool = True,
        memory_block_ttl: Optional[int] = None,
        context_required: Optional[bool] = None,
    ) -> dict:
        payload: dict = {"async_processing": async_processing}
        if messages:
            payload["messages"] = messages
        if facts:
            payload["facts"] = facts
        if annotations:
            payload["annotations"] = annotations
        if memory_block_ttl is not None:
            payload["memory_block_ttl"] = memory_block_ttl
        if context_required is not None:
            payload["context_required"] = context_required
        resp = self._client.post(
            f"/users/{user_id}/sessions/{session_id}/memory", json=payload
        )
        self._raise_on_error(resp)
        return resp.json()

    def search_memory(
        self,
        user_id: str,
        session_id: str,
        query: Optional[str] = None,
        filters: Optional[dict] = None,
    ) -> dict:
        payload: dict = {}
        if query:
            payload["query"] = query
        if filters:
            payload["filters"] = filters
        resp = self._client.post(
            f"/users/{user_id}/sessions/{session_id}/memory/search", json=payload
        )
        self._raise_on_error(resp)
        return resp.json()

    def delete_memory(
        self,
        user_id: str,
        session_id: str,
        block_ids: Any = "all",
    ) -> dict:
        resp = self._client.request(
            "DELETE",
            f"/users/{user_id}/sessions/{session_id}/memory",
            json={"block_ids": block_ids},
        )
        self._raise_on_error(resp)
        return resp.json()

    def list_memories(
        self,
        user_id: str,
        session_ids: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        params: dict = {"limit": limit, "offset": offset}
        if session_ids:
            params["session_ids"] = session_ids
        resp = self._client.get(f"/users/{user_id}/memory", params=params)
        self._raise_on_error(resp)
        return resp.json()


class AsyncAMSClient:
    """Async HTTP client for the AgentMem Server REST API. Used by the swarm for true concurrency."""

    def __init__(
        self,
        base_url: str = DEFAULT_AMS_URL,
        token: Optional[str] = None,
        timeout: float = DEFAULT_ASYNC_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        pool_limits = httpx.Limits(
            max_connections=500,
            max_keepalive_connections=100,
            keepalive_expiry=30,
        )
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            limits=pool_limits,
        )

    async def close(self):
        await self._client.aclose()

    def _raise_on_error(self, resp: httpx.Response):
        if resp.status_code >= 400:
            detail = resp.text
            try:
                detail = resp.json()
            except Exception:
                pass
            raise AMSError(resp.status_code, detail)

    async def create_user(self, user_id: str, name: str, metadata: Optional[Dict[str, Any]] = None) -> dict:
        payload = {"user_id": user_id, "name": name}
        if metadata:
            payload["metadata"] = metadata
        resp = await self._client.post("/users", json=payload)
        self._raise_on_error(resp)
        return resp.json()

    async def delete_user(self, user_id: str) -> None:
        resp = await self._client.delete(f"/users/{user_id}")
        self._raise_on_error(resp)

    async def create_session(
        self, user_id: str, session_id: str,
        annotations: Optional[Dict[str, str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> dict:
        payload: dict = {"session_id": session_id}
        if annotations:
            payload["annotations"] = annotations
        if metadata:
            payload["metadata"] = metadata
        resp = await self._client.post(f"/users/{user_id}/sessions", json=payload)
        self._raise_on_error(resp)
        return resp.json()

    async def add_memory(
        self, user_id: str, session_id: str,
        messages: Optional[List[Dict[str, str]]] = None,
        facts: Optional[List[str]] = None,
        annotations: Optional[Dict[str, str]] = None,
        async_processing: bool = True,
        context_required: Optional[bool] = None,
    ) -> dict:
        payload: dict = {"async_processing": async_processing}
        if messages:
            payload["messages"] = messages
        if facts:
            payload["facts"] = facts
        if annotations:
            payload["annotations"] = annotations
        if context_required is not None:
            payload["context_required"] = context_required
        resp = await self._client.post(
            f"/users/{user_id}/sessions/{session_id}/memory", json=payload
        )
        self._raise_on_error(resp)
        return resp.json()


class AMSError(Exception):
    def __init__(self, status_code: int, detail: Any):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"AMS HTTP {status_code}: {detail}")
