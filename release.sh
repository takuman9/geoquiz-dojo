#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

GCLOUD_BIN=${GCLOUD_BIN:-$(command -v gcloud || echo /usr/local/share/google-cloud-sdk/bin/gcloud)}
PROJECT_ID=${PROJECT_ID:-$($GCLOUD_BIN config get-value project 2>/dev/null || true)}
REGION=${REGION:-asia-northeast1}
SERVICE_NAME=${SERVICE_NAME:-geoquiz-dojo}

if [ -z "${PROJECT_ID}" ]; then
  echo "ERROR: Google Cloud project is not configured. Run 'gcloud config set project <PROJECT_ID>' first." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $SCRIPT_DIR" >&2
  exit 1
fi

read_env() {
  local key="$1"
  local value
  value=$(grep -E "^${key}=" .env | head -n 1 | cut -d= -f2- | tr -d '\r')
  printf '%s' "${value:-}"
}

GEMINI_API_KEY=${GEMINI_API_KEY:-$(read_env "GEMINI_API_KEY")}
ADMIN_TOKEN=${ADMIN_TOKEN:-$(read_env "ADMIN_TOKEN")}
GEN_MODEL=${GEN_MODEL:-$(read_env "GEN_MODEL")}
EMB_MODEL=${EMB_MODEL:-$(read_env "EMB_MODEL")}

GEN_MODEL=${GEN_MODEL:-gemini-3.5-flash}
EMB_MODEL=${EMB_MODEL:-gemini-embedding-001}

if [ -n "${GEMINI_API_KEY}" ]; then
  if ! "$GCLOUD_BIN" secrets describe gemini-api-key >/dev/null 2>&1; then
    printf '%s' "$GEMINI_API_KEY" | "$GCLOUD_BIN" secrets create gemini-api-key --data-file=- >/dev/null
  fi
  printf '%s' "$GEMINI_API_KEY" | "$GCLOUD_BIN" secrets versions add gemini-api-key --data-file=- >/dev/null
else
  echo "WARN: GEMINI_API_KEY is empty in .env; deployment will continue only if the secret already exists." >&2
fi

if [ -n "${ADMIN_TOKEN}" ]; then
  if ! "$GCLOUD_BIN" secrets describe admin-token >/dev/null 2>&1; then
    printf '%s' "$ADMIN_TOKEN" | "$GCLOUD_BIN" secrets create admin-token --data-file=- >/dev/null
  fi
  printf '%s' "$ADMIN_TOKEN" | "$GCLOUD_BIN" secrets versions add admin-token --data-file=- >/dev/null
else
  echo "WARN: ADMIN_TOKEN is empty in .env; admin page will not be authenticated unless already configured." >&2
fi

if ! "$GCLOUD_BIN" services list --enabled --filter="firestore.googleapis.com" >/dev/null 2>&1; then
  "$GCLOUD_BIN" services enable firestore.googleapis.com >/dev/null
fi

if ! "$GCLOUD_BIN" firestore databases list --format='value(name)' 2>/dev/null | grep -q 'projects/.*/databases/(default)'; then
  "$GCLOUD_BIN" firestore databases create --location="$REGION" --database='(default)' >/dev/null
fi

SERVICE_ACCOUNT=$($GCLOUD_BIN run services describe "$SERVICE_NAME" --region "$REGION" --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)
if [ -n "${SERVICE_ACCOUNT}" ]; then
  "$GCLOUD_BIN" projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role=roles/secretmanager.secretAccessor \
    >/dev/null
fi

"$GCLOUD_BIN" run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest,ADMIN_TOKEN=admin-token:latest \
  --set-env-vars=GEN_MODEL="$GEN_MODEL",EMB_MODEL="$EMB_MODEL"

"$GCLOUD_BIN" run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)'
