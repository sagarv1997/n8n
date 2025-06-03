#!/bin/bash
set -e

# --- Configuration ---
APP_VERSION_TAG="${APP_VERSION_TAG:-1.97.0}"
NODE_VERSION_ARG="${NODE_VERSION_ARG:-20}"
N8N_RELEASE_TYPE_ARG="${N8N_RELEASE_TYPE_ARG:-stable}"
LAUNCHER_VERSION_ARG="${LAUNCHER_VERSION_ARG:-1.1.2}"

DOCKERFILE_PATH="./docker/images/n8n/Dockerfile"
IMAGE_BASE_NAME="${IMAGE_BASE_NAME:-n8n-local}"
IMAGE_TAG="${IMAGE_TAG:-dev}"
FULL_IMAGE_NAME="${IMAGE_BASE_NAME}:${IMAGE_TAG}"

BUILD_CONTEXT="."
COMPILED_APP_DIR="./compiled_app_output"

# --- Platform Detection ---
LOCAL_ARCH=$(uname -m)
DEFAULT_TARGET_PLATFORM=""
DEFAULT_BUILDER_PLATFORM=""
if [[ "${LOCAL_ARCH}" == "arm64" || "${LOCAL_ARCH}" == "aarch64" ]]; then
  DEFAULT_TARGET_PLATFORM="linux/arm64"
  DEFAULT_BUILDER_PLATFORM="linux/arm64"
else
  DEFAULT_TARGET_PLATFORM="linux/amd64"
  DEFAULT_BUILDER_PLATFORM="linux/amd64"
fi
TARGET_PLATFORM_ARG="${OVERRIDE_TARGET_PLATFORM:-$DEFAULT_TARGET_PLATFORM}"
BUILDER_PLATFORM_ARG="${OVERRIDE_BUILDER_PLATFORM:-$DEFAULT_BUILDER_PLATFORM}"

# --- Tool Checks ---
for tool in pnpm jq node docker; do
  if ! command -v $tool &> /dev/null; then
    echo "Error: $tool could not be found. Please install it."
    exit 1
  fi
done

# --- Timing Functions ---
declare -A TIMERS
start_timer() {
  TIMERS["$1"]=$(date +%s)
}

end_timer() {
  local start_time=${TIMERS["$1"]}
  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  echo "$duration"
}

format_duration() {
  local total_seconds=$1
  local hours=$((total_seconds / 3600))
  local minutes=$(((total_seconds % 3600) / 60))
  local seconds=$((total_seconds % 60))

  if [ $hours -gt 0 ]; then
    printf "%dh %dm %ds" $hours $minutes $seconds
  elif [ $minutes -gt 0 ]; then
    printf "%dm %ds" $minutes $seconds
  else
    printf "%ds" $seconds
  fi
}

echo "===== Local n8n Build & Dockerize ====="
echo "INFO: Dockerfile: ${DOCKERFILE_PATH}"
echo "INFO: Output Image: ${FULL_IMAGE_NAME}"
echo "INFO: Artifacts Dir: ${COMPILED_APP_DIR}"
echo "-----------------------------------------------"

# Start overall timer
start_timer "total_build"

# 0. Clean Previous Build Output
echo "INFO: Cleaning previous output directory: ${COMPILED_APP_DIR}..."
rm -rf "${COMPILED_APP_DIR}"
echo "-----------------------------------------------"

# 1. Local Application Pre-build & Cleanup
echo "INFO: Starting local application pre-build..."
start_timer "package_build"

pnpm install --frozen-lockfile
pnpm build

PACKAGE_BUILD_TIME=$(end_timer "package_build")
echo "INFO: Package build completed in $(format_duration $PACKAGE_BUILD_TIME)"
echo "-----------------------------------------------"

echo "INFO: Performing pre-deploy cleanup on package.json files..."
ALL_PKG_JSONS=$(find . -name "package.json" \
                    -not -path "./node_modules/*" \
                    -not -path "*/node_modules/*" \
                    -not -path "./${COMPILED_APP_DIR#./}/*" \
                    -type f) || true
for FILE in $ALL_PKG_JSONS; do cp "$FILE" "$FILE.bak"; done

if [ -f "./package.json" ]; then
    jq 'del(.pnpm.patchedDependencies)' "./package.json" > "./package.json.tmp" && mv "./package.json.tmp" "./package.json"
fi
node .github/scripts/trim-fe-packageJson.js

echo "INFO: Creating pruned production deployment in '${COMPILED_APP_DIR}'..."
start_timer "package_deploy"

mkdir -p "${COMPILED_APP_DIR}"
NODE_ENV=production DOCKER_BUILD=true \
  pnpm --filter=n8n --prod --no-optional --legacy deploy "${COMPILED_APP_DIR}"

PACKAGE_DEPLOY_TIME=$(end_timer "package_deploy")

for FILE in $ALL_PKG_JSONS; do if [ -f "$FILE.bak" ]; then mv "$FILE.bak" "$FILE"; fi; done

echo "INFO: Package deployment completed in $(format_duration $PACKAGE_DEPLOY_TIME)"
echo "INFO: Size of ${COMPILED_APP_DIR}: $(du -sh ${COMPILED_APP_DIR} | cut -f1)"
echo "-----------------------------------------------"

