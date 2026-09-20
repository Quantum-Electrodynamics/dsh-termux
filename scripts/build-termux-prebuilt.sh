#!/usr/bin/env bash
# NDK-free Termux build.
#
# scripts/build-termux.sh compiles the two native addons from source, which is why the CI job
# installs an Android NDK before doing anything else. That install step is the one that has been
# failing on every run (android-actions/setup-android@v3, step 4), so the whole job dies before it
# reaches `Build offline Termux package`.
#
# Neither addon actually needs compiling any more:
#
#   koffi  >= 3.3.0 publishes an official Android arm64 prebuild as @koromix/koffi-android-arm64
#                  (android_arm64/koffi.node, NEEDED = libm/libdl/libc, api_level 28). The
#                  dependency range in the upstream tree resolves to it automatically.
#   node-pty       the npm tarball ships no android-arm64 prebuild, so it is copied from the
#                  currently installed Termux package. Both sides are node-pty 1.2.0-beta.15 and
#                  the copied binary is exercised by a real spawn before it is packed, so the
#                  provenance is a pinned sha256 rather than an assumption.
#
# The resulting package is byte-for-byte the same shape as the source build (same patch chain,
# same prepare/verify steps, same pack semantics); only the origin of the two .node files differs.
set -euo pipefail

UPSTREAM_VERSION="${UPSTREAM_VERSION:-}"
if [[ -z "$UPSTREAM_VERSION" ]]; then
  cat >&2 <<'MESSAGE'
UPSTREAM_VERSION is required and has no default.

The default used to be `npm view @deepseek-ai/dsh version`, which resolves the `latest` dist-tag
(0.1.5-rc.2) - not the `alpha` dist-tag (0.1.6-alpha.2) and not whatever the caller intended. A
build that silently produces the wrong upstream version is worse than a build that refuses to
start, so this script refuses.

Pass the exact version, for example:
  UPSTREAM_VERSION=0.1.6-alpha.2 bash scripts/build-termux-prebuilt.sh
MESSAGE
  exit 2
fi
TERMUX_REVISION="${TERMUX_REVISION:-1}"
# Pinned because the patch chain is written against these exact versions: patch-dsh.mjs matches
# koffi's source text and node-pty's binding.gyp by exact content, and check-native-elf/verify
# assert the resulting binary layout. A silent version bump would either fail the build with a
# confusing exact-one-match error or, worse, pass with a binary nobody checked.
EXPECTED_KOFFI_VERSION="${EXPECTED_KOFFI_VERSION:-3.3.1}"
EXPECTED_NODE_PTY_VERSION="${EXPECTED_NODE_PTY_VERSION:-1.2.0-beta.15}"
BUILD_ROOT="${BUILD_ROOT:-$PWD/build}"
PACKAGE_DIR="$BUILD_ROOT/package"
OUTPUT_DIR="$PWD/dist"
TERMUX_VERSION="${UPSTREAM_VERSION}-termux.${TERMUX_REVISION}"

# Where to take the node-pty android-arm64 prebuild from. Defaults to the installed Termux package.
NODE_PTY_PREBUILD_SOURCE="${NODE_PTY_PREBUILD_SOURCE:-$(npm root -g)/dsh-termux/node_modules/node-pty/prebuilds/android-arm64/pty.node}"
# sha256 of the node-pty 1.2.0-beta.15 android-arm64 binary currently shipped and in use.
NODE_PTY_PREBUILD_SHA256="${NODE_PTY_PREBUILD_SHA256:-39926441af20a1f9612e580f55b502c6f431abe91d7f157bc4b0318b7953bc1a}"

echo "building dsh-termux@$TERMUX_VERSION from upstream @deepseek-ai/dsh@$UPSTREAM_VERSION (prebuilt natives)"

rm -rf "$BUILD_ROOT" "$OUTPUT_DIR"
mkdir -p "$BUILD_ROOT" "$PACKAGE_DIR" "$OUTPUT_DIR"

cat > "$BUILD_ROOT/package.json" <<JSON
{
  "name": "dsh-termux-build",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "$UPSTREAM_VERSION"
  }
}
JSON

