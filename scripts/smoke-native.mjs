#!/usr/bin/env node
// Load both native addons out of the assembled package and actually use them.
//
// The Android API level and ELF architecture checks prove a binary *could* load; only running it
// proves it does. Both addons have failed in this port for reasons no static check would catch
// (koffi's statx path, node-pty's spawn), so the build exercises them before packing.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageDir = process.argv[2];
if (packageDir === undefined) {
  console.error("usage: smoke-native.mjs <packageDir>");
  process.exit(1);
}
const require = createRequire(join(packageDir, "package.json"));

// koffi's package.json is not reachable through its "exports" map, so read it from disk.
const versionOf = (name) =>
  JSON.parse(readFileSync(join(packageDir, "node_modules", name, "package.json"), "utf8")).version;

const failures = [];

// The addons in this package are built for android-arm64, so only a host that *is* that target can
// dlopen them. On the x86_64 CI runner require() fails with a wrong-architecture error that says
// nothing about the package being broken - and treating that as a failure would make the build
// unrunnable off-device, while suppressing it would print an "ok:" this host never earned.
// check-native-elf.mjs has already proven ELF architecture and API level statically; the runtime
// proof for these binaries is produced on Termux. So: state the skip plainly, prove nothing falsely.
const target = { platform: "android", arch: "arm64" };
const canLoadTargetBinaries = process.platform === target.platform && process.arch === target.arch;

if (!canLoadTargetBinaries) {
  console.log(
    `skip: ${target.platform}-${target.arch} addons cannot be loaded on ${process.platform}-${process.arch}; ` +
      `ELF architecture and API level were verified statically, runtime behaviour is verified on ${target.platform}`,
  );
} else {
  // koffi: the Android command-execution guard and the Node-API symbol resolution patch both live
  // on this path, so a load plus one real libc call covers them.
  try {
    const koffi = require("koffi");
    const libc = koffi.load("libc.so");
    const getpid = libc.func("int getpid()");
    const pid = getpid();
    if (typeof pid !== "number" || pid <= 0) throw new Error(`getpid() returned ${pid}`);
    console.log(`ok: koffi ${versionOf("koffi")} loaded, libc.getpid()=${pid}`);
  } catch (error) {
    failures.push(`koffi: ${error.message}`);
  }

  // node-pty: spawn a real shell and require both the output and the exit code, because a pty that
  // loads but cannot spawn is the exact failure mode a prebuilt binary can hide.
  try {
    const pty = require("node-pty");
    const child = pty.spawn("bash", ["-c", "printf 'PTY_OK\\n'; printf '42\\n'"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    const output = await new Promise((resolve, reject) => {
      let collected = "";
      const timer = setTimeout(() => reject(new Error(`timed out, output so far: ${JSON.stringify(collected)}`)), 15000);
      child.onData((chunk) => {
        collected += chunk;
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolve({ collected, exitCode });
      });
    });
    if (!output.collected.includes("PTY_OK")) throw new Error(`missing PTY_OK in ${JSON.stringify(output.collected)}`);
    if (output.exitCode !== 0) throw new Error(`exit code ${output.exitCode}`);
    console.log(`ok: node-pty ${versionOf("node-pty")} spawned bash, exit code 0`);
  } catch (error) {
    failures.push(`node-pty: ${error.message}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`fail: ${failure}`);
  process.exit(1);
}
