#!/usr/bin/env bash
set -euo pipefail

NAS_HOST="${NAS_HOST:-}"
NAS_USER="${NAS_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/mnt/user/appdata/komios}"
APP_PORT="${APP_PORT:-5173}"
WORKSPACE_PATH="${WORKSPACE_PATH:-/mnt/user}"
TRANSCODE_ACCEL="${TRANSCODE_ACCEL:-auto}"
USE_NVIDIA_GPU="${USE_NVIDIA_GPU:-0}"
APP_USERNAME="${APP_USERNAME:-admin}"
APP_PASSWORD="${APP_PASSWORD:-}"
PULL_BASE_IMAGE="${PULL_BASE_IMAGE:-0}"
VERIFY_REMOTE_PATHS="${VERIFY_REMOTE_PATHS:-0}"
REMOTE_STEP_TIMEOUT="${REMOTE_STEP_TIMEOUT:-60}"

usage() {
  cat <<'EOF'
Usage:
  NAS_HOST=192.168.1.100 ./deploy-unraid.sh

Optional environment variables:
  NAS_HOST=192.168.1.100
  NAS_USER=root
  REMOTE_DIR=/mnt/user/appdata/komios
  APP_PORT=5173
  WORKSPACE_PATH=/mnt/user
  TRANSCODE_ACCEL=auto
  USE_NVIDIA_GPU=0
  APP_USERNAME=admin
  APP_PASSWORD=(auto-generated on NAS when omitted)
  PULL_BASE_IMAGE=0
  VERIFY_REMOTE_PATHS=0
  REMOTE_STEP_TIMEOUT=60

Examples:
  NAS_HOST=192.168.1.100 ./deploy-unraid.sh
  NAS_HOST=192.168.1.100 APP_PORT=8088 WORKSPACE_PATH=/mnt/user/docs ./deploy-unraid.sh
  NAS_HOST=192.168.1.100 USE_NVIDIA_GPU=1 TRANSCODE_ACCEL=nvidia ./deploy-unraid.sh
  NAS_HOST=192.168.1.100 APP_USERNAME=alice APP_PASSWORD='change-this-password' ./deploy-unraid.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v ssh >/dev/null || { echo "missing command: ssh" >&2; exit 1; }
command -v scp >/dev/null || { echo "missing command: scp" >&2; exit 1; }
command -v tar >/dev/null || { echo "missing command: tar" >&2; exit 1; }
if [[ -z "$NAS_HOST" ]]; then
  echo "NAS_HOST is required. Example: NAS_HOST=192.168.1.100 ./deploy-unraid.sh" >&2
  exit 1
fi

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
ARCHIVE="$(mktemp -t komios.XXXXXX.tar.gz)"
REMOTE_ARCHIVE="/tmp/komios.tar.gz"

cleanup() {
  rm -f "$ARCHIVE"
}
trap cleanup EXIT

SSH_TARGET="${NAS_USER}@${NAS_HOST}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

echo "Packaging ${PROJECT_DIR}"
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='test-fixtures' \
  -czf "$ARCHIVE" \
  Dockerfile \
  docker-compose.yml \
  .dockerignore \
  package.json \
  package-lock.json \
  index.html \
  app.js \
  styles.css \
  dev-server.mjs \
  docs \
  README.md

echo "Checking SSH access to ${SSH_TARGET}"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "hostname >/dev/null"

if [[ "$VERIFY_REMOTE_PATHS" == "1" ]]; then
  echo "Checking remote write paths"
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "test -w /tmp && echo '/tmp is writable'; if command -v timeout >/dev/null 2>&1; then timeout 20 mkdir -p '$REMOTE_DIR'; else mkdir -p '$REMOTE_DIR'; fi; test -w '$REMOTE_DIR' && echo '$REMOTE_DIR is writable'"
fi

echo "Uploading archive"
scp "${SSH_OPTS[@]}" "$ARCHIVE" "${SSH_TARGET}:${REMOTE_ARCHIVE}"

echo "Deploying to ${REMOTE_DIR}"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "REMOTE_DIR='$REMOTE_DIR' REMOTE_ARCHIVE='$REMOTE_ARCHIVE' APP_PORT='$APP_PORT' WORKSPACE_PATH='$WORKSPACE_PATH' TRANSCODE_ACCEL='$TRANSCODE_ACCEL' USE_NVIDIA_GPU='$USE_NVIDIA_GPU' APP_USERNAME='$APP_USERNAME' APP_PASSWORD='$APP_PASSWORD' PULL_BASE_IMAGE='$PULL_BASE_IMAGE' REMOTE_STEP_TIMEOUT='$REMOTE_STEP_TIMEOUT' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

echo "[1/8] Extracting application files"
echo "  - ensuring remote directory: $REMOTE_DIR"
if command -v timeout >/dev/null 2>&1; then
  timeout "$REMOTE_STEP_TIMEOUT" mkdir -p "$REMOTE_DIR"
else
  mkdir -p "$REMOTE_DIR"
fi
echo "  - archive details: $REMOTE_ARCHIVE"
ls -lh "$REMOTE_ARCHIVE"
echo "  - extracting archive"
if command -v timeout >/dev/null 2>&1; then
  timeout "$REMOTE_STEP_TIMEOUT" tar -xzf "$REMOTE_ARCHIVE" -C "$REMOTE_DIR"
else
  tar -xzf "$REMOTE_ARCHIVE" -C "$REMOTE_DIR"
fi
echo "  - removing uploaded archive"
rm -f "$REMOTE_ARCHIVE"
echo "  - entering remote directory"
cd "$REMOTE_DIR"
echo "  - extracted files:"
ls -la

echo "[2/8] Preparing login settings"
if [[ -z "$APP_PASSWORD" ]]; then
  if [[ -f .app-password ]]; then
    APP_PASSWORD="$(cat .app-password)"
  else
    set +o pipefail
    APP_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    set -o pipefail
    printf '%s' "$APP_PASSWORD" > .app-password
    chmod 600 .app-password
  fi
fi

echo "[3/8] Writing environment file"
cat > .env <<EOF
APP_PORT=$APP_PORT
WORKSPACE_PATH=$WORKSPACE_PATH
TRANSCODE_ACCEL=$TRANSCODE_ACCEL
APP_USERNAME=$APP_USERNAME
APP_PASSWORD=$APP_PASSWORD
EOF

xml_escape() {
  local value="${1:-}"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_unraid_template() {
  local template_dir="/boot/config/plugins/dockerMan/templates-user"
  local template_file="${template_dir}/my-komios.xml"
  local extra_params=""
  local port_xml path_xml accel_xml username_xml password_xml remote_xml config_xml extra_xml

  if [[ ! -d /boot/config/plugins/dockerMan ]]; then
    echo "Unraid dockerMan template directory is not present; skipping template registration."
    return
  fi

  mkdir -p "$template_dir"
  if [[ -d /dev/dri ]]; then
    extra_params="${extra_params} --device=/dev/dri:/dev/dri"
  fi
  if [[ "$USE_NVIDIA_GPU" == "1" ]]; then
    extra_params="${extra_params} --gpus all -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility"
  fi

  port_xml="$(xml_escape "$APP_PORT")"
  path_xml="$(xml_escape "$WORKSPACE_PATH")"
  accel_xml="$(xml_escape "$TRANSCODE_ACCEL")"
  username_xml="$(xml_escape "$APP_USERNAME")"
  password_xml="$(xml_escape "$APP_PASSWORD")"
  remote_xml="$(xml_escape "$REMOTE_DIR")"
  config_xml="$(xml_escape "$REMOTE_DIR/data")"
  extra_xml="$(xml_escape "${extra_params# }")"

  cat > "$template_file" <<EOF
<?xml version="1.0"?>
<Container version="2">
  <Name>komios</Name>
  <Repository>komios:latest</Repository>
  <Registry/>
  <Network>bridge</Network>
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support/>
  <Project/>
  <Overview>KomiOS private NAS content desktop with document, media, and video progress support.</Overview>
  <Category>Productivity: MediaApp:Video</Category>
  <WebUI>http://[IP]:[PORT:5173]/</WebUI>
  <TemplateURL/>
  <Icon/>
  <ExtraParams>${extra_xml}</ExtraParams>
  <PostArgs/>
  <CPUset/>
  <DateInstalled>$(date +%s)</DateInstalled>
  <DonateText/>
  <DonateLink/>
  <Requires/>
  <Config Name="WebUI Port" Target="5173" Default="5173" Mode="tcp" Description="Web interface port" Type="Port" Display="always" Required="true" Mask="false">${port_xml}</Config>
  <Config Name="Workspace" Target="/workspace" Default="/mnt/user" Mode="rw" Description="Folder exposed to KomiOS" Type="Path" Display="always" Required="true" Mask="false">${path_xml}</Config>
  <Config Name="Config" Target="/config" Default="/mnt/user/appdata/komios/data" Mode="rw" Description="Persistent database and thumbnail cache" Type="Path" Display="always" Required="true" Mask="false">${config_xml}</Config>
  <Config Name="App Data" Target="/appdata" Default="/mnt/user/appdata/komios" Mode="rw" Description="Deployment directory used by the script" Type="Path" Display="advanced" Required="false" Mask="false">${remote_xml}</Config>
  <Config Name="PORT" Target="PORT" Default="5173" Mode="" Description="Container listen port" Type="Variable" Display="advanced" Required="true" Mask="false">5173</Config>
  <Config Name="WORKSPACE" Target="WORKSPACE" Default="/workspace" Mode="" Description="Container workspace path" Type="Variable" Display="advanced" Required="true" Mask="false">/workspace</Config>
  <Config Name="CONFIG_DIR" Target="CONFIG_DIR" Default="/config" Mode="" Description="Container config directory" Type="Variable" Display="advanced" Required="true" Mask="false">/config</Config>
  <Config Name="TRANSCODE_ACCEL" Target="TRANSCODE_ACCEL" Default="auto" Mode="" Description="Transcode acceleration: auto, nvidia, vaapi, intel, cpu" Type="Variable" Display="always" Required="false" Mask="false">${accel_xml}</Config>
  <Config Name="APP_USERNAME" Target="APP_USERNAME" Default="admin" Mode="" Description="Login username" Type="Variable" Display="always" Required="true" Mask="false">${username_xml}</Config>
  <Config Name="APP_PASSWORD" Target="APP_PASSWORD" Default="" Mode="" Description="Login password" Type="Variable" Display="always" Required="true" Mask="true">${password_xml}</Config>
</Container>
EOF
  echo "Unraid template written: $template_file"
}

echo "[4/8] Preparing GPU override"
rm -f docker-compose.override.yml
if [[ -d /dev/dri || "$USE_NVIDIA_GPU" == "1" ]]; then
  cat > docker-compose.override.yml <<EOF
services:
  komios:
EOF
  if [[ -d /dev/dri ]]; then
    cat >> docker-compose.override.yml <<'EOF'
    devices:
      - /dev/dri:/dev/dri
EOF
  fi
  if [[ "$USE_NVIDIA_GPU" == "1" ]]; then
    cat >> docker-compose.override.yml <<'EOF'
    gpus: all
    environment:
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
EOF
  fi
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  COMPOSE=""
fi

if [[ -n "$COMPOSE" ]]; then
  BUILD_PULL_ARGS=()
  if [[ "$PULL_BASE_IMAGE" == "1" ]]; then
    BUILD_PULL_ARGS+=(--pull)
  fi
  echo "[5/8] Building image with Compose (${COMPOSE})"
  $COMPOSE build "${BUILD_PULL_ARGS[@]}"
  echo "[6/8] Recreating container with Compose"
  $COMPOSE up -d --force-recreate
  $COMPOSE ps
else
  BUILD_PULL_ARGS=()
  if [[ "$PULL_BASE_IMAGE" == "1" ]]; then
    BUILD_PULL_ARGS+=(--pull)
  fi
  echo "[5/8] Docker Compose is not available; building image with docker build"
  docker build "${BUILD_PULL_ARGS[@]}" -t komios:latest .
  echo "[6/8] Recreating container with docker run"
  docker rm -f komios >/dev/null 2>&1 || true
  mkdir -p "$REMOTE_DIR/data"
  GPU_ARGS=()
  if [[ -d /dev/dri ]]; then
    GPU_ARGS+=(--device /dev/dri:/dev/dri)
  fi
  if [[ "$USE_NVIDIA_GPU" == "1" ]]; then
    GPU_ARGS+=(--gpus all -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility)
  fi
  docker run -d \
    --name komios \
    --restart unless-stopped \
    -p "${APP_PORT}:5173" \
    -e PORT=5173 \
    -e WORKSPACE=/workspace \
    -e CONFIG_DIR=/config \
    -e TRANSCODE_ACCEL="${TRANSCODE_ACCEL}" \
    -e APP_USERNAME="${APP_USERNAME}" \
    -e APP_PASSWORD="${APP_PASSWORD}" \
    "${GPU_ARGS[@]}" \
    -v "${WORKSPACE_PATH}:/workspace" \
    -v "${REMOTE_DIR}/data:/config" \
    komios:latest
  docker ps --filter name=komios
fi

echo "[7/8] Registering Unraid template"
write_unraid_template

echo "[8/8] Deployment complete"
echo "Login username: $APP_USERNAME"
echo "Login password: $APP_PASSWORD"
REMOTE_SCRIPT

echo "Done."
echo "Open: http://${NAS_HOST}:${APP_PORT}"
echo "Username: ${APP_USERNAME}"
echo "Password: ${APP_PASSWORD:-stored on NAS in ${REMOTE_DIR}/.app-password}"