find_lock_version() {
  local package_name="$1"
  local ranges=()
  mapfile -t ranges < <(node -e '
    const lock = require(process.argv[1]);
    const packageName = process.argv[2];
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`))
      .map(([, metadata]) => metadata.version);
    process.stdout.write([...new Set(versions)].sort().join("\n"));
  ' "$BUILD_ROOT/package-lock.json" "$package_name")
  if (( ${#ranges[@]} != 1 )); then
    echo "expected one locked $package_name version, found: ${ranges[*]}" >&2
    return 1
  fi
  printf '%s\n' "${ranges[0]}"
}

npm install --prefix "$BUILD_ROOT" --ignore-scripts --include=optional --os=android --cpu=arm64

# The installed tree must really be the requested upstream version: a registry or lockfile
# resolution difference would otherwise be reported as a successful build of the wrong thing.
INSTALLED_UPSTREAM="$(node -p "require('$BUILD_ROOT/node_modules/@deepseek-ai/dsh/package.json').version")"
if [[ "$INSTALLED_UPSTREAM" != "$UPSTREAM_VERSION" ]]; then
  echo "build-termux-prebuilt.sh: installed @deepseek-ai/dsh is '$INSTALLED_UPSTREAM' but UPSTREAM_VERSION='$UPSTREAM_VERSION'" >&2
  exit 3
fi
printf '%s\n' "$INSTALLED_UPSTREAM" > "$BUILD_ROOT/installed-upstream-version.txt"

ESBUILD_VERSION="$(npm view @esbuild/android-arm64 version)"
SHARP_VERSION="$(find_lock_version sharp)"
npm install --prefix "$BUILD_ROOT" --ignore-scripts --no-save --force --os=android --cpu=arm64 \
  "esbuild@$ESBUILD_VERSION" \
  "sharp@$SHARP_VERSION" \
  "@esbuild/android-arm64@$ESBUILD_VERSION" \
  "@img/sharp-wasm32@$SHARP_VERSION"
node - <<NODE
const esbuildPlatform = require("$BUILD_ROOT/node_modules/@esbuild/android-arm64/package.json");
const sharpPlatform = require("$BUILD_ROOT/node_modules/@img/sharp-wasm32/package.json");
if (esbuildPlatform.version !== "$ESBUILD_VERSION") throw new Error("esbuild Android package version mismatch");
if (sharpPlatform.version !== "$SHARP_VERSION") throw new Error("sharp WASM package version mismatch");
NODE

cp -a "$BUILD_ROOT/node_modules/@deepseek-ai/dsh/." "$PACKAGE_DIR/"
cp -a "$BUILD_ROOT/node_modules" "$PACKAGE_DIR/node_modules"
rm -rf "$PACKAGE_DIR/node_modules/@deepseek-ai/dsh"

node scripts/patch-dsh.mjs "$PACKAGE_DIR"

# ---- carry over the profile's plugin bundles ----
# These are not upstream dependencies. The profile installs its plugins into the *installation's*
# node_modules (that is where `dsh plugin install` puts them), and the profile bundle resolver looks
# only at the installation's node_modules and the profile directory. A freshly built package
# therefore starts with none of them, and the host refuses to boot for every bundle the profile
# lists. Measured here: 28 profile bundles present in the installed 0.1.2 package and absent from a
# freshly built 0.1.6-alpha.2 package.
#
# Copying the bundles alone is not enough - each pulls its own dependency tree, which is also
# missing (dsh-better-sidebar -> schemastery). carry-over-profile-bundles.mjs therefore walks the
# declared dependency closure. Bundles come from the profile manifest rather than a hardcoded list,
# and anything already in the new package is left alone, so an upstream bump is never silently
# overridden by a stale copy.
PROFILE_MANIFEST="${PROFILE_MANIFEST:-${DSH_HOME:-$HOME/.dsh}/profiles/web/package.json}"
# Packages come from more than one place on a real machine: the previous installation's
# node_modules holds the plugin bundles themselves, while their own dependencies are resolved
# inside the profile's node_modules. All are searched, in this order.
CARRYOVER_SOURCE="${CARRYOVER_SOURCE:-$PREFIX/lib/node_modules/dsh-termux/node_modules}"
CARRYOVER_PROFILE_MODULES="${CARRYOVER_PROFILE_MODULES:-$(dirname "$PROFILE_MANIFEST")/node_modules}"
CARRYOVER_SHARED_MODULES="${CARRYOVER_SHARED_MODULES:-$(dirname "$(dirname "$PROFILE_MANIFEST")")/node_modules}"
if [[ -f "$PROFILE_MANIFEST" ]]; then
  SOURCES=()
  for candidate in "$CARRYOVER_SOURCE" "$CARRYOVER_PROFILE_MODULES" "$CARRYOVER_SHARED_MODULES"; do
    [[ -d "$candidate" ]] && SOURCES+=("$candidate")
  done
  if (( ${#SOURCES[@]} == 0 )); then
    # CI has no previous installation to copy from. The profile's bundles are not in the upstream
    # dependency tree either, so the resulting package cannot boot that profile; say so plainly
    # rather than shipping it.
    echo "carry-over: no source node_modules found (looked at $CARRYOVER_SOURCE, $CARRYOVER_PROFILE_MODULES, $CARRYOVER_SHARED_MODULES)" >&2
    echo "carry-over: this build would NOT contain the profile's plugin bundles ($PROFILE_MANIFEST lists them)" >&2
    echo "carry-over: set CARRYOVER_SOURCE, or run 'dsh plugin --profile web install' first" >&2
    if [[ "${ALLOW_MISSING_PROFILE_BUNDLES:-false}" != "true" ]]; then
      exit 4
    fi
    echo "carry-over: continuing anyway because ALLOW_MISSING_PROFILE_BUNDLES=true"
  else
    node scripts/carry-over-profile-bundles.mjs "$PACKAGE_DIR" "$PROFILE_MANIFEST" "${SOURCES[@]}"
  fi
else
  echo "carry-over: no profile manifest at $PROFILE_MANIFEST; nothing to carry over"
fi

# Both addon versions are asserted before the binaries are used, so a dependency-tree change is
# reported as a version mismatch instead of as a patch that mysteriously stopped matching.
KOFFI_VERSION="$(node -p "require('$PACKAGE_DIR/node_modules/koffi/package.json').version")"
if [[ "$KOFFI_VERSION" != "$EXPECTED_KOFFI_VERSION" ]]; then
  echo "build-termux-prebuilt.sh: koffi is '$KOFFI_VERSION' but expected '$EXPECTED_KOFFI_VERSION' (from $UPSTREAM_VERSION dependency tree)" >&2
  exit 3
fi
NODE_PTY_VERSION="$(node -p "require('$PACKAGE_DIR/node_modules/node-pty/package.json').version")"
if [[ "$NODE_PTY_VERSION" != "$EXPECTED_NODE_PTY_VERSION" ]]; then
  echo "build-termux-prebuilt.sh: node-pty is '$NODE_PTY_VERSION' but expected '$EXPECTED_NODE_PTY_VERSION'" >&2
  echo "build-termux-prebuilt.sh: the reused pty.node is the binary for the expected version; do not build blind." >&2
  exit 3
fi

# ---- native addons ----
KOFFI_PREBUILD="$PACKAGE_DIR/node_modules/@koromix/koffi-android-arm64/android_arm64/koffi.node"
if [[ ! -f "$KOFFI_PREBUILD" ]]; then
  echo "koffi: no official Android arm64 prebuild at $KOFFI_PREBUILD" >&2
  echo "koffi: upstream dropped the prebuild; either pin koffi >= 3.3.0 or restore the NDK source build" >&2
  exit 1
fi

NODE_PTY_PREBUILD="$PACKAGE_DIR/node_modules/node-pty/prebuilds/android-arm64/pty.node"
mkdir -p "$(dirname "$NODE_PTY_PREBUILD")"
if [[ -f "$NODE_PTY_PREBUILD" ]]; then
  echo "node-pty: npm tarball already ships an android-arm64 prebuild; using it"
else
  if [[ ! -f "$NODE_PTY_PREBUILD_SOURCE" ]]; then
    if [[ -n "${NODE_PTY_PREBUILD_URL:-}" ]]; then
      # CI has no dsh-termux installed to copy from, so the binary is fetched from a published
      # release and still checked against NODE_PTY_PREBUILD_SHA256 below.
      echo "node-pty: downloading android-arm64 prebuild from $NODE_PTY_PREBUILD_URL"
      curl -fsSL "$NODE_PTY_PREBUILD_URL" -o "$NODE_PTY_PREBUILD"
    else
      echo "node-pty: no android-arm64 prebuild in the tarball and none at $NODE_PTY_PREBUILD_SOURCE" >&2
      echo "node-pty: install dsh-termux, or set NODE_PTY_PREBUILD_SOURCE to a pty.node, or set NODE_PTY_PREBUILD_URL" >&2
      exit 1
    fi
  else
    cp "$NODE_PTY_PREBUILD_SOURCE" "$NODE_PTY_PREBUILD"
    echo "node-pty: reused android-arm64 prebuild from $NODE_PTY_PREBUILD_SOURCE"
  fi
fi

ACTUAL_PTY_SHA256="$(sha256sum "$NODE_PTY_PREBUILD" | cut -d' ' -f1)"
if [[ "$ACTUAL_PTY_SHA256" != "$NODE_PTY_PREBUILD_SHA256" ]]; then
  echo "node-pty: pty.node sha256 mismatch" >&2
  echo "  expected $NODE_PTY_PREBUILD_SHA256" >&2
  echo "  actual   $ACTUAL_PTY_SHA256" >&2
  exit 1
fi

# The source build's `file ... | grep ARM aarch64` check cannot run here: the Termux image has no
# `file`. Read the ELF e_machine field instead (offset 18, little-endian) - 0x00b7 is AArch64.
node scripts/check-native-elf.mjs "$KOFFI_PREBUILD" "$NODE_PTY_PREBUILD"

# Exercise both addons in this Node before packing them: an architecture-correct binary that
# cannot load or cannot spawn is exactly the failure this build exists to prevent.
node scripts/smoke-native.mjs "$PACKAGE_DIR"

node scripts/prepare-package.mjs "$PACKAGE_DIR" "$TERMUX_VERSION"
node scripts/verify-package.mjs "$PACKAGE_DIR" "$TERMUX_VERSION"

# npm pack's bundledDependencies semantics only bundle direct dependencies and can
# silently drop transitive-only packages (0.1.2-rc.1 lost @deepseek-ai/dsh-settings,
# dsh-bash-local, dsh-session-query this way while every patch marker still matched).
# Pack the whole offline tree directly instead.
(cd "$PACKAGE_DIR" \
  && tar --exclude='./node_modules/.package-lock.json' \
         -czf "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" \
         --transform='s|^\./|package/|' .)
tar -tzf "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" \
  | grep -Fx "package/node_modules/node-pty/prebuilds/android-arm64/pty.node"
tar -tzf "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" \
  | grep -Fx "package/node_modules/@koromix/koffi-android-arm64/android_arm64/koffi.node"
(cd "$OUTPUT_DIR" && sha256sum "dsh-termux-${TERMUX_VERSION}.tgz" > "dsh-termux-${TERMUX_VERSION}.tgz.sha256")

# Artifact-level re-read of the versions, from inside the archive. The checks above ran against the
# staging tree; this one proves the file actually handed to users carries the same versions, which
# is the difference between "the build passed" and "the artifact is the thing that was verified".
#
# Note the layout: package/ is the flattened @deepseek-ai/dsh itself, and prepare-package.mjs
# rewrites the root manifest to dsh-termux@<upstream>-termux.<rev>, so the root manifest no longer
# carries the upstream version. The upstream version lives on the bundled @deepseek-ai/dsh-*
# packages (they share the upstream version), so it is read from dsh-session.
TGZ="$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz"
if [[ ! -f "$TGZ" ]]; then
  echo "build-termux-prebuilt.sh: expected artifact '$TGZ' is missing; refusing to report a verified package" >&2
  exit 3
fi
read_tgz_version() {
  local raw
  if ! raw="$(tar -xzOf "$TGZ" "$1" 2>/dev/null)"; then
    echo "build-termux-prebuilt.sh: '$1' not readable inside $TGZ (layout changed?)" >&2
    exit 3
  fi
  printf '%s' "$raw" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.error("build-termux-prebuilt.sh: unparsable manifest "+process.argv[1]);process.exit(3)}process.stdout.write(j.version)})' "$1"
}
TGZ_UPSTREAM="$(read_tgz_version package/node_modules/@deepseek-ai/dsh-session/package.json)"
if [[ "$TGZ_UPSTREAM" != "$UPSTREAM_VERSION" ]]; then
  echo "build-termux-prebuilt.sh: packaged @deepseek-ai/dsh-session is '$TGZ_UPSTREAM' but UPSTREAM_VERSION='$UPSTREAM_VERSION'" >&2
  exit 3
fi
TGZ_MANIFEST="$(read_tgz_version package/package.json)"
if [[ "$TGZ_MANIFEST" != "$TERMUX_VERSION" ]]; then
  echo "build-termux-prebuilt.sh: packaged root manifest is '$TGZ_MANIFEST' but expected TERMUX_VERSION='$TERMUX_VERSION'" >&2
  exit 3
fi

cp "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" "$OUTPUT_DIR/dsh-termux.tgz"
printf '%s\n' "$UPSTREAM_VERSION" > "$OUTPUT_DIR/upstream-version.txt"
printf '%s\n' "$TERMUX_VERSION" > "$OUTPUT_DIR/termux-version.txt"
echo "built $OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz"
echo "verified package @deepseek-ai/dsh=$TGZ_UPSTREAM termux=$TGZ_MANIFEST koffi=$KOFFI_VERSION node-pty=$NODE_PTY_VERSION"
