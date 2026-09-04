#!/usr/bin/env node

import { access, readFile, readdir as readdirAsync } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const [root, expectedVersion] = process.argv.slice(2);
if (!root || !expectedVersion) {
  throw new Error("usage: verify-package.mjs <package-directory> <expected-version>");
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.name !== "dsh-termux" || manifest.version !== expectedVersion) {
  throw new Error(`unexpected package identity ${manifest.name}@${manifest.version}`);
}

const required = [
  "lib/bin.js",
  "node_modules/node-pty/prebuilds/android-arm64/pty.node",
  "node_modules/koffi/build/koffi/android_arm64/koffi.node",
  "node_modules/@esbuild/android-arm64/bin/esbuild",
  "node_modules/@img/sharp-wasm32/lib",
];
for (const relativePath of required) {
  await access(join(root, relativePath));
}

const profileFiles = [];
for (const name of await readdirAsync(join(root, "lib"))) {
  if (!/^profile-boot-.*\.js$/.test(name)) continue;
  const source = await readFile(join(root, "lib", name), "utf8");
  if (source.includes("watchUserPatches(ctx")) profileFiles.push(name);
}
if (profileFiles.length !== 1) throw new Error(`expected one profile-boot implementation, found ${profileFiles.length}`);

const checks = [
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "defined(__ANDROID__)"],
  [join("node_modules", "koffi", "lib", "native", "base", "base.cc"), "__ANDROID_API__ < 28"],
  [join("node_modules", "koffi", "src", "koffi", "CMakeLists.txt"), "--unresolved-symbols=ignore-all"],
  [join("lib", profileFiles[0]), "process.execArgv.includes(\"--expose-internals\")"],
  [join("node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib", "index.js"), "process.platform === \"android\""],
];
for (const [relativePath, needle] of checks) {
  const source = await readFile(join(root, relativePath), "utf8");
  if (!source.includes(needle)) throw new Error(`missing patch marker in ${relativePath}`);
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
