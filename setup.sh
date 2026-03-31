#!/usr/bin/env bash
set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

ask() {
  local prompt="$1" default="$2" var
  if [ -n "$default" ]; then
    printf "${BOLD}%s${RESET} ${DIM}[%s]${RESET}: " "$prompt" "$default"
  else
    printf "${BOLD}%s${RESET}: " "$prompt"
  fi
  read -r var
  echo "${var:-$default}"
}

ask_secret() {
  local prompt="$1" var
  printf "${BOLD}%s${RESET}: " "$prompt"
  read -rs var
  echo
  echo "$var"
}

ask_yn() {
  local prompt="$1" default="${2:-y}" var
  printf "${BOLD}%s${RESET} ${DIM}[%s]${RESET}: " "$prompt" "$default"
  read -r var
  var="${var:-$default}"
  [[ "$var" =~ ^[Yy] ]]
}

echo
echo -e "${BOLD}Claude Web — setup${RESET}"
echo "-----------------------------------"
echo

# ── .env ──────────────────────────────────────────────────────────────────────

if [ -f .env ]; then
  echo -e "${YELLOW}A .env file already exists.${RESET}"
  if ! ask_yn "Overwrite it?"; then
    echo "Keeping existing .env."
    SKIP_ENV=1
  fi
fi

if [ -z "$SKIP_ENV" ]; then
  echo
  echo -e "${BOLD}Google OAuth credentials${RESET}"
  echo -e "${DIM}Get these from: https://console.cloud.google.com → APIs & Services → Credentials${RESET}"
  echo
  GOOGLE_CLIENT_ID=$(ask "Client ID")
  GOOGLE_CLIENT_SECRET=$(ask_secret "Client Secret")

  echo
  echo -e "${BOLD}Server URL${RESET}"
  echo -e "${DIM}The public URL of this server — must match the OAuth redirect URI.${RESET}"
  echo -e "${DIM}Use http://localhost:3000 for local development.${RESET}"
  echo
  BASE_URL=$(ask "Base URL" "http://localhost:3000")

  echo
  echo -e "${BOLD}Session secret${RESET}"
  if ask_yn "Generate one automatically?" "y"; then
    SESSION_SECRET=$(openssl rand -hex 32)
    echo -e "${DIM}Generated.${RESET}"
  else
    SESSION_SECRET=$(ask_secret "Session secret")
  fi

  echo
  echo -e "${BOLD}Super admin${RESET}"
  echo -e "${DIM}This Google account has permanent admin access and cannot be removed via the UI.${RESET}"
  echo
  SUPER_ADMIN_EMAIL=$(ask "Your Google email")

  echo
  echo -e "${BOLD}Port${RESET}"
  PORT=$(ask "Port" "3000")

  cat > .env <<EOF
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
BASE_URL=${BASE_URL}
SESSION_SECRET=${SESSION_SECRET}
SUPER_ADMIN_EMAIL=${SUPER_ADMIN_EMAIL}
PORT=${PORT}
EOF

  echo -e "${GREEN}✓ .env created${RESET}"
fi

# ── whitelist.json ────────────────────────────────────────────────────────────

echo
if [ -f whitelist.json ]; then
  echo -e "${YELLOW}whitelist.json already exists.${RESET}"
  if ! ask_yn "Overwrite it?"; then
    echo "Keeping existing whitelist.json."
    SKIP_WHITELIST=1
  fi
fi

if [ -z "$SKIP_WHITELIST" ]; then
  echo
  echo -e "${BOLD}Allowed users${RESET}"
  echo -e "${DIM}Enter the Google email addresses that should have access, one per line.${RESET}"
  echo -e "${DIM}Press Enter on an empty line when done.${RESET}"
  echo

  emails=()
  # Pre-populate with the super admin email if we just set it
  if [ -n "$SUPER_ADMIN_EMAIL" ]; then
    emails+=("$SUPER_ADMIN_EMAIL")
    echo -e "${DIM}(pre-filled your super admin email: ${SUPER_ADMIN_EMAIL})${RESET}"
  fi

  while true; do
    email=$(ask "Email (blank to finish)")
    [ -z "$email" ] && break
    emails+=("$email")
  done

  # Build JSON array
  json="["
  for i in "${!emails[@]}"; do
    [ $i -gt 0 ] && json+=", "
    json+="\"${emails[$i]}\""
  done
  json+="]"

  echo "$json" > whitelist.json
  echo -e "${GREEN}✓ whitelist.json created with ${#emails[@]} email(s)${RESET}"
fi

# ── npm install ───────────────────────────────────────────────────────────────

echo
if [ ! -d node_modules ]; then
  echo "Running npm install..."
  npm install
  echo -e "${GREEN}✓ Dependencies installed${RESET}"
else
  if ask_yn "node_modules exists. Run npm install anyway?"; then
    npm install
    echo -e "${GREEN}✓ Dependencies installed${RESET}"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo
echo -e "${GREEN}${BOLD}Setup complete.${RESET}"
echo
echo -e "Start the server with: ${BOLD}npm start${RESET}"
if [ -n "$BASE_URL" ]; then
  echo -e "Then open:             ${BOLD}${BASE_URL}${RESET}"
fi
echo
if [ -n "$BASE_URL" ] && [[ "$BASE_URL" != "http://localhost"* ]]; then
  echo -e "${YELLOW}Don't forget to add the OAuth redirect URI in Google Cloud Console:${RESET}"
  echo -e "  ${BOLD}${BASE_URL}/auth/google/callback${RESET}"
  echo
fi
