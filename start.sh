#!/usr/bin/env bash
# AgentMem Demo — single-command startup
# Usage: ./start.sh [--no-docker]   (--no-docker skips docker compose, useful if AMS is already running)

set -uo pipefail

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMS_DIR="$(cd "$SCRIPT_DIR/../agentmem" && pwd)"
UI_DIR="$SCRIPT_DIR/agentmem-test-ui"
VENV_DIR="$SCRIPT_DIR/env"
ENV_FILE="$SCRIPT_DIR/.env"

AMS_HEALTH="http://localhost:8080/health"
TESTER_HEALTH="http://localhost:8000/api/health"
UI_URL="http://localhost:3000"
TESTER_PORT=8000
UI_PORT=3000

SKIP_DOCKER=false
[[ "${1:-}" == "--no-docker" ]] && SKIP_DOCKER=true

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

step()  { echo -e "\n${BOLD}${BLUE}[$1/4]${RESET} $2"; }
ok()    { echo -e "      ${GREEN}✓${RESET}  $1"; }
info()  { echo -e "      ${DIM}→${RESET}  $1"; }
warn()  { echo -e "      ${YELLOW}⚠${RESET}  $1"; }
die()   { echo -e "\n      ${RED}✗  $1${RESET}\n"; exit 1; }

# ── PID tracking for cleanup ─────────────────────────────────────────────────
CHILD_PIDS=()

cleanup() {
  echo -e "\n\n${BOLD}Shutting down...${RESET}"
  for pid in "${CHILD_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ "$SKIP_DOCKER" == false ]]; then
    info "Stopping Docker services..."
    (cd "$AMS_DIR" && docker compose down --timeout 10 2>/dev/null) || true
  fi
  echo -e "${GREEN}Done.${RESET}\n"
}
trap cleanup EXIT INT TERM

# ── Helpers ──────────────────────────────────────────────────────────────────
wait_for() {
  local url="$1" label="$2" timeout="${3:-90}"
  local elapsed=0 interval=3
  info "Waiting for $label..."
  while ! curl -sf "$url" > /dev/null 2>&1; do
    sleep $interval
    elapsed=$((elapsed + interval))
    printf "      ${DIM}  %ds...${RESET}\r" "$elapsed"
    if [[ $elapsed -ge $timeout ]]; then
      die "$label did not respond within ${timeout}s. Check logs."
    fi
  done
  printf "                     \r"   # clear the timer line
  ok "$label is ready"
}

port_in_use() { lsof -ti :"$1" > /dev/null 2>&1; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${RED}${BOLD}AgentMem${RESET}${BOLD} Demo${RESET}"
echo -e "  ${DIM}────────────────────────────────${RESET}"
echo ""

# ── Preflight checks ─────────────────────────────────────────────────────────
if [[ "$SKIP_DOCKER" == false ]]; then
  command -v docker > /dev/null 2>&1 || die "docker not found. Install Docker Desktop first."
  docker info > /dev/null 2>&1       || die "Docker daemon is not running. Start Docker Desktop."
fi
command -v python3.12 > /dev/null 2>&1 || die "python3.12 not found."
command -v node > /dev/null 2>&1       || die "node not found. Install Node.js."

if [[ -f "$ENV_FILE" ]]; then
  # Load OPENAI_API_KEY from .env only if not already in env
  set -a; source "$ENV_FILE" 2>/dev/null || true; set +a
fi
[[ -n "${OPENAI_API_KEY:-}" ]] || warn "OPENAI_API_KEY is not set — chat will fail. Export it in ~/.zshrc."

# ── Step 1: AMS Server ───────────────────────────────────────────────────────
step 1 "AgentMem Server  (Docker)"
if [[ "$SKIP_DOCKER" == true ]]; then
  ok "Skipped (--no-docker)"
else
  info "Running docker compose up -d..."
  (cd "$AMS_DIR" && docker compose up -d 2>&1) | grep -E "Started|Running|Creating|healthy|Warning|Error" || true
  wait_for "$AMS_HEALTH" "AMS Server" 120
fi

# ── Step 2: Python venv + dependencies ───────────────────────────────────────
step 2 "Python environment"
if [[ ! -d "$VENV_DIR" ]]; then
  info "Creating virtualenv with python3.12..."
  python3.12 -m venv "$VENV_DIR" || die "Failed to create virtualenv."
  ok "Virtualenv created at env/"
else
  ok "Virtualenv exists (env/)"
fi

info "Installing/verifying requirements..."
"$VENV_DIR/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt" \
  || die "pip install failed. Check requirements.txt."
ok "Requirements ready"

# ── Step 3: Test framework (uvicorn) ─────────────────────────────────────────
step 3 "Test Framework API  (uvicorn :$TESTER_PORT)"
if port_in_use $TESTER_PORT; then
  warn "Port $TESTER_PORT already in use — assuming tester is running, skipping."
else
  (cd "$SCRIPT_DIR" && "$VENV_DIR/bin/uvicorn" main:app \
    --host 0.0.0.0 --port $TESTER_PORT \
    --log-level warning \
    > "$SCRIPT_DIR/logs/tester.log" 2>&1) &
  CHILD_PIDS+=($!)
  wait_for "$TESTER_HEALTH" "Tester API" 30
fi

# ── Step 4: Next.js UI ───────────────────────────────────────────────────────
step 4 "UI  (Next.js :$UI_PORT)"
if port_in_use $UI_PORT; then
  warn "Port $UI_PORT already in use — assuming UI is running, skipping."
else
  info "Running npm run dev..."
  (cd "$UI_DIR" && npm run dev 2>&1) &
  CHILD_PIDS+=($!)
  wait_for "$UI_URL" "UI" 60
fi

# ── All ready ────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}All systems ready!${RESET}"
echo -e "  ${DIM}────────────────────────────────${RESET}"
echo -e "  ${BOLD}UI${RESET}          →  ${BOLD}$UI_URL${RESET}"
echo -e "  Tester API  →  http://localhost:$TESTER_PORT"
echo -e "  AMS Server  →  http://localhost:8080"
echo ""
echo -e "  ${DIM}Press Ctrl+C to stop everything.${RESET}"
echo ""

# ── Open browser (macOS) ─────────────────────────────────────────────────────
if command -v open > /dev/null 2>&1; then
  sleep 1 && open "$UI_URL" &
fi

# Keep script alive so Ctrl+C triggers cleanup
wait "${CHILD_PIDS[@]}" 2>/dev/null || true
