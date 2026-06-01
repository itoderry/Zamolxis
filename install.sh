#!/usr/bin/env bash
# Zamolxis installer (Linux/macOS).
#   bash install.sh             # install + build
#   bash install.sh --web       # also enable the browser UI
#   bash install.sh --web --open# enable web UI and launch it now
#   bash install.sh --service   # also print systemd setup
#   bash install.sh --local         # offer a menu of local models that fit this machine, then install your pick (asks first)
#   bash install.sh --local --yes   # install the recommended model without prompting (unattended)
#   bash install.sh --local --bigger# default the menu to the largest model that still fits the GPU/RAM
#   bash install.sh --local --force # offer/install even if the machine is below the recommended bar
#   bash install.sh --skip-build
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=0
SKIP_BUILD=0
WEB=0
OPEN=0
LOCAL=0
BIGGER=0
ASSUME_YES=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --service) SERVICE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --web) WEB=1 ;;
    --open) OPEN=1 ;;
    --local) LOCAL=1 ;;
    --bigger) BIGGER=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
  esac
done
set_env() { # set_env KEY VALUE  (replace existing line, commented or not, else append)
  if grep -qE "^#?[[:space:]]*$1=" .env; then
    sed -i.bak -E "s|^#?[[:space:]]*$1=.*|$1=$2|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

step() { printf '\n==> %s\n' "$1"; }
warn() { printf '    ! %s\n' "$1"; }

step "Checking prerequisites"
# Record what was already present, so we only auto-install (and later uninstall) what we add.
GIT_WAS_ABSENT=0; command -v git >/dev/null 2>&1 || GIT_WAS_ABSENT=1
NODE_WAS_ABSENT=0; command -v node >/dev/null 2>&1 || NODE_WAS_ABSENT=1
CLAUDE_WAS_ABSENT=0; command -v claude >/dev/null 2>&1 || CLAUDE_WAS_ABSENT=1

OSx=linux; [ "$(uname)" = "Darwin" ] && OSx=mac
if command -v brew >/dev/null 2>&1; then PM=brew
elif command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
elif command -v pacman >/dev/null 2>&1; then PM=pacman
elif command -v zypper >/dev/null 2>&1; then PM=zypper
else PM=none; fi
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
pkg_install() {
  case "$PM" in
    brew) brew install "$@" ;;
    apt) $SUDO apt-get update -y && $SUDO apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    yum) $SUDO yum install -y "$@" ;;
    pacman) $SUDO pacman -S --noconfirm "$@" ;;
    zypper) $SUDO zypper install -y "$@" ;;
    *) warn "No supported package manager found - install $* manually."; return 1 ;;
  esac
}

# git - needed to clone and for the built-in self-update.
if [ "$GIT_WAS_ABSENT" -eq 1 ]; then step "Installing git"; pkg_install git || warn "Could not install git automatically (https://git-scm.com)."; fi

# Node.js 20+ - required to build and run.
need_node=1
if command -v node >/dev/null 2>&1; then
  NM="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NM" -ge 20 ]; then need_node=0; else warn "Node $(node -v) is too old; need 20+."; fi
