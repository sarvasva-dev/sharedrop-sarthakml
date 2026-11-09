#!/usr/bin/env bash
# ==============================================================================
# ShareDrop (sharedrop.sarthakml.in) — Cloudflare Tunnel Exposer & DNS Helper
# ==============================================================================
# Exposes local port 3000 to https://sharedrop.sarthakml.in (or a quick trycloudflare tunnel)
# Supports:
#   1) Quick ad-hoc public URL: bash scripts/deploy-tunnel.sh --quick
#   2) Named Cloudflare Tunnel: bash scripts/deploy-tunnel.sh --name sharedrop-tunnel
#   3) Direct run with existing token: TUNNEL_TOKEN=xxx bash scripts/deploy-tunnel.sh
# ==============================================================================
set -euo pipefail

PORT="${PORT:-3000}"
TARGET_DOMAIN="${DOMAIN:-sharedrop.sarthakml.in}"
CLOUDFLARED_BIN="$(command -v cloudflared || echo "/home/sarvasva/.local/bin/cloudflared")"

BOLD="\033[1m"
ORANGE="\033[38;5;208m"
TEAL="\033[38;5;37m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

banner() {
  echo -e "${BOLD}${ORANGE}╭──────────────────────────────────────────────────────────────╮${RESET}"
  echo -e "${BOLD}${ORANGE}│   ShareDrop Cloudflare Tunnel Deployment & Ingress Bridge    │${RESET}"
  echo -e "${BOLD}${ORANGE}│   Target Host: https://${TARGET_DOMAIN}                  │${RESET}"
  echo -e "${BOLD}${ORANGE}╰──────────────────────────────────────────────────────────────╯${RESET}"
}

check_prerequisites() {
  if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
    echo -e "${RED}Error:${RESET} cloudflared binary not found at '$CLOUDFLARED_BIN' or in PATH."
    echo -e "Install via: ${TEAL}curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared${RESET}"
    exit 1
  fi

  if ! curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo -e "${YELLOW}Warning:${RESET} Local ShareDrop server is not responding at http://localhost:${PORT}."
    echo -e "Make sure to start the server: ${TEAL}bun run start${RESET} or ${TEAL}node src/server/index.js${RESET}"
  else
    echo -e "${GREEN}✓${RESET} Local ShareDrop instance healthy at http://localhost:${PORT}"
  fi
}

start_quick_tunnel() {
  banner
  check_prerequisites
  echo -e "\n${BOLD}[1/2] Starting Quick Ephemeral Cloudflare Tunnel${RESET} (port ${PORT})..."
  echo -e "${dim:-}A temporary trycloudflare.com URL will be provisioned.${RESET}\n"

  exec "$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}"
}

start_token_tunnel() {
  local token="$1"
  banner
  check_prerequisites
  echo -e "\n${BOLD}[1/2] Running Pre-configured Cloudflare Tunnel Token${RESET}"
  echo -e "Routing traffic to ${TEAL}http://localhost:${PORT}${RESET} -> ${GREEN}https://${TARGET_DOMAIN}${RESET}\n"

  exec "$CLOUDFLARED_BIN" tunnel run --token "$token"
}

setup_named_tunnel() {
  local tunnel_name="${1:-sharedrop-tunnel}"
  banner
  check_prerequisites

  echo -e "\n${BOLD}[1/4] Checking Cloudflare Login & Credentials${RESET}"
  if ! "$CLOUDFLARED_BIN" tunnel list >/dev/null 2>&1; then
    echo -e "${YELLOW}Please authenticate cloudflared first:${RESET}"
    "$CLOUDFLARED_BIN" tunnel login
  fi

  echo -e "\n${BOLD}[2/4] Ensuring Named Tunnel Exists (${tunnel_name})${RESET}"
  if ! "$CLOUDFLARED_BIN" tunnel list | grep -q "$tunnel_name"; then
    echo -e "Creating tunnel ${TEAL}${tunnel_name}${RESET}..."
    "$CLOUDFLARED_BIN" tunnel create "$tunnel_name"
  else
    echo -e "${GREEN}✓${RESET} Tunnel ${TEAL}${tunnel_name}${RESET} already exists."
  fi

  echo -e "\n${BOLD}[3/4] Routing DNS CNAME for ${TARGET_DOMAIN}${RESET}"
  echo -e "Binding ${TARGET_DOMAIN} to tunnel ${tunnel_name}..."
  "$CLOUDFLARED_BIN" tunnel route dns -f "$tunnel_name" "$TARGET_DOMAIN" || {
    echo -e "${YELLOW}Notice:${RESET} If ${TARGET_DOMAIN} DNS is managed via Netlify or custom DNS,"
    echo -e "add a CNAME record in your Netlify DNS panel pointing '${TARGET_DOMAIN}' to:"
    echo -e "  ${TEAL}<TUNNEL-UUID>.cfargotunnel.com${RESET}"
  }

  echo -e "\n${BOLD}[4/4] Starting Tunnel Ingress to http://localhost:${PORT}${RESET}"
  exec "$CLOUDFLARED_BIN" tunnel run --url "http://localhost:${PORT}" "$tunnel_name"
}

usage() {
  banner
  cat <<EOF

USAGE:
  bash scripts/deploy-tunnel.sh [options]

OPTIONS:
  --quick                 Start an instant ephemeral trycloudflare.com tunnel
  --token <TUNNEL_TOKEN>  Run a persistent tunnel using a Cloudflare zero-trust token
  --named [tunnel-name]   Configure and run a named tunnel (default: sharedrop-tunnel)
  --port <number>         Specify local port to expose (default: 3000)
  --domain <domain>       Specify target domain (default: sharedrop.sarthakml.in)
  -h, --help              Show this help message

ENVIRONMENT VARIABLES:
  TUNNEL_TOKEN            Cloudflare Tunnel token (runs token mode automatically if set)
  PORT                    Local port to expose (default: 3000)
  DOMAIN                  Target domain (default: sharedrop.sarthakml.in)

EXAMPLES:
  # Instant quick tunnel for local testing
  bash scripts/deploy-tunnel.sh --quick

  # Deploy to sharedrop.sarthakml.in with zero-trust token
  TUNNEL_TOKEN="eyJh..." bash scripts/deploy-tunnel.sh

  # Setup named tunnel for sharedrop.sarthakml.in
  bash scripts/deploy-tunnel.sh --named sharedrop-prod
EOF
}

# Auto-dispatch if TUNNEL_TOKEN is set in environment
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  start_token_tunnel "$TUNNEL_TOKEN"
  exit 0
fi

MODE=""
ARG_VALUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      MODE="quick"
      shift
      ;;
    --token)
      MODE="token"
      ARG_VALUE="${2:-}"
      shift 2
      ;;
    --named)
      MODE="named"
      ARG_VALUE="${2:-sharedrop-tunnel}"
      shift 2
      ;;
    --port)
      PORT="${2:-3000}"
      shift 2
      ;;
    --domain)
      TARGET_DOMAIN="${2:-sharedrop.sarthakml.in}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option:${RESET} $1"
      usage
      exit 1
      ;;
  esac
done

case "$MODE" in
  quick)
    start_quick_tunnel
    ;;
  token)
    if [[ -z "$ARG_VALUE" ]]; then
      echo -e "${RED}Error:${RESET} --token requires a token argument"
      exit 1
    fi
    start_token_tunnel "$ARG_VALUE"
    ;;
  named)
    setup_named_tunnel "$ARG_VALUE"
    ;;
  *)
    # Default to quick tunnel if no mode specified
    start_quick_tunnel
    ;;
esac
