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

// ---- client-connection: scope the shared RPC registration to webServer (patch 8) ----
// ATTRIBUTION: [DEFECT] - an upstream self-inconsistency, not plugin compatibility. This patch
// changes nothing about which plugins are allowed to do what; it makes the host stop aborting on
// a call the host itself still advertises.
//
// Upstream 0.1.6-alpha.2 narrowed this module's own inject from ['webServer','credentials'] to
// ['credentials'] (src/index.ts:84), and moved its own /api route into a scoped
// ctx.inject(['webServer'], cb) block. That is fine for the module's own code, but the shared
// plugin-facing register(owner, channel, handler) still does
// `owner.effect(() => owner.webServer.register(route), ...)` with no inject scope
// (src/rpc-host.ts:158-179). cordis resolves a service through the fiber chain of the context
// doing the read, so ANY caller of ctx.connection.handle() throws
// `cannot get property "webServer" without inject` and the entire profile tree fails to load.
// Upstream HEAD (d347e70390) still has the wide module inject at src/index.ts:68, i.e. the
// narrowing landed without the matching scoping fix.
//
// Decision rule used here (same three-way rule as patch-session-migration.mjs): a relaxation is
// [DEFECT] when the value in question appears in upstream's OWN validation/consumption source -
// i.e. the host contradicts itself. It is [VIOLATION] when the value appears nowhere upstream
// (a plugin inventing contract). This one is upstream contradicting upstream: the host declares
// the plugin-facing entry point and then makes it throw.
//
// REPRODUCED BOTH WAYS on this machine (2026-09-20, full 0.1.6-alpha.2 tree build/package with
// all 28 profile bundles carried over, real profile web/, HMR already overridden):
//   pristine client-connection (sha256 d38d40e5b47a159c...): exit 1, 8x "without inject",
//     "failed to apply loader entry dsh-pocket" + "failed to apply loader entry dsh-automation",
//     "dsh: plugin tree failed to load", no "dsh web:" line.
//   F1 (this patch, sha256 606ba18b8f0d8693...): exit 124 (still alive at 60s), 0 error markers,
//     "dsh web: http://127.0.0.1:40895/?token=...", dsh-pocket registered its proxy.
//   F2 (module inject restored, :618 pristine): also boots, 0 error markers - so the choice
//     between F1 and F2 is semantic, not about whether the host runs.
// Logs: ~/dsh-upgrade-016a2/evidence/ab-pristine-cc-173445.log, boot-hmr-override-173255.log,
// ab-f2-fullprofile-173555.log.
//
// Why F1 (scope the use site) and not F2 (widen the module inject back):
//   - F1 keeps upstream's deliberate direction: module inject means "services required BEFORE
//     providing Connection", and 0.1.6-alpha.2 deliberately stopped gating connection activation
//     on webServer. F2 would undo that decision.
//   - F1 is minimal: webServer is read in exactly two places in the package - lib/index.js:618
//     (this shared registry, the only unscoped one) and :781 (the module's own /api route, already
//     scoped at :758). registerFetchRoute (:594) and registerInterceptor (:626) never read it.
//   - F1 is isomorphic to the host's own code, which is the strongest available evidence that it
//     is the shape upstream would accept.
//   - Independent corroboration: the third-party fork package @zhengcankai/deepseek-harness
//     documents this exact defect and describes its fix as wrapping the registration in
//     ctx.inject(['webServer']) - word for word the same shape as F1.
//
// The profile layer CANNOT express this fix: a cordis.patch.yml entry overrides loader-entry
// options (config/disabled/insert), while `inject` is a module-level export of the package, so no
// profile override can add it. The only non-package alternative is disabling every entry that
// registers an RPC channel (dsh-pocket, dsh-automation), which buys a boot by deleting function.
//
// This is anchored on the file upstream restructured in this very release, so the anchor is
// expected to move: the branch below fails loudly rather than silently skipping.
{
  const relativePath = "node_modules/@deepseek-ai/dsh-client-connection/lib/index.js";
  const filename = join(root, relativePath);
  const source = await readFile(filename, "utf8");
  const unscoped =
    "\t\treturn owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);";
  const scoped =
    '\t\treturn owner.inject(["webServer"], (webCtx) => webCtx.effect(() => webCtx.webServer.register(route), `client-connection: ${channel} rpc channel`));';
  const unscopedCount = source.split(unscoped).length - 1;
  const scopedCount = source.split(scoped).length - 1;
  if (unscopedCount === 1) {
    await writeFile(filename, source.replace(unscoped, scoped));
    console.log("patched: client-connection: scope the shared RPC registration to webServer");
  } else if (unscopedCount === 0 && scopedCount === 1) {
    console.log("skipped: client-connection: shared RPC registration already scoped (upstream, or patch applied)");
  } else {
    throw new Error(
      `client-connection: expected exactly one shared RPC registration in ${relativePath}, found ` +
        `unscoped=${unscopedCount} scoped=${scopedCount}`,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════

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
