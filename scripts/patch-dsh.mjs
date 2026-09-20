#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  throw new Error("usage: patch-dsh.mjs <dsh-package-directory>");
}

async function replaceOnce(relativePath, before, after, label) {
  const filename = join(root, relativePath);
  const source = await readFile(filename, "utf8");
  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`${label}: expected exactly one match in ${relativePath}, found ${matches}`);
  }
  await writeFile(filename, source.replace(before, after));
  console.log(`patched: ${label}`);
}

const koffiPath = "node_modules/koffi/lib/native/base/base.cc";
const koffiFilename = join(root, koffiPath);
const koffiSource = await readFile(koffiFilename, "utf8");
const koffiVariants = [
  [
    "#if defined(__linux__)\n    const char *pathname = filename;",
    "#if defined(__linux__) && !defined(__ANDROID__)\n    const char *pathname = filename;",
  ],
  [
    "#if defined(__linux__) && defined(STATX_TYPE) && !defined(CORE_NO_STATX)\n    const char *pathname = filename;",
    "#if defined(__linux__) && !defined(__ANDROID__) && defined(STATX_TYPE) && !defined(CORE_NO_STATX)\n    const char *pathname = filename;",
  ],
];
const koffiMatches = koffiVariants.filter(([before]) => koffiSource.split(before).length - 1 === 1);
if (koffiMatches.length === 1) {
  await writeFile(koffiFilename, koffiSource.replace(...koffiMatches[0]));
  console.log("patched: koffi: use fstatat fallback on Android");
} else if (koffiMatches.length > 1) {
  throw new Error(`koffi: expected exactly one known statx condition in ${koffiPath}, found ${koffiMatches.length}`);
} else if (koffiSource.includes("syscall(__NR_statx") && koffiSource.includes("case ENOSYS: goto fallback")) {
  // koffi >= 3.2.0: raw syscall(__NR_statx) + ENOSYS fallback 已在源码原生处理 Android statx, 无需补丁
  console.log("skipped: koffi: statx handled natively by upstream (>= 3.2.0)");
} else {
  throw new Error(`koffi: no known statx condition and no modern fallback in ${koffiPath}`);
}

await replaceOnce(
  koffiPath,
  `bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,
                        FunctionRef<Span<const uint8_t>()> in_func,
                        FunctionRef<void(Span<uint8_t> buf)> out_func, int *out_code)
{
    BlockAllocator temp_alloc;`,
  `bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,
                        FunctionRef<Span<const uint8_t>()> in_func,
                        FunctionRef<void(Span<uint8_t> buf)> out_func, int *out_code)
{
#if defined(__ANDROID__) && __ANDROID_API__ < 28
    errno = ENOSYS;
    return false;
#else
    BlockAllocator temp_alloc;`,
  "koffi: disable command execution below Android API 28",
);

await replaceOnce(
  koffiPath,
  `    return true;
}

#endif

bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,`,
  `    return true;
#endif
}

#endif

bool ExecuteCommandLine(const char *cmd_line, const ExecuteInfo &info,`,
  "koffi: close Android command execution guard",
);

await replaceOnce(
  "node_modules/koffi/src/koffi/CMakeLists.txt",
  "    target_link_options(koffi PRIVATE -Wl,--gc-sections)",
  `    target_link_options(koffi PRIVATE -Wl,--gc-sections)
    if(ANDROID)
        target_link_options(koffi PRIVATE -Wl,--unresolved-symbols=ignore-all)
    endif()`,
  "koffi: resolve Node-API symbols at module load time on Android",
);

// ---- profile resolution mode (Android: no node-addon-require-builtin prebuild) ----
// Upstream 0.1.6 defaults the profile module-resolution mode to "runtime", which installs a
// generation on Node's own ESM/CommonJS resolvers through the `node-addon-require-builtin`
// native addon (dsh-app-boot internalModules()). That addon publishes prebuilds for darwin,
// linux and win32 only — there is no android-arm64 package — so on Android the addon cannot be
// loaded and dsh aborts at "host preparation failed".
//
// "link" mode instead maintains $DSH_HOME/profiles/node_modules symlinks via
// healProfilesModuleFallback(), the same module-fallback mechanism this Termux port already
// relies on, and PluginPackages then receives no generation, so the native addon is never
// required. Pin the mode explicitly rather than leaving it to the "runtime" default.
await replaceOnce(
  "lib/bin.js",
  `\t\t\t\t\tpatchFiles: invocation.patches,
\t\t\t\t\targs: invocation.args
\t\t\t\t});`,
  `\t\t\t\t\tpatchFiles: invocation.patches,
\t\t\t\t\targs: invocation.args,
\t\t\t\t\tresolutionMode: "link"
\t\t\t\t});`,
  "dsh: use link profile resolution (no node-addon-require-builtin prebuild on Android)",
);

