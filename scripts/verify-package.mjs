#!/usr/bin/env node

import { access, readFile, readdir as readdirAsync } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { inspectElf } from "./native-elf.mjs";

const [root, expectedVersion] = process.argv.slice(2);
if (!root || !expectedVersion) {
  throw new Error("usage: verify-package.mjs <package-directory> <expected-version>");
}

// The official koffi Android prebuild is compiled against android-28 (Android 9), so this port
// now requires API 28+ where the old source build was compiled against android-24. The ceiling is
// asserted rather than assumed: if a future koffi prebuild raises it, the build fails here instead
// of shipping a package that cannot load on the devices this port claims to support.
const ANDROID_DEVICE_API_CEILING = 28;

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.name !== "dsh-termux" || manifest.version !== expectedVersion) {
  throw new Error(`unexpected package identity ${manifest.name}@${manifest.version}`);
}

// koffi ships an official Android arm64 prebuild (@koromix/koffi-android-arm64) since 3.3.1,
// which is used as-is; older koffi versions are compiled from source by build-termux.sh.
// Accept either layout.
const koffiBinary = [
  "node_modules/@koromix/koffi-android-arm64/android_arm64/koffi.node",
  "node_modules/koffi/build/koffi/android_arm64/koffi.node",
];
const required = [
  "lib/bin.js",
  "node_modules/node-pty/prebuilds/android-arm64/pty.node",
  "node_modules/@esbuild/android-arm64/bin/esbuild",
  "node_modules/@img/sharp-wasm32/lib",
];
for (const relativePath of required) {
  await access(join(root, relativePath));
}
let koffiFound = null;
for (const candidate of koffiBinary) {
  try {
    await access(join(root, candidate));
    koffiFound = candidate;
    break;
  } catch {}
}
if (koffiFound === null) {
  throw new Error(`no koffi Android arm64 binary found; looked for:\n  ${koffiBinary.join("\n  ")}`);
}

// The `file ... | grep "ARM aarch64"` checks in build-termux.sh cannot run here (the Termux image
// has no `file`), and they never checked the Android API level at all. Both are checked directly,
// because a wrong-architecture or too-new binary packs fine and only fails on the user's device.
const nativeBinaries = [
  join(root, koffiFound),
  join(root, "node_modules/node-pty/prebuilds/android-arm64/pty.node"),
];
for (const binary of nativeBinaries) {
  const { apiLevel } = inspectElf(binary);
  if (apiLevel !== null && apiLevel > ANDROID_DEVICE_API_CEILING) {
    throw new Error(
      `${binary.slice(root.length + 1)} requires android api ${apiLevel}, above the supported ceiling ${ANDROID_DEVICE_API_CEILING}`,
    );
  }
}

const profileFiles = [];
for (const name of await readdirAsync(join(root, "lib"))) {
  if (!/^profile-boot-.*\.js$/.test(name)) continue;
  const source = await readFile(join(root, "lib", name), "utf8");
  if (source.includes("watchUserPatches(ctx")) profileFiles.push(name);
}
// Upstream <= 0.1.5-rc.2 has exactly one profile-boot chunk that boots the HMR watcher, which the
// HMR guard patch rewrites. Upstream >= 0.1.6-alpha.2 removed watchUserPatches and loads patch files
// once at boot via readProfilePatches(), so the patch is a no-op skip. Require that the modern entry
// point really is present, so a future refactor cannot pass verification unpatched.
if (profileFiles.length > 1) throw new Error(`expected at most one profile-boot implementation, found ${profileFiles.length}`);
if (profileFiles.length === 0) {
  let modernLoader = false;
  for (const name of await readdirAsync(join(root, "lib"))) {
    if (!/^profile-boot-.*\.js$/.test(name)) continue;
    const source = await readFile(join(root, "lib", name), "utf8");
    if (source.includes("readProfilePatches(")) modernLoader = true;
  }
  if (!modernLoader) {
    throw new Error("no profile-boot patch-loading entry point found (neither watchUserPatches nor readProfilePatches)");
  }
}