fi
if [ "$need_node" -eq 1 ]; then
  step "Installing Node.js"
  if [ "$OSx" = mac ]; then pkg_install node || true; else pkg_install nodejs npm || true; fi
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ not found and auto-install failed. Install it (https://nodejs.org or nvm) and re-run."; exit 1; }
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $(node -v) is too old; need 20+. Install Node 20+ via nvm/nodesource and re-run."; exit 1; }
echo "    Node $(node -v)"

# Node is now present, so the manifest helper (which uses node) is usable from here on.
DATA_DIR="${ZAMOLXIS_DATA_DIR:-$HOME/.zamolxis}"; MANIFEST="$DATA_DIR/install-manifest.json"
mark_installed() { # key value(true|false|string) - records what THIS installer added
  mkdir -p "$DATA_DIR"
  node -e 'const fs=require("fs");const p=process.argv[1];let m={};try{m=JSON.parse(fs.readFileSync(p))}catch(e){}; m.installed=m.installed||{}; const v=process.argv[3]; m.installed[process.argv[2]]=(v==="true")?true:(v==="false"?false:v); m.updatedAt=new Date().toISOString(); fs.writeFileSync(p,JSON.stringify(m,null,2));' "$MANIFEST" "$1" "$2" 2>/dev/null || true
}
if [ "$GIT_WAS_ABSENT" -eq 1 ] && command -v git >/dev/null 2>&1; then echo "    git installed"; mark_installed git true; fi
[ "$NODE_WAS_ABSENT" -eq 1 ] && mark_installed node true

# Claude Code CLI - the engine Zamolxis runs on (subscription via 'claude login').
if ! command -v claude >/dev/null 2>&1; then step "Installing Claude Code CLI (npm)"; npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true; fi
if command -v claude >/dev/null 2>&1; then
  [ "$CLAUDE_WAS_ABSENT" -eq 1 ] && mark_installed claudeCode true
  if [ ! -f "$HOME/.claude/.credentials.json" ]; then warn "Claude Code is installed. Run 'claude login' with your Pro/Max account before starting."; else echo "    Claude credentials found"; fi
else
  warn "Could not auto-install the Claude Code CLI. Install it, then run 'claude login' (Pro/Max) for subscription auth."
fi

step "Installing dependencies (npm)"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  step "Building (tsc)"
  npm run build
fi

step "Bundled skills"
if [ -d skills-seed ]; then
  n=$(find skills-seed -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')
  echo "    $n skill(s) bundled - they seed into your skills dir automatically on first run."
else
  warn "skills-seed folder missing - no skills will be seeded."
fi
if [ -d "$HOME/.hermeslite/skills" ] || [ -d "$HOME/Library/Application Support/hermes/hermes-agent/skills" ] || [ -d "$HOME/.config/hermes/hermes-agent/skills" ]; then
  echo "    Hermes skill library detected - its skills are auto-discovered; browse + Import them in the web Skills panel."
fi

step "Configuration"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    Created .env from .env.example"
  warn "Edit .env to enable messaging channels (ZAMOLXIS_CHANNEL_*) and add their tokens."
else
  echo "    .env already exists (left as-is)"
fi

WEB_PORT="$(grep -oE 'ZAMOLXIS_WEB_PORT=[0-9]+' .env 2>/dev/null | head -1 | cut -d= -f2)"
WEB_PORT="${WEB_PORT:-8787}"
if [ "$WEB" -eq 1 ]; then
  step "Enabling web interface"
  if grep -q 'ZAMOLXIS_CHANNEL_WEB=' .env; then
    sed -i.bak 's/ZAMOLXIS_CHANNEL_WEB=false/ZAMOLXIS_CHANNEL_WEB=true/' .env && rm -f .env.bak
  else
    printf '\nZAMOLXIS_CHANNEL_WEB=true\n' >> .env
  fi
  echo "    Web channel enabled (local: http://127.0.0.1:$WEB_PORT)"
  warn "To reach it from other machines, set ZAMOLXIS_WEB_BIND and ZAMOLXIS_WEB_AUTH_TOKEN in .env."
fi

# Local model (free on-device offload for easy tasks)
step "Local model"
GPU_LABEL="none"; HAS_GPU=0; VRAM_GB=0
if [ "$(uname)" = "Darwin" ]; then
  RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  if [ "$(uname -m)" = "arm64" ]; then HAS_GPU=1; VRAM_GB=$RAM_GB; GPU_LABEL="Apple Silicon (Metal, unified ${RAM_GB}GB)"; fi  # unified memory
else
  RAM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1048576 ))
  if command -v nvidia-smi >/dev/null 2>&1; then
    MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    if [ -n "$MIB" ]; then HAS_GPU=1; VRAM_GB=$(( MIB / 1024 )); GPU_LABEL="$NAME (~${VRAM_GB}GB VRAM)"; fi
  elif command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qiE 'NVIDIA|Radeon|Advanced Micro Devices.*\[AMD/ATI\]'; then
    HAS_GPU=1; GPU_LABEL="$(lspci 2>/dev/null | grep -iE 'VGA|3D' | grep -iE 'NVIDIA|AMD|Radeon' | head -1 | sed 's/.*: //')"
  fi
