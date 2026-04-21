#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC2155
export SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_ROOT="$SCRIPT_DIR/.."

: "${OHOS_NDK_HOME:?OHOS_NDK_HOME must point to the HarmonyOS NDK root (contains llvm/ sysroot/...)}"

PROFILE="${1:-release}"
TARGET="aarch64-unknown-linux-ohos"

export PATH="$OHOS_NDK_HOME/llvm/bin:$PATH"
export CC_aarch64_unknown_linux_ohos="aarch64-unknown-linux-ohos-clang"
export CXX_aarch64_unknown_linux_ohos="aarch64-unknown-linux-ohos-clang++"
export AR_aarch64_unknown_linux_ohos="llvm-ar"

cd "$REPO_ROOT"
if [ "$PROFILE" = "release" ]; then
  cargo build -p shibei-core --target "$TARGET" --release
  SO="target/$TARGET/release/libshibei_core.so"
else
  cargo build -p shibei-core --target "$TARGET"
  SO="target/$TARGET/debug/libshibei_core.so"
fi

DEST="$REPO_ROOT/shibei-harmony/entry/libs/arm64-v8a"
mkdir -p "$DEST"
cp "$SO" "$DEST/"
ls -la "$DEST/libshibei_core.so"
echo "→ copied to $DEST/libshibei_core.so"
