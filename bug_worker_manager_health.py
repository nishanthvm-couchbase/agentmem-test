"""
Bug reproduction: SDK health_ping() calls GET /health/worker-manager
but the AMS server exposes GET /health/async-batch-processor.
The endpoint name mismatch causes a 404, making overall health report 'degraded'
even when the server is fully operational.
"""

import httpx
from agentmem import AgentMemClient

AMS_URL = "http://localhost:8080"

print("=" * 60)
print("1. Raw HTTP — what the server actually exposes")
print("=" * 60)

with httpx.Client(base_url=AMS_URL) as http:
    for path in [
        "/health",
        "/health/couchbase",
        "/health/models",
        "/health/async-batch-processor",   # server's actual endpoint
        "/health/worker-manager",           # SDK's expected endpoint
        "/health/memory",
    ]:
        resp = http.get(path)
        print(f"  GET {path:45s} → {resp.status_code}")

print()
print("=" * 60)
print("2. SDK health_ping(entity='worker_manager')")
print("=" * 60)

client = AgentMemClient(base_url=AMS_URL)
try:
    result = client.health_ping(entity="worker_manager")
    print(f"  status: {result}")
except Exception as e:
    print(f"  ERROR: {type(e).__name__}: {e}")

print()
print("=" * 60)
print("3. SDK health_ping() — all entities (shows degraded)")
print("=" * 60)

try:
    result = client.health_ping()
    print(f"  overall_status : {result.overall_status}")
    print(f"  checked_entities: {result.checked_entities}")
    print(f"  worker_manager  : {result.worker_manager}")
except Exception as e:
    print(f"  ERROR: {type(e).__name__}: {e}")

client.close()
