# Investment App — production image.
# Base: Python 3.11-slim (works with the requirements.txt; faster cold start than 3.9).
FROM python:3.11-slim

WORKDIR /app

# System deps: build-essential for cryptography wheels on edge cases,
# curl for the HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Cache pip layer separately from app code so dep installs only re-run when
# requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Now copy the app
COPY . .

# DATABASE_URL is supplied by the host (Render: from the Postgres service;
# Fly: from `fly secrets`). Falls back to a local SQLite file for `docker run`.
ENV DATABASE_URL=sqlite:///./app.db
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# Single worker because the in-process scheduler + SSE state must not be duplicated.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