# 2. Build Docker Image
echo "INFO: Building Docker image: ${FULL_IMAGE_NAME}..."
start_timer "docker_build"

docker build \
  --build-arg NODE_VERSION=${NODE_VERSION_ARG} \
  --build-arg N8N_VERSION=${APP_VERSION_TAG} \
  --build-arg N8N_RELEASE_TYPE=${N8N_RELEASE_TYPE_ARG} \
  --build-arg LAUNCHER_VERSION=${LAUNCHER_VERSION_ARG} \
  --build-arg TARGETPLATFORM=${TARGET_PLATFORM_ARG} \
  --build-arg BUILDER_PLATFORM_ARG=${BUILDER_PLATFORM_ARG} \
  -t "${FULL_IMAGE_NAME}" \
  -f "${DOCKERFILE_PATH}" \
  "${BUILD_CONTEXT}"

DOCKER_BUILD_TIME=$(end_timer "docker_build")

# Get both compressed and uncompressed sizes
IMAGE_SIZE_BYTES=$(docker image inspect ${FULL_IMAGE_NAME} --format='{{.Size}}')
IMAGE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", ${IMAGE_SIZE_BYTES}/1024/1024}")

# Calculate uncompressed size from all layers
UNCOMPRESSED_SIZE_BYTES=$(docker image inspect ${FULL_IMAGE_NAME} --format='{{range .RootFS.Layers}}{{.}}{{"\n"}}{{end}}' | \
  xargs -I {} docker image inspect ${FULL_IMAGE_NAME} --format='{{index .RootFS.Layers}}' | \
  paste -sd+ | bc 2>/dev/null || echo "0")

# Fallback: If the above doesn't work, estimate from docker history
if [ "$UNCOMPRESSED_SIZE_BYTES" = "0" ]; then
  UNCOMPRESSED_SIZE_BYTES=$(docker history ${FULL_IMAGE_NAME} --no-trunc --format "{{.Size}}" | \
    grep -v "<missing>" | \
    sed 's/B$//' | sed 's/KB$/*1024/' | sed 's/MB$/*1024*1024/' | sed 's/GB$/*1024*1024*1024/' | \
    paste -sd+ | bc 2>/dev/null || echo "0")
fi

UNCOMPRESSED_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", ${UNCOMPRESSED_SIZE_BYTES}/1024/1024}")

# If we still can't calculate, use docker save to get actual size
if [ "$UNCOMPRESSED_SIZE_MB" = "0.00" ]; then
  echo "INFO: Calculating uncompressed size using docker save (this may take a moment)..."
  UNCOMPRESSED_SIZE_BYTES=$(docker save ${FULL_IMAGE_NAME} | wc -c)
  UNCOMPRESSED_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", ${UNCOMPRESSED_SIZE_BYTES}/1024/1024}")
fi

echo "INFO: Docker build completed in $(format_duration $DOCKER_BUILD_TIME)"
echo "-----------------------------------------------"

# Calculate total time
TOTAL_BUILD_TIME=$(end_timer "total_build")

# Save build metadata for scan script
BUILD_METADATA_FILE=".build_metadata.json"
cat > "${BUILD_METADATA_FILE}" << EOF
{
  "image_name": "${FULL_IMAGE_NAME}",
  "build_timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "compressed_size_mb": ${IMAGE_SIZE_MB},
  "uncompressed_size_mb": ${UNCOMPRESSED_SIZE_MB},
  "build_times": {
    "package_build_seconds": ${PACKAGE_BUILD_TIME},
    "package_deploy_seconds": ${PACKAGE_DEPLOY_TIME},
    "docker_build_seconds": ${DOCKER_BUILD_TIME},
    "total_seconds": ${TOTAL_BUILD_TIME}
  }
}
EOF

# --- Final Output ---
echo ""
echo "================ BUILD SUMMARY ================"
echo "✅ Docker Image Built: ${FULL_IMAGE_NAME}"
echo ""
echo "📏 Image Sizes:"
echo "   Compressed:   ${IMAGE_SIZE_MB} MB"
echo "   Uncompressed: ${UNCOMPRESSED_SIZE_MB} MB"
echo ""
echo "⏱️  Build Times:"
echo "   Package Build:  $(format_duration $PACKAGE_BUILD_TIME)"
echo "   Package Deploy: $(format_duration $PACKAGE_DEPLOY_TIME)"
echo "   Docker Build:   $(format_duration $DOCKER_BUILD_TIME)"
echo "   -----------------------------"
echo "   Total Time:     $(format_duration $TOTAL_BUILD_TIME)"
echo ""
echo "📄 Build metadata saved to: ${BUILD_METADATA_FILE}"
echo ""
echo "🚀 To Run This Image Locally:"
echo "   First, create a persistent volume (if you haven't already):"
echo "     docker volume create ${IMAGE_BASE_NAME}_data"
echo ""
echo "   Then, run the container:"
echo "     docker run -it --rm --name ${IMAGE_BASE_NAME}_instance -p 5678:5678 -v ${IMAGE_BASE_NAME}_data:/home/node/.n8n ${FULL_IMAGE_NAME}"
echo ""
echo "🔍 To scan this image for vulnerabilities:"
echo "   ./scan.sh"
echo "============================================="