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

// ---- HMR service guard (patch 7) ----
// Cordis HMR requires Node's --expose-internals, which cannot be passed through NODE_OPTIONS.
// Upstream <= 0.1.5-rc.2 booted the HMR watcher from the launcher (profile-boot), which this
// port rewrote to only create it under --expose-internals. Upstream 0.1.6-alpha.2 moved HMR into
// a normal loader entry declared by the @deepseek-ai/dsh-base bundle patch, whose Hmr constructor
// throws "--expose-internals is required for HMR service" when ctx.loader.internal is absent.
// The entry's `disabled` expression is therefore extended with the same guard, so the entry
// stays inert unless Node was actually started with the flag.
//
// Verified against the real upstream tree: the guard must be present exactly once, so a future
// upstream change to the entry shape fails the build instead of shipping a host that cannot boot.
{
  const filename = join(root, "node_modules/@deepseek-ai/dsh-base/cordis.patch.yml");
  const source = await readFile(filename, "utf8");
  const pattern = /(- id: hmr\n\s+name: '@deepseek-ai\/dsh-hmr'\n\s+disabled: )!!js "([^"]*)"/;
  const match = source.match(pattern);
  if (match === null) {
    throw new Error("dsh HMR guard: no hmr entry with a disabled expression in @deepseek-ai/dsh-base/cordis.patch.yml");
  }
  const guard = "process.execArgv.includes('--expose-internals')";
  if (match[2].includes(guard)) {
    console.log("skipped: dsh HMR guard: already applied");
  } else {
    await writeFile(
      filename,
      source.replace(pattern, `$1!!js "(${match[2]}) || !${guard}"`),
    );
    console.log("patched: dsh: disable the hmr entry without --expose-internals");
  }
}

// ---- client-connection: scope the shared RPC registration to webServer (patch 8) ----
// Upstream 0.1.6-alpha.2 narrowed this module's own inject from ['webServer','credentials'] to
// ['credentials'], and moved its own /api route into a scoped ctx.inject(['webServer'], cb) block.
// That is fine for the module's own code, but the shared plugin-facing
// register(owner, channel, handler) still does
// `owner.effect(() => owner.webServer.register(route), ...)` with no inject scope. cordis only
// resolves a service through the fiber chain of the context doing the read, so any plugin that
// registers an RPC channel through ctx.connection.handle() throws
// `cannot get property "webServer" without inject` and the entire profile tree fails to load.
//
// Observed first-hand on a real 0.1.6-alpha.2 tree: dsh-pocket.apply ->
// installPocketRpc (dsh-pocket/lib/web-rpc.js:39) -> ctx.connection.handle() -> ... -> throw at
// dsh-client-connection/lib/index.js:618. connection never reached ACTIVE, so 7 dependent entries
// stayed PENDING and the host aborted. dsh-pocket is byte-identical to the 0.1.2 tree and declares
// inject ['connection','webServer'] correctly, so the defect is here, not in the plugin.
//
// The fix wraps the registration in ctx.inject(['webServer'], cb) - exactly the shape the module
// already uses for its own /api route (lib/index.js:758 + :781). Two narrower alternatives were
// considered and rejected:
//
//   - Restoring the module-level inject to ['webServer','credentials'] (what this patch did before)
//     also boots, but it reverts an intentional upstream decision: module inject means "services
//     required BEFORE providing Connection", and 0.1.6-alpha.2 deliberately stopped gating
//     connection activation on webServer. The header comment that used to justify the old
//     declaration ("Activates the webServer Context merge used below") is already stale in
//     alpha2 - it survives in src/index.ts but is gone from the compiled lib/ - so it is not
//     load-bearing any more. This patch must not undo an upstream direction.
//   - webServer is read in exactly two places in the whole package: lib/index.js:618 (this shared
//     registry, the only unscoped one) and :781 (the module's own /api route, already scoped). The
//     sibling registries registerFetchRoute (:594) and registerInterceptor (:626) never touch
//     webServer, so there is no second latent site to fix.
//
// The published package's compiled lib/ is patched because this port consumes the npm package, not
// the upstream monorepo; the same edit is what a source build carries in
// packages/client/connection/src/index.ts.
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