fi
echo "    Detected: ${RAM_GB}GB RAM, GPU: $GPU_LABEL"
# Memory budget for sizing. GPU -> size to VRAM; CPU -> ~half the RAM (OS + slow CPU inference).
if [ "$HAS_GPU" -eq 1 ]; then EFFCAP=$VRAM_GB; else EFFCAP=$(( RAM_GB / 2 )); fi
# "Powerful enough" = a dedicated GPU (incl. Apple Silicon), or >=8GB system RAM. Below
# that a local model is too weak/slow to be worth it; don't install (even --local) sans --force.
CAPABLE=0; if [ "$HAS_GPU" -eq 1 ] || [ "$RAM_GB" -ge 8 ]; then CAPABLE=1; fi
[ "$HAS_GPU" -eq 1 ] && echo "    Dedicated GPU detected - models will be GPU-accelerated."

# Curated catalog (small -> large): id | approx GB to run the Q4 build comfortably | strength.
# We only OFFER the models that fit this machine, each with a one-line strength.
CAT_ID=( "qwen2.5:1.5b" "llama3.2:3b" "qwen2.5:3b" "qwen2.5-coder:7b" "qwen2.5:7b" "deepseek-r1:8b" "qwen2.5:14b" "qwen2.5-coder:14b" "qwen2.5:32b" )
CAT_NEED=( 2 4 4 6 6 7 10 10 22 )
CAT_STR=( "tiny & fast - fine for routing / simple offload" "fast, lightweight general chat; broad knowledge" "strong tool use for its size - solid small default" "tuned for code: generation, review, refactors" "best all-round: instruction following + tool use" "step-by-step reasoning & math (thinks first, slower)" "noticeably smarter, broader knowledge - slower" "strongest coding model that fits a large GPU" "smartest local option - needs a big GPU" )

FIT_ID=(); FIT_STR=()
for i in "${!CAT_ID[@]}"; do
  if [ "${CAT_NEED[$i]}" -le "$EFFCAP" ]; then FIT_ID+=( "${CAT_ID[$i]}" ); FIT_STR+=( "${CAT_STR[$i]}" ); fi
done
if [ "${#FIT_ID[@]}" -eq 0 ]; then FIT_ID=( "${CAT_ID[0]}" ); FIT_STR=( "${CAT_STR[0]}" ); fi
# Recommended = the largest general qwen2.5 that fits; --bigger shifts the default to the largest fit.
REC_ID=""
for id in "${FIT_ID[@]}"; do case "$id" in qwen2.5:*) REC_ID="$id" ;; esac; done
[ -z "$REC_ID" ] && REC_ID="${FIT_ID[$(( ${#FIT_ID[@]} - 1 ))]}"
if [ "$BIGGER" -eq 1 ]; then DEFAULT_ID="${FIT_ID[$(( ${#FIT_ID[@]} - 1 ))]}"; else DEFAULT_ID="$REC_ID"; fi

show_menu() {
  echo "    Local models that fit this machine (~${EFFCAP}GB budget):"
  for i in "${!FIT_ID[@]}"; do
    TAG=""; [ "${FIT_ID[$i]}" = "$REC_ID" ] && TAG="  <- recommended"
    printf "      [%d] %-17s %s%s\n" "$(( i + 1 ))" "${FIT_ID[$i]}" "${FIT_STR[$i]}" "$TAG"
  done
}