// Upstream <= 0.1.5-rc.2 boots the HMR watcher from a profile-boot chunk that this port rewrites
// (guard marker expected there). Upstream >= 0.1.6-alpha.2 moved HMR into a loader entry owned by
// the @deepseek-ai/dsh-base bundle patch; this port no longer edits that YAML - the guard is a
// same-id override in the profile's own cordis.patch.yml. So instead of a HMR marker in the
// package, verify the thing the override depends on: that an `id: hmr` row still exists to
// override. If upstream renames or removes it, the override becomes a silent no-op - fail here.
let hmrOverrideTargetPresent = true;
{
  const dshBasePatch = join(root, "node_modules", "@deepseek-ai", "dsh-base", "cordis.patch.yml");
  let source;
  try {
    source = await readFile(dshBasePatch, "utf8");
  } catch {
    hmrOverrideTargetPresent = false;
    source = "";
  }
  if (hmrOverrideTargetPresent && !/-\s+id:\s*hmr\b/.test(source)) hmrOverrideTargetPresent = false;
}

const checks = [
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "defined(__ANDROID__)"],
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "__ANDROID_API__ < 28"],
  [join("node_modules", "koffi", "src", "koffi", "CMakeLists.txt"), "--unresolved-symbols=ignore-all"],
  ...(profileFiles.length === 1
    ? [[join("lib", profileFiles[0]), "process.execArgv.includes(\"--expose-internals\")"]]
    : []),
  [join("node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib", "index.js"), "process.platform === \"android\""],
  [join("node_modules", "@deepseek-ai", "node-addon-system", "lib", "flock.js"), "if (platform === 'android') return __tetherAndroidFlock();"],
];
for (const [relativePath, needle] of checks) {
  const source = await readFile(join(root, relativePath), "utf8");
  if (!source.includes(needle)) throw new Error(`missing patch marker in ${relativePath}`);
}
if (!hmrOverrideTargetPresent) {
  throw new Error(
    "no `id: hmr` row in node_modules/@deepseek-ai/dsh-base/cordis.patch.yml: the profile-level HMR " +
      "override would be a silent no-op. Re-derive the HMR guard before shipping this build.",
  );
}

// ---- closure integrity gate ----
// npm pack's bundledDependencies semantics only bundle direct dependencies and can
// silently drop packages that resolved as transitive-only (0.1.2-rc.1 lost
// @deepseek-ai/dsh-settings, dsh-bash-local, dsh-session-query this way while every
// patch marker still matched). This gate checks HOST-side runtime imports only:
// every `@deepseek-ai/...` import referenced by root lib and the @deepseek-ai packages
// (excluding browser-bundle files, which resolve through the bundler with its own
// aliases) must exist in node_modules/@deepseek-ai. Bare specifiers are skipped: they
// may legitimately be nested or bundler-aliased, and were not the failure mode here.
const requiredCore = ["@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-bash-local", "@deepseek-ai/dsh-session-query"];
for (const pkg of requiredCore) {
  await access(join(root, "node_modules", ...pkg.split("/")));
}

// every @deepseek-ai package present at node_modules top level
const present = new Set();
for (const entry of readdirSync(join(root, "node_modules"), { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("@")) {
    for (const sub of readdirSync(join(root, "node_modules", entry.name), { withFileTypes: true })) {
      if (sub.isDirectory()) present.add(`${entry.name}/${sub.name}`);
    }
  }
}

function* walkHostJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === "node_modules" || entry.name === "client") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkHostJs(full);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name) && entry.name !== "client.js") {
      yield full;
    }
  }
}

const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|(?:^|\n)\s*import\s+)(["'])([^"']+)\1/g;
const missing = new Map();
for (const scanRoot of [join(root, "lib"), join(root, "node_modules", "@deepseek-ai")]) {
  for (const file of walkHostJs(scanRoot)) {
    const source = await readFile(file, "utf8");
    for (const [, , spec] of source.matchAll(importRe)) {
      if (!spec.startsWith("@deepseek-ai/") || spec.includes("${")) continue;
      const pkg = spec.split("/").slice(0, 2).join("/");
      if (present.has(pkg)) continue;
      if (!missing.has(pkg)) missing.set(pkg, new Set());
      missing.get(pkg).add(file.slice(root.length + 1));
    }
  }
}
if (missing.size > 0) {
  const lines = [...missing.entries()].map(
    ([name, files]) => `  ${name} <- ${[...files].slice(0, 3).join(", ")}${files.size > 3 ? "..." : ""}`
  );
  throw new Error(`closure integrity failed, unresolvable @deepseek-ai imports:\n${lines.join("\n")}`);
}

console.log(`verified ${manifest.name}@${manifest.version} (${manifest.bundledDependencies?.length ?? 0} bundled deps, closure ok)`);
