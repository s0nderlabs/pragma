#!/bin/bash
# Build pragma Desktop Extension (.mcpb)
# Stages existing artifacts into mcpb format and packs them.
# Does NOT rebuild or modify any source files.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DXT_DIR="$REPO_ROOT/dxt"
BUILD_DIR="$DXT_DIR/build"
OUTPUT="$DXT_DIR/pragma.mcpb"

# Check mcpb CLI
if ! command -v mcpb &>/dev/null; then
  echo "Error: mcpb CLI not found. Install with: npm install -g @anthropic-ai/mcpb"
  exit 1
fi

# Check source files exist
if [ ! -f "$REPO_ROOT/servers/pragma-mcp/dist/index.js" ]; then
  echo "Error: dist/index.js not found. Run 'bun run build:bundle' first."
  exit 1
fi

if [ ! -f "$REPO_ROOT/bin/pragma-signer" ]; then
  echo "Error: bin/pragma-signer not found."
  exit 1
fi

if [ ! -f "$DXT_DIR/manifest.json" ]; then
  echo "Error: dxt/manifest.json not found."
  exit 1
fi

echo "Building pragma.mcpb..."

# Clean staging directory
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/server" "$BUILD_DIR/bin"

# Copy files to staging
cp "$DXT_DIR/manifest.json" "$BUILD_DIR/manifest.json"
cp "$REPO_ROOT/servers/pragma-mcp/dist/index.js" "$BUILD_DIR/server/index.js"
cp "$REPO_ROOT/bin/pragma-signer" "$BUILD_DIR/bin/pragma-signer"
chmod +x "$BUILD_DIR/bin/pragma-signer"

# Validate manifest
echo "Validating manifest..."
mcpb validate "$BUILD_DIR"

# Pack
echo "Packing..."
rm -f "$OUTPUT"
mcpb pack "$BUILD_DIR" "$OUTPUT"

# Clean staging
rm -rf "$BUILD_DIR"

# Summary
if [ -f "$OUTPUT" ]; then
  SIZE=$(du -h "$OUTPUT" | cut -f1)
  echo ""
  echo "Built: $OUTPUT ($SIZE)"
  echo ""
  echo "Contents:"
  unzip -l "$OUTPUT" | grep -E '^\s+[0-9]' | grep -v 'files$'
  echo ""
  echo "Install: double-click $OUTPUT or drag into Claude Desktop"
else
  echo "Error: pack failed, no output file produced."
  exit 1
fi