MODEL="$DEFAULT_ID"
SHOULD_INSTALL=0
if [ "$LOCAL" -eq 1 ]; then
  if [ "$CAPABLE" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
    warn "This machine isn't powerful enough for a useful local model (needs a dedicated GPU or >=8GB RAM)."
    warn "Skipping local-model install; the subscription will handle everything. Use --local --force to override."
  else
    [ "$CAPABLE" -eq 0 ] && warn "Below the recommended bar, but --force was given; offering small models anyway."
    show_menu
    # Ask the user to pick one before installing (a local model is a multi-GB download + service).
    if [ "$ASSUME_YES" -eq 1 ]; then
      SHOULD_INSTALL=1; echo "    --yes: installing the default model '$MODEL'."
    elif [ -t 0 ]; then
      printf "    Pick a model [1-%d, Enter = '%s', or 's' to skip]: " "${#FIT_ID[@]}" "$DEFAULT_ID"
      read -r ANS </dev/tty || ANS=""
      ANS="$(printf '%s' "$ANS" | tr -d '[:space:]')"
      if [ -z "$ANS" ]; then
        MODEL="$DEFAULT_ID"; SHOULD_INSTALL=1
      elif printf '%s' "$ANS" | grep -qiE '^(s|skip|n|no)$'; then
        echo "    Skipped local-model install."
      elif printf '%s' "$ANS" | grep -qE '^[0-9]+$' && [ "$ANS" -ge 1 ] && [ "$ANS" -le "${#FIT_ID[@]}" ]; then
        MODEL="${FIT_ID[$(( ANS - 1 ))]}"; SHOULD_INSTALL=1
      else
        FOUND=0
        for id in "${FIT_ID[@]}"; do [ "$id" = "$ANS" ] && { MODEL="$id"; FOUND=1; }; done
        if [ "$FOUND" -eq 1 ]; then SHOULD_INSTALL=1; else warn "Unrecognized choice '$ANS'; using default '$DEFAULT_ID'."; MODEL="$DEFAULT_ID"; SHOULD_INSTALL=1; fi
      fi
    else
      warn "Non-interactive shell and no --yes; skipping local-model install. Re-run with --local --yes to install the default unattended."
    fi
  fi
else
  if [ "$CAPABLE" -eq 1 ]; then
    show_menu
    echo "    Re-run with --local to choose one and set it up (Ollama + the model). Add --yes to take the recommended unattended."
  else
    echo "    This machine is below the bar for a useful local model; the subscription will handle everything."
    echo "    (--local --force would still let you pick a small one if you really want it.)"
  fi
fi

if [ "$SHOULD_INSTALL" -eq 1 ]; then
  OLLAMA_WAS_ABSENT=0; command -v ollama >/dev/null 2>&1 || OLLAMA_WAS_ABSENT=1
  if [ "$OLLAMA_WAS_ABSENT" -eq 1 ]; then
    step "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh || warn "Ollama install failed; install it from https://ollama.com and re-run with --local."
    command -v ollama >/dev/null 2>&1 && mark_installed ollama true
  fi
  if command -v ollama >/dev/null 2>&1; then
    step "Pulling model $MODEL (one-time download, ~1-2 GB)"
    ollama pull "$MODEL"
    mark_installed model "$MODEL"
    set_env ZAMOLXIS_LOCAL_MODEL "$MODEL"
    set_env ZAMOLXIS_LOCAL_MODEL_URL "http://localhost:11434/v1"
    echo "    Configured local model for easy-task offload: $MODEL"
  fi
fi

step "Readiness check"
node dist/index.js --doctor || warn "doctor reported issues (see above)"

if [ "$SERVICE" -eq 1 ]; then
  step "Service setup"
  echo "    See scripts/zamolxis.service for a systemd unit template."
  echo "    Run it in YOUR user context (not root) so ~/.claude credentials are available."
fi

echo
echo "Zamolxis installed."
echo "  Interactive:  npm run cli"
echo "  Web UI:       npm run web   then open http://127.0.0.1:$WEB_PORT"
echo "  Background:   npm start"
echo "  Re-check:     npm run doctor"

if [ "$WEB" -eq 1 ] && [ "$OPEN" -eq 1 ]; then
  step "Launching web interface"
  node --enable-source-maps dist/index.js --channels=web &
  sleep 3
  (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:$WEB_PORT") || (command -v open >/dev/null && open "http://127.0.0.1:$WEB_PORT") || true
  echo "    Web UI starting at http://127.0.0.1:$WEB_PORT"
fi
