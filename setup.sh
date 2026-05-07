
#!/usr/bin/env bash
# Bootstrap script: create venv, install deps, generate secrets, scaffold .env.
set -euo pipefail
cd "$(dirname "$0")"

# --- Pick best available Python ---
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "ERROR: no python3 interpreter found on PATH" >&2
  exit 1
fi
echo "Using $($PYTHON --version) at $(command -v $PYTHON)"

# --- Create venv ---
if [ ! -d ".venv" ]; then
  $PYTHON -m venv .venv
  echo "Created .venv"
fi
# shellcheck disable=SC1091
. .venv/bin/activate

# --- Install deps ---
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
echo "Installed Python dependencies"

# --- Scaffold .env if missing ---
if [ ! -f ".env" ]; then
  cp .env.example .env
  ENC_KEY=$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')
  JWT_SECRET=$(python -c 'import secrets; print(secrets.token_urlsafe(64))')
  # macOS sed needs an empty backup-ext arg for in-place editing
  sed -i.bak "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=${ENC_KEY}|" .env
  sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
  rm -f .env.bak
  echo ""
  echo "Created .env with auto-generated APP_ENCRYPTION_KEY + JWT_SECRET."
  echo ""
  echo "BEFORE STARTING: edit .env and add the three required market-data API keys:"
  echo "  - ALPHA_VANTAGE_KEY        https://www.alphavantage.co/support/#api-key"
  echo "  - OPEN_EXCHANGE_RATES_KEY  https://openexchangerates.org/signup/free"
  echo "  - FRED_KEY                 https://fred.stlouisfed.org/docs/api/api_key.html"
  echo ""
  echo "Optional:"
  echo "  - ANTHROPIC_API_KEY        global fallback for the AI chatbot"
  echo "                             (users can also set their own key in Settings)"
fi

echo ""
echo "Setup complete. To run the app:"
echo "  source .venv/bin/activate"
echo "  python seed_data.py        # optional: populate demo data"
echo "  uvicorn main:app --reload  # then open http://localhost:8000"
/run
