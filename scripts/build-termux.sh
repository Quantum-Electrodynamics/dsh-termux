#!/usr/bin/env bash
set -euo pipefail

# A1（Sol 裁决 2026-09-20）：目标版本必须显式给定，禁止回退到 npm dist-tag latest。
# 实测 `npm view @deepseek-ai/dsh version` = 0.1.5-rc.2（latest），而目标是 0.1.6-alpha.2（alpha）
# —— 原默认值会静默构建出与目标不符的包。此处硬拒绝，不提供任何默认值。
if [[ -z "${UPSTREAM_VERSION:-}" ]]; then
  echo "build-termux.sh: UPSTREAM_VERSION is required (e.g. UPSTREAM_VERSION=0.1.6-alpha.2)." >&2
  echo "build-termux.sh: refusing to fall back to 'npm view @deepseek-ai/dsh version' (dist-tag latest)." >&2
  exit 2
fi
TERMUX_REVISION="${TERMUX_REVISION:-1}"
NODE_TARGET_VERSION="${NODE_TARGET_VERSION:-24.18.0}"
ANDROID_API="${ANDROID_API:-24}"
ANDROID_ABI="${ANDROID_ABI:-arm64-v8a}"
BUILD_ROOT="${BUILD_ROOT:-$PWD/build}"
PACKAGE_DIR="$BUILD_ROOT/package"
OUTPUT_DIR="$PWD/dist"
TERMUX_VERSION="${UPSTREAM_VERSION}-termux.${TERMUX_REVISION}"

# A1：原生模块期望版本（实测取自 0.1.6-alpha.2 依赖树，2026-09-20）
#   dsh-upgrade-016a2/build/node_modules/{node-pty,koffi}
# patch-node-pty-gyp.mjs 对 binding.gyp 是 exact-one-match，版本漂移必须立刻停，不能盲编。
EXPECTED_KOFFI_VERSION="${EXPECTED_KOFFI_VERSION:-3.3.1}"
EXPECTED_NODE_PTY_VERSION="${EXPECTED_NODE_PTY_VERSION:-1.2.0-beta.15}"

