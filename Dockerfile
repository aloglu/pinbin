# --- Stage 1: build the stylesheet (app/static/tailwind.css) ---
FROM node:22-alpine AS css

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tailwind.config.js ./
COPY app/static/ ./app/static/
RUN npm run build:css

# --- Stage 2: the app ---
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install Pillow runtime dependencies if needed (wheels include libs, but ca-certificates is essential for HTTPS/JWKS)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY --from=css /build/app/static/tailwind.css ./app/static/tailwind.css
COPY seed.json ./seed.json

RUN mkdir -p /data/images

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