// ---- HMR entry guard: verified, NOT patched (profile override instead) ----
// Cordis HMR requires Node's --expose-internals, which cannot be passed through NODE_OPTIONS.
// Upstream <= 0.1.5-rc.2 booted the HMR watcher from the launcher (profile-boot), which this
// port rewrote to only create it under --expose-internals. Upstream 0.1.6-alpha.2 moved HMR into
// a normal loader entry declared by the @deepseek-ai/dsh-base bundle patch, whose Hmr constructor
// throws "--expose-internals is required for HMR service" when ctx.loader.internal is absent.
//
// This used to be patched by rewriting the entry's `disabled` expression inside
// node_modules/@deepseek-ai/dsh-base/cordis.patch.yml. That is the wrong layer: it edits a
// shipped package's YAML with a text regex, so any upstream rewording of the entry (whitespace,
// quote style, field order) breaks the anchor, and the edit is invisible to `dsh --profile`.
//
// The loader applies the profile's own cordis.patch.yml AFTER every bundle layer, so the same
// effect is reachable as a same-id override row the user owns:
//
//   - id: hmr
//     disabled: true
//
// Consequences the user must accept for that override: in-process HMR is off for this profile.
// Nothing else changes - no tool, no schema, no prompt.
//
// What this block still does: verify an `id: hmr` row exists to override (so the override is not
// a silent no-op) and print the exact row. It writes nothing.
{
  const filename = join(root, "node_modules/@deepseek-ai/dsh-base/cordis.patch.yml");
  const source = await readFile(filename, "utf8");
  // Tolerant of whitespace/quote style: we only need to know the row exists and has a disabled field.
  const hasHmrRow = /-\s+id:\s*hmr\b/.test(source);
  if (!hasHmrRow) {
    throw new Error(
      "dsh HMR guard: @deepseek-ai/dsh-base/cordis.patch.yml has no `id: hmr` row, so a profile " +
        "override would be a silent no-op. Upstream moved or removed the entry - re-derive the " +
        "guard before shipping a host that cannot boot without --expose-internals.",
    );
  }
  if (/-\s+id:\s*hmr\b[\s\S]{0,200}?disabled:\s*true/.test(source)) {
    console.log("ok: dsh HMR entry is already statically disabled upstream - no override needed");
  } else {
    console.log("action required: add this row to the profile's cordis.patch.yml (same-id override):");
    console.log("    - id: hmr");
    console.log("      disabled: true");
  }
}

// ---- client-connection RPC registration: NOT PATCHED (policy) ----
// User policy (stated twice, verbatim): 不准为插件做兼容 / 不 准 为 插 件 做 兼 容.
//
// What the defect is (still true, and still worth reporting upstream): 0.1.6-alpha.2 narrowed
// dsh-client-connection's module-level inject from ['webServer','credentials'] to ['credentials']
// (src/index.ts:84) while the shared plugin-facing register(owner, channel, handler) still reads
// `owner.webServer` with no inject scope (src/rpc-host.ts:158-179), so any plugin calling
// ctx.connection.rpc.handle() throws `cannot get property "webServer" without inject` and the
// whole profile tree fails to load. Upstream HEAD (d347e70390) still carries the wide inject at
// src/index.ts:68, i.e. the narrowing shipped without the matching scoping fix.
//
// Why this port does not patch it anyway: the trigger, the blast radius and the fix all sit on
// the plugin path. Patching the host here is plugin compatibility by another name - it would make
// this port carry a permanent, loudly-anchored edit on the single most volatile file in the
// release, and it would hide the debt the plugins owe. An earlier revision of this script did
// patch it (commits 8d87ba3 / 4c26a7d); both are withdrawn.
//
// MEASURED, both ways, on this machine (2026-09-20, full 0.1.6-alpha.2 tree build/package with all
// 28 profile bundles, real profile web/, HMR already overridden):
//   pristine client-connection + dsh-pocket/dsh-automation ENABLED:
//     exit 1, 8x "without inject", "failed to apply loader entry dsh-pocket" and
//     "failed to apply loader entry dsh-automation", "dsh: plugin tree failed to load".
//   pristine client-connection + the two entries DISABLED AT THE PROFILE LAYER:
//     exit 124 (still alive at 50s), 0 error markers, "dsh web: http://127.0.0.1:36573/?token=...".
//     Log: ~/dsh-upgrade-016a2/evidence/boot-policy-disable-174851.log
//
// So the policy-compliant shape exists and works: disable the entries at the profile layer, the
// same treatment ~/.dsh/profiles/web/cordis.patch.yml already gives dsh-seq-injector for the same
// failure family. No package file is edited for this defect, and the fix belongs upstream.
//
// NOTE for whoever revisits this: `inject` is a module-level export, so a cordis.patch.yml entry
// cannot express the scope fix even if that were wanted - profile entries override loader-entry
// options (config/disabled/insert) only. The choice is patch-the-package or disable-the-entry.