# ---- 工具链选择（BUILD_MODE=auto|termux|ndk）---------------------------------------------
# termux：Termux 原生 clang + ndk-sysroot，**不需要 Google NDK**。
#   实测依据（2026-09-20 12:28–12:34 toolchain-test/ + 13:34–13:36 端到端产包 EXIT=0）：
#     clang 21.1.8 `-dumpmachine` = aarch64-unknown-linux-android24（原生 clang 默认 target 已是 Android 24）；
#     `ndk-sysroot` 是已装的 Termux 包（dpkg: `ii ndk-sysroot 29-2`），头文件并入 $PREFIX/include；
#     libc++_shared 由 $PREFIX/lib/libc++_shared.so（1374336 B）提供 —— /system/lib64 下**不存在**；
#     node-pty / koffi 均编译成功，且从产出的 tgz 里真实 load+spawn 通过。
#   关键：编译到 bionic **必须**用 Termux 自己的 node 头（--nodedir=$PREFIX），
#   不能用 nodejs.org 的 linux 头 —— 那正是原先必须上 NDK 才能勉强糊上的根源。
# ndk  ：保留原有 Google NDK 交叉编译路径（CI / ubuntu runner 走这条），行为不变。
# auto ：能用 Termux clang 就用 termux，否则 ANDROID_NDK_HOME 存在就用 ndk，都不行则 exit 2。
BUILD_MODE="${BUILD_MODE:-auto}"
if [[ "$BUILD_MODE" == "auto" ]]; then
  if [[ -n "${PREFIX:-}" && -x "$PREFIX/bin/clang" ]] \
     && [[ "$("$PREFIX/bin/clang" -dumpmachine 2>/dev/null || true)" == *android* ]]; then
    BUILD_MODE=termux
  elif [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    BUILD_MODE=ndk
  else
    echo "build-termux.sh: no usable toolchain: neither a Termux clang (PREFIX/bin/clang targeting android)" >&2
    echo "build-termux.sh: nor ANDROID_NDK_HOME. Set BUILD_MODE=termux or BUILD_MODE=ndk explicitly." >&2
    exit 2
  fi
fi
echo "build-termux.sh: BUILD_MODE=$BUILD_MODE"

if [[ "$BUILD_MODE" == "termux" ]]; then
  if [[ -z "${PREFIX:-}" ]]; then
    echo "build-termux.sh: PREFIX must be set for BUILD_MODE=termux (run inside Termux)" >&2
    exit 2
  fi
  TERMUX_CLANG="${TERMUX_CLANG:-$PREFIX/bin/clang}"
  TERMUX_CLANGXX="${TERMUX_CLANGXX:-$PREFIX/bin/clang++}"
  for tool in "$TERMUX_CLANG" "$TERMUX_CLANGXX"; do
    [[ -x "$tool" ]] || { echo "build-termux.sh: '$tool' is not executable; the Termux clang toolchain is required" >&2; exit 2; }
  done
  CLANG_TARGET="$("$TERMUX_CLANG" -dumpmachine 2>/dev/null || true)"
  if [[ "$CLANG_TARGET" != *android* ]]; then
    echo "build-termux.sh: '$TERMUX_CLANG' targets '${CLANG_TARGET:-<no target>}', not an Android triple;" >&2
    echo "build-termux.sh: refusing to build a host-ABI addon that would not load in the Termux node" >&2
    exit 2
  fi
  # node 头目录（node-gyp 需要 node_api.h 与 common.gypi 两者）
  NODE_HEADERS_DIR="${NODE_HEADERS_DIR:-$PREFIX}"
  [[ -f "$NODE_HEADERS_DIR/include/node/node_api.h" ]] \
    || { echo "build-termux.sh: no node_api.h under '$NODE_HEADERS_DIR/include/node'; set NODE_HEADERS_DIR" >&2; exit 2; }
  [[ -f "$NODE_HEADERS_DIR/include/node/common.gypi" ]] \
    || { echo "build-termux.sh: no common.gypi under '$NODE_HEADERS_DIR/include/node'; node-gyp will fail" >&2; exit 2; }
  # 运行期 C++ 运行库（源码编译的 addon 其 NEEDED 里含 libc++_shared）
  LIBCXX_SHARED="${LIBCXX_SHARED:-$PREFIX/lib/libc++_shared.so}"
  [[ -f "$LIBCXX_SHARED" ]] || { echo "build-termux.sh: libc++_shared.so not found at '$LIBCXX_SHARED'" >&2; exit 2; }
else
  # 显式检查而非 `: "${VAR:?}"`：bash 对 `:?` 的退出码是 1，与本文其余前置门的 2 不一致，无法核验。
  if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
    echo "build-termux.sh: ANDROID_NDK_HOME must point to an installed Android NDK for BUILD_MODE=ndk" >&2
    exit 2
  fi
  NDK_TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
  TERMUX_CLANG="$NDK_TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang"
  TERMUX_CLANGXX="$NDK_TOOLCHAIN/aarch64-linux-android${ANDROID_API}-clang++"
  [[ -x "$TERMUX_CLANG" ]] || { echo "build-termux.sh: '$TERMUX_CLANG' not found; is ANDROID_NDK_HOME correct?" >&2; exit 2; }
  # NDK 模式沿用官方 node 头（$BUILD_ROOT 在本段之后才创建，故此处不校验）
  NODE_HEADERS_DIR="$BUILD_ROOT/node-headers"
fi

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

# A1 断言①：安装树里真实的 @deepseek-ai/dsh 版本必须等于显式请求的版本（防 registry / 锁文件解析偏差）
INSTALLED_UPSTREAM="$(node -p "require('$BUILD_ROOT/node_modules/@deepseek-ai/dsh/package.json').version")"
if [[ "$INSTALLED_UPSTREAM" != "$UPSTREAM_VERSION" ]]; then
  echo "build-termux.sh: installed @deepseek-ai/dsh is '$INSTALLED_UPSTREAM' but UPSTREAM_VERSION='$UPSTREAM_VERSION'" >&2
  exit 3
fi
printf '%s\n' "$INSTALLED_UPSTREAM" > "$BUILD_ROOT/installed-upstream-version.txt"

ESBUILD_VERSION="$(npm view @esbuild/android-arm64 version)"
SHARP_VERSION="$(find_lock_version sharp)"
npm install --prefix "$BUILD_ROOT/tools" --ignore-scripts "node-gyp@12.4.0"
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

# ---- 携带 profile 的插件 bundle（与 build-termux-prebuilt.sh 同一逻辑）----------------------
# 为什么需要：这些 bundle 不是上游依赖。profile 把插件装进**安装目录**的 node_modules
# （`dsh plugin install` 落点），而 profile 的 bundle 解析器只看安装目录的 node_modules 与 profile 目录。
# 因此新构建的包一个都没有，宿主会为 profile 列出的每个 bundle 拒绝启动。
# 实测（2026-09-20 13:42，本机 ~/.dsh/profiles/web/package.json 声明 28 个 bundle，
# 对**源码编译路径产出的 tgz** 逐个查 package/node_modules/<bundle>/package.json）：
#   present = 2（仅 @deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app 两个上游包）
#   MISSING  = 26
# 即：verify-package 的「closure ok」只证明上游依赖闭包完整，**不能**证明包能启动 profile。
# 只拷 bundle 本身也不够——每个 bundle 还有自己的依赖树（dsh-better-sidebar -> schemastery）。
# bundle 清单取自 profile manifest 而非硬编码；已存在的包不覆盖，避免上游升级被旧副本静默顶掉。
PROFILE_MANIFEST="${PROFILE_MANIFEST:-${DSH_HOME:-$HOME/.dsh}/profiles/web/package.json}"
CARRYOVER_SOURCE="${CARRYOVER_SOURCE:-$PREFIX/lib/node_modules/dsh-termux/node_modules}"
CARRYOVER_PROFILE_MODULES="${CARRYOVER_PROFILE_MODULES:-$(dirname "$PROFILE_MANIFEST")/node_modules}"
CARRYOVER_SHARED_MODULES="${CARRYOVER_SHARED_MODULES:-$(dirname "$(dirname "$PROFILE_MANIFEST")")/node_modules}"
if [[ -f "$PROFILE_MANIFEST" ]]; then
  SOURCES=()
  for candidate in "$CARRYOVER_SOURCE" "$CARRYOVER_PROFILE_MODULES" "$CARRYOVER_SHARED_MODULES"; do
    [[ -d "$candidate" ]] && SOURCES+=("$candidate")
  done
  if (( ${#SOURCES[@]} == 0 )); then
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

KOFFI="$PACKAGE_DIR/node_modules/koffi"
if [[ "$BUILD_MODE" == "termux" ]]; then
  # Termux 原生：cnoke 自动探测 native toolchain（实测 koffi-build.log:
  #   ">> Toolchain: native" / "-- The C compiler identification is Clang 21.1.8" / ">> Using local node-api headers"），
  # 因此不注入任何 cmake toolchain file。目标仍显式为 android_arm64。
  CC="$TERMUX_CLANG" CXX="$TERMUX_CLANGXX" \
    node "$KOFFI/cnoke.cjs" \
    -P "$KOFFI" -D "$KOFFI/src/koffi" -t android_arm64 \
    --runtime "$NODE_TARGET_VERSION" --release
else
  # NDK 模式：原样保留注入 android.toolchain.cmake 的 cmake wrapper（行为不变）
  REAL_CMAKE="$(command -v cmake)"
  mkdir -p "$BUILD_ROOT/cmake-wrapper"
  cat > "$BUILD_ROOT/cmake-wrapper/cmake" <<WRAPPER
#!/usr/bin/env bash
set -e
if [[ "\${1:-}" == "--version" || "\${1:-}" == "--build" ]]; then
  exec "$REAL_CMAKE" "\$@"
fi
exec "$REAL_CMAKE" "\$@" \\
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \\
  -DANDROID_ABI="$ANDROID_ABI" \\
  -DANDROID_PLATFORM="android-$ANDROID_API" \\
  -DANDROID_STL=c++_shared
WRAPPER
  chmod +x "$BUILD_ROOT/cmake-wrapper/cmake"
  PATH="$BUILD_ROOT/cmake-wrapper:$PATH" node "$KOFFI/cnoke.cjs" \
    -P "$KOFFI" -D "$KOFFI/src/koffi" -t android_arm64 \
    --runtime "$NODE_TARGET_VERSION" --release
fi

# A1 断言②：koffi 必须来自 0.1.6-alpha.2 的依赖树（3.3.1），不是旧树残留
KOFFI_VERSION="$(node -p "require('$KOFFI/package.json').version")"
if [[ "$KOFFI_VERSION" != "$EXPECTED_KOFFI_VERSION" ]]; then
  echo "build-termux.sh: koffi is '$KOFFI_VERSION' but expected '$EXPECTED_KOFFI_VERSION' (from $UPSTREAM_VERSION dependency tree)" >&2
  exit 3
fi

NODE_PTY="$PACKAGE_DIR/node_modules/node-pty"

# A1 断言③：node-pty 版本必须与 patch-node-pty-gyp.mjs 的 exact-one-match 目标一致
NODE_PTY_VERSION="$(node -p "require('$NODE_PTY/package.json').version")"
if [[ "$NODE_PTY_VERSION" != "$EXPECTED_NODE_PTY_VERSION" ]]; then
  echo "build-termux.sh: node-pty is '$NODE_PTY_VERSION' but expected '$EXPECTED_NODE_PTY_VERSION'" >&2
  echo "build-termux.sh: scripts/patch-node-pty-gyp.mjs is exact-one-match against the expected version; do not build blind." >&2
  exit 3
fi
if [[ "$BUILD_MODE" == "termux" ]]; then
  # node 头**直接用 Termux 自己的 $PREFIX**（实测端到端构建的 config.gypi 记录
  #   "nodedir": "/data/data/com.termux/files/usr"），不下载 nodejs.org 的 linux 头 ——
  #   用 linux 头配 bionic 运行库正是原先必须上 NDK 才能勉强糊上的根源。
  export CC="$TERMUX_CLANG"
  export CXX="$TERMUX_CLANGXX"
  export AR="$PREFIX/bin/ar"
  export RANLIB="$PREFIX/bin/ranlib"
  export LD="$PREFIX/bin/ld"
  export npm_config_nodedir="$NODE_HEADERS_DIR"
  # 实测成功构建的 config.gypi: OS=android / target_arch=arm64 / clang=1；不需要 android_ndk_path。
  export GYP_DEFINES="OS=android target_arch=arm64 clang=1"
else
  # NDK 模式：沿用官方 node 头 + NDK llvm 工具链（行为不变）
  curl -fsSL "https://nodejs.org/download/release/v${NODE_TARGET_VERSION}/node-v${NODE_TARGET_VERSION}-headers.tar.gz" \
    | tar -xz -C "$BUILD_ROOT"
  mv "$BUILD_ROOT/node-v${NODE_TARGET_VERSION}" "$NODE_HEADERS_DIR"
  export CC="$TERMUX_CLANG"
  export CXX="$TERMUX_CLANGXX"
  export AR="$NDK_TOOLCHAIN/llvm-ar"
  export LD="$NDK_TOOLCHAIN/ld.lld"
  export RANLIB="$NDK_TOOLCHAIN/llvm-ranlib"
  export npm_config_nodedir="$NODE_HEADERS_DIR"
  export GYP_DEFINES="OS=android target_arch=arm64 host_os=linux host_arch=x64 android_ndk_path=$ANDROID_NDK_HOME"
fi
export npm_config_arch=arm64
export npm_config_target_arch=arm64

cp "$NODE_PTY/binding.gyp" "$NODE_PTY/binding.gyp.upstream"
node scripts/patch-node-pty-gyp.mjs "$NODE_PTY/binding.gyp"
(cd "$NODE_PTY" && node "$BUILD_ROOT/tools/node_modules/node-gyp/bin/node-gyp.js" rebuild \
  --arch=arm64 --nodedir="$NODE_HEADERS_DIR")
mv "$NODE_PTY/binding.gyp.upstream" "$NODE_PTY/binding.gyp"
mkdir -p "$NODE_PTY/prebuilds/android-arm64"
cp "$NODE_PTY/build/Release/pty.node" "$NODE_PTY/prebuilds/android-arm64/pty.node"


node scripts/prepare-package.mjs "$PACKAGE_DIR" "$TERMUX_VERSION"
node scripts/verify-package.mjs "$PACKAGE_DIR" "$TERMUX_VERSION"

# 实测修正（2026-09-20 13:33）：Termux **没有 `file` 命令**（command -v file → 空），
# 原 `file … | grep -F "ARM aarch64"` 在 `set -e` 下会以 command-not-found 直接中断打包。
# 改用 readelf（已装，/data/data/com.termux/files/usr/bin/readelf）读 ELF header。
assert_aarch64() {
  local label="$1" artifact="$2"
  [[ -f "$artifact" ]] || { echo "build-termux.sh: missing native artifact $label at '$artifact'" >&2; exit 3; }
  local machine
  machine="$(readelf -h "$artifact" | awk -F: '/Machine:/ {gsub(/^ +/,"",$2); print $2}')"
  if [[ "$machine" != "AArch64" ]]; then
    echo "build-termux.sh: $label is '$machine', not AArch64 ($artifact)" >&2
    exit 3
  fi
  echo "build-termux.sh: $label ELF Machine=AArch64 ok"
}
assert_aarch64 "node-pty pty.node" "$NODE_PTY/prebuilds/android-arm64/pty.node"
assert_aarch64 "koffi koffi.node" "$KOFFI/build/koffi/android_arm64/koffi.node"

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
(cd "$OUTPUT_DIR" && sha256sum "dsh-termux-${TERMUX_VERSION}.tgz" > "dsh-termux-${TERMUX_VERSION}.tgz.sha256")
cp "$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz" "$OUTPUT_DIR/dsh-termux.tgz"
printf '%s\n' "$UPSTREAM_VERSION" > "$OUTPUT_DIR/upstream-version.txt"

# A1 断言④（产物级）：打包后从 tgz 内部再读一次真实版本，防止"断言过了但打错树"。
# 注意实际布局（2026-09-20 实测修正）：tgz 的 package/ 根就是被拍平的 @deepseek-ai/dsh 本身
# （prepare-package.mjs 把根 package.json 改写成 dsh-termux@<UPSTREAM>-termux.<rev>，因此根
# package.json 不再携带 upstream 版本）。upstream 版本的真实载体是随包的 @deepseek-ai/dsh-* 子包
# ——所有 @deepseek-ai/dsh-* 与主包同版本。故从 dsh-session 读，并同时校验 termux 根清单。
TGZ="$OUTPUT_DIR/dsh-termux-${TERMUX_VERSION}.tgz"
if [[ ! -f "$TGZ" ]]; then
  echo "build-termux.sh: expected artifact '$TGZ' is missing; refusing to report a verified package" >&2
  exit 3
fi
read_tgz_version() {
  local raw
  if ! raw="$(tar -xzOf "$TGZ" "$1" 2>/dev/null)"; then
    echo "build-termux.sh: '$1' not readable inside $TGZ (layout changed?)" >&2
    exit 3
  fi
  printf '%s' "$raw" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch(e){console.error("build-termux.sh: unparsable manifest "+process.argv[1]);process.exit(3)}process.stdout.write(j.version)})' "$1"
}
TGZ_UPSTREAM="$(read_tgz_version package/node_modules/@deepseek-ai/dsh-session/package.json)"
if [[ "$TGZ_UPSTREAM" != "$UPSTREAM_VERSION" ]]; then
  echo "build-termux.sh: packaged @deepseek-ai/dsh-session is '$TGZ_UPSTREAM' but UPSTREAM_VERSION='$UPSTREAM_VERSION'" >&2
  exit 3
fi
TGZ_MANIFEST="$(read_tgz_version package/package.json)"
if [[ "$TGZ_MANIFEST" != "$TERMUX_VERSION" ]]; then
  echo "build-termux.sh: packaged root manifest is '$TGZ_MANIFEST' but expected TERMUX_VERSION='$TERMUX_VERSION'" >&2
  exit 3
fi
echo "build-termux.sh: verified package @deepseek-ai/dsh=$TGZ_UPSTREAM termux=$TGZ_MANIFEST koffi=$KOFFI_VERSION node-pty=$NODE_PTY_VERSION"
printf '%s\n' "$TERMUX_VERSION" > "$OUTPUT_DIR/termux-version.txt"
