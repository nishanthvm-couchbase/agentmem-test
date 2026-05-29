import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from agentmemory import AgentMemoryClient, AsyncAgentMemoryClient

from routers import travel, swarm, validation, security

load_dotenv()

AMS_URL = os.getenv("AMS_URL", "http://localhost:8080")
AMS_TOKEN = os.getenv("AMS_TOKEN", None)
AMS_TIMEOUT = float(os.getenv("AMS_TIMEOUT", "30.0"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Initializing AgentMem Tester...")

    ams_client = AgentMemoryClient(base_url=AMS_URL, token=AMS_TOKEN, timeout=AMS_TIMEOUT)
    async_ams_client = AsyncAgentMemoryClient(base_url=AMS_URL, token=AMS_TOKEN, timeout=AMS_TIMEOUT)
    app.state.ams_client = ams_client
    app.state.async_ams_client = async_ams_client
    app.state.ams_base_url = AMS_URL

    try:
        health = ams_client.health_ping()
        print(f"AgentMem Server Status: {health.overall_status.value}")
    except Exception as e:
        print(f"WARNING: Failed to connect to AgentMem Server at {AMS_URL}: {e}")

    yield

    await async_ams_client.close()
    ams_client.close()


app = FastAPI(
    title="AgentMem Tester",
    description="Unified sandbox for testing AgentMem capabilities, load, and resilience.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(travel.router)
app.include_router(swarm.router)
app.include_router(validation.router)
app.include_router(security.router)


@app.get("/")
async def root():
    return {"message": "Welcome to the AgentMem Tester API"}


@app.get("/api/health")
async def api_health():
    ams_status = "unreachable"
    try:
        health = app.state.ams_client.health_ping()
        ams_status = health.overall_status.value
    except Exception:
        pass

    return {
        "tester_status": "ok",
        "agentmem_server_status": ams_status,
    }