const { readdir } = await import("node:fs/promises");
const profileBootMatches = [];
for (const name of await readdir(join(root, "lib"))) {
  if (!/^profile-boot-.*\.js$/.test(name)) continue;
  const source = await readFile(join(root, "lib", name), "utf8");
  if (source.includes("watchUserPatches(ctx")) profileBootMatches.push(join("lib", name));
}
// Upstream <= 0.1.5-rc.2 boots the cordis-plugin-hmr watcher unconditionally and installs
// patch-file watchers via watchUserPatches(). Cordis HMR requires Node's --expose-internals,
// which cannot be passed through NODE_OPTIONS, so the launcher must not create that watcher
// unless the flag was given explicitly.
//
// Upstream 0.1.6-alpha.2 removed watchUserPatches entirely and loads patch files once at boot
// via readProfilePatches()/loadOverlayPatches(), so there is no unconditional HMR watcher left
// to guard. That is a legitimate upstream fix of the same defect, not a refactor that would
// silently lose the patch. The branch below distinguishes the two cases and only skips when the
// modern one-shot patch-loading entry point is actually present, so a future upstream change of
// that entry point still fails loudly instead of shipping unpatched.
if (profileBootMatches.length > 1) {
  throw new Error(`dsh HMR patch: expected at most one implementation chunk, found ${profileBootMatches.length}`);
}
if (profileBootMatches.length === 0) {
  let modernLoader = false;
  for (const name of await readdir(join(root, "lib"))) {
    if (!/^profile-boot-.*\.js$/.test(name)) continue;
    const source = await readFile(join(root, "lib", name), "utf8");
    if (source.includes("readProfilePatches(")) modernLoader = true;
  }
  if (!modernLoader) {
    throw new Error(
      "dsh HMR patch: neither watchUserPatches() nor readProfilePatches() found in any profile-boot chunk; " +
        "upstream changed its patch-loading entry point and this guard must be re-reviewed",
    );
  }
  console.log("skipped: dsh HMR guard: upstream loads patch files once at boot (no unconditional HMR watcher to guard)");
}
const [profileBoot] = profileBootMatches;

if (profileBoot !== undefined)
  await replaceOnce(
    profileBoot,
  `\t\tif (ctx.get("hmr") === void 0) {
\t\t\tif (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
\t\t\tawait ctx.loader.create({
\t\t\t\tname: "@deepseek-ai/cordis-plugin-hmr",
\t\t\t\tconfig: { root: [] }
\t\t\t});
\t\t}
		await watchUserPatches(ctx, {
			binName: NAME,
			filename: composed.profile.patchPath,
			compose: composeLive
		});
		await watchUserPatches(ctx, {
			binName: NAME,
			filename: homePatchPath(),
			compose: composeLive
		});`,
  `\t\tif (ctx.get("hmr") === void 0 && process.execArgv.includes("--expose-internals")) {
\t\t\tif (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
\t\t\tawait ctx.loader.create({
\t\t\t\tname: "@deepseek-ai/cordis-plugin-hmr",
\t\t\t\tconfig: { root: [] }
\t\t\t});
\t\t}
		if (ctx.get("hmr") !== void 0) {
			await watchUserPatches(ctx, {
				binName: NAME,
				filename: composed.profile.patchPath,
				compose: composeLive
			});
			await watchUserPatches(ctx, {
				binName: NAME,
				filename: homePatchPath(),
				compose: composeLive
			});
		}`,
  "dsh: skip patch-file HMR without --expose-internals",
  );

