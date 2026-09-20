#!/usr/bin/env node
// Carry the profile's plugin bundles, and their transitive dependencies, into a built package.
//
// Why this exists: the profile installs its plugins into the *installation's* node_modules (that is
// where `dsh plugin install` puts them), and the profile bundle resolver looks only at the
// installation's node_modules and the profile directory. A freshly built package therefore starts
// with none of them, and the host refuses to boot for every bundle the profile lists.
//
// Copying only the bundles is not enough - each one pulls its own dependency tree, and those
// packages are absent from the upstream tree too (measured: dsh-better-sidebar -> schemastery).
// So the closure is computed from each bundle's declared dependencies and copied wholesale.
//
// Bundles are taken from the profile manifest's `dsh.profile.bundles` rather than a hardcoded list,
// and anything already present in the new package is left untouched, so an upstream version bump is
// never silently overridden by a stale copy.
import { readFileSync, existsSync, mkdirSync, cpSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";

const [packageDir, profileManifest, ...sourceRoots] = process.argv.slice(2);
if (!packageDir || !profileManifest || sourceRoots.length === 0) {
  console.error("usage: carry-over-profile-bundles.mjs <packageDir> <profileManifest> <sourceNodeModules>...");
  process.exit(2);
}

const targetNodeModules = join(packageDir, "node_modules");

function manifestOf(root, name) {
  const path = join(root, name, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The packages live in more than one place on a real machine: the previous installation's
// node_modules holds the plugin bundles, while their own dependencies are usually resolved inside
// the profile's node_modules (pnpm layout). Both are searched, in the order given.
function sourceFor(name) {
  for (const root of sourceRoots) {
    if (existsSync(join(root, name))) return root;
  }
  return null;
}

// Copy one package and walk into everything it needs. `seen` prevents cycles.
//
// The dependency walk must happen even when the package itself is already in the target: a bundle
// can be present while its own dependency tree is not (measured: dsh-better-sidebar was copied in
// but `schemastery` was not), and returning early there would silently ship a package that cannot
// boot the profile. Only the copy is conditional.
const copied = [];
const unavailable = [];
const missingPeers = [];
function carry(name, seen, isPeer = false) {
  if (seen.has(name)) return;
  seen.add(name);
  const inTarget = existsSync(join(targetNodeModules, name));
  const source = sourceFor(name);
  if (!inTarget) {
    if (source === null) {
      // A missing peer is usually build-time only (measured: tsdown, typescript) and does not stop
      // the host from running, so it is reported instead of failing the build.
      if (isPeer) {
        missingPeers.push(name);
        return;
      }
      unavailable.push(name);
      return;
    }
    mkdirSync(dirname(join(targetNodeModules, name)), { recursive: true });
    // dereference: the plugin bundles in the previous installation are symlinks into the profile's
    // own node_modules (all 28 of them on this machine). Copying the link would ship a package whose
    // bundles only resolve while that exact profile directory exists, and a dangling link for anyone
    // else - the tarball must be self-contained.
    cpSync(join(source, name), join(targetNodeModules, name), { recursive: true, dereference: true });
    copied.push(name);
  }
  // Read the dependency list from whichever copy exists, so the walk continues even for a package
  // that came from the upstream tree.
  const manifest = manifestOf(targetNodeModules, name) ?? (source === null ? null : manifestOf(source, name));
  for (const dependency of Object.keys(manifest?.dependencies ?? {})) carry(dependency, seen, false);
  for (const peer of Object.keys(manifest?.peerDependencies ?? {})) carry(peer, seen, true);
}

const profile = JSON.parse(readFileSync(profileManifest, "utf8"));
const roots = [...new Set([...(profile?.dsh?.profile?.bundles ?? []), ...Object.keys(profile?.dependencies ?? {})])];
if (roots.length === 0) {
  console.error(`carry-over: ${profileManifest} lists no bundles or dependencies; refusing to guess`);
  process.exit(4);
}

const seen = new Set();
for (const root of roots.sort()) carry(root, seen);

// A copied package that ended up as a symlink (or that contains no files) would pack into a tarball
// as a dangling link: present in the listing, absent when installed. Check the real shape here.
const empty = [];
for (const name of copied) {
  const path = join(targetNodeModules, name);
  if (lstatSync(path).isSymbolicLink()) {
    empty.push(`${name} (still a symlink)`);
    continue;
  }
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else files += 1;
    }
  };
  try {
    walk(path);
  } catch {
    // unreadable tree is reported by the count being zero
  }
  if (files === 0) empty.push(`${name} (no files)`);
}

console.log(`carry-over: copied ${copied.length} package(s) needed by ${roots.length} profile bundle(s)`);
if (empty.length > 0) {
  console.error(`carry-over: ${empty.length} copied package(s) are empty or unresolvable: ${empty.join(", ")}`);
  process.exit(5);
}
if (missingPeers.length > 0) {
  console.log(`carry-over: ${missingPeers.length} peer dependency/ies not installed anywhere: ${missingPeers.join(", ")}`);
}
if (unavailable.length > 0) {
  // Whether a missing package actually matters cannot be decided by reading manifests: peer-vs-
  // runtime is path dependent (tsdown/typescript are reachable both ways), and a package that is
  // only imported by a code path this profile never runs is harmless. The build therefore reports
  // the gap and continues to the boot check, which is the thing that can actually prove it.
  // Set STRICT_CARRYOVER=true to turn this into a hard failure instead.
  const message = `carry-over: ${unavailable.length} package(s) missing from every source root: ${unavailable.join(", ")}`;
  if (process.env.STRICT_CARRYOVER === "true") {
    console.error(message);
    for (const root of sourceRoots) console.error(`  searched ${root}`);
    console.error("carry-over: run 'dsh plugin --profile <name> install' before building");
    process.exit(4);
  }
  console.warn(`WARNING ${message}`);
  console.warn("carry-over: continuing; the boot check must pass for the package to be usable");
  for (const root of sourceRoots) console.warn(`carry-over:   searched ${root}`);
}