// The fs/promises import list is not stable across upstream releases: 0.1.6-alpha.2 added lstat
// and dropped rename. Insert `rename` into whatever the list actually is instead of pinning it,
// so the patch keeps working across upstream releases and still fails if the import disappears.
{
  const filename = join(root, "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js");
  const source = await readFile(filename, "utf8");
  const match = source.match(/import \{ ([^}]*?) \} from "node:fs\/promises";/);
  if (match === null) {
    throw new Error("session persistence: no node:fs/promises import found");
  }
  const names = match[1].split(",").map((part) => part.trim());
  if (names.includes("rename")) {
    console.log("skipped: session persistence: rename already imported");
  } else {
    names.push("rename");
    names.sort();
    await writeFile(filename, source.replace(match[0], `import { ${names.join(", ")} } from "node:fs/promises";`));
    console.log("patched: session persistence: import rename");
  }
}

await replaceOnce(
  "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
  "\t\t\tawait link(tmp, finalPath);",
  "\t\t\tif (process.platform === \"android\") await rename(tmp, finalPath);\n\t\t\telse await link(tmp, finalPath);",
  "session persistence: publish with rename on Android",
);

// ---- flock: Termux android has no node-addon-system platform prebuild ----
// dsh-session-persistence-jsonl takes an exclusive flock(2) on session.lock through
// @deepseek-ai/node-addon-system/flock. That entry only accepts platform 'linux'/'darwin'
// and resolves the addon from `@deepseek-ai/node-addon-system-<platform>-<arch>`; on Termux
// process.platform === "android", so it throws "flock is not supported on android-arm64"
// the first time a session write takes the lock. Upstream 0.1.6 still has this (thread:
// https://github.com/deepseek-ai/deepseek-harness/discussions/6148).
//
// Android is a Linux userland with flock(2) in bionic; what is missing is only the
// android-arm64 binding package. This port therefore routes the platform gate on android
// to a binding implemented over koffi - which is already a hard dependency of
// dsh-session-persistence-jsonl (^3.1.0) and ships android-arm64 prebuilds in the tree -
// calling libc's flock() with the same LOCK_EX|LOCK_NB semantics as the native addon.
// Shape borrowed from zexadev/dsh-tether scripts/android-flock-shim.mjs (deployed in
// production); errno convention kept: callback receives 0 for success or a POSITIVE errno,
// the caller negates it before getSystemErrorName().
{
  const filename = join(root, "node_modules/@deepseek-ai/node-addon-system/lib/flock.js");
  const source = await readFile(filename, "utf8");
  const anchor = "    if (platform !== 'linux' && platform !== 'darwin') {";
  const hits = source.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(
      `flock: expected exactly one platform gate in node_modules/@deepseek-ai/node-addon-system/lib/flock.js, found ${hits} - re-review`,
    );
  }
  if (source.includes("__tetherAndroidFlock")) {
    console.log("skipped: flock: android koffi binding already injected");
  } else {
    const prelude = `let __flockAndroidBinding;
/** Termux/android has no node-addon-system binding; use koffi (already a dependency) -> libc flock(2). */
function __tetherAndroidFlock() {
    if (__flockAndroidBinding)
        return __flockAndroidBinding;
    const koffi = createRequire(import.meta.url)('koffi');
    const flock = koffi.load('libc.so').func('int flock(int fd, int operation)');
    __flockAndroidBinding = {
        tryLock(fd, callback) {
            // LOCK_EX | LOCK_NB. Callback convention: 0 for success, POSITIVE errno for
            // failure - the caller negates it before getSystemErrorName(). A negative
            // errno here would come back positive and make that function throw.
            const rc = flock(fd, 2 | 4);
            callback(rc === 0 ? 0 : koffi.errno());
        },
    };
    return __flockAndroidBinding;
}
`;
    const into = `    if (platform === 'android') return __tetherAndroidFlock();
    if (platform !== 'linux' && platform !== 'darwin') {`;
    await writeFile(filename, prelude + source.replace(anchor, into));
    console.log("patched: flock: route android to koffi/libc flock(2) binding");
  }
}

