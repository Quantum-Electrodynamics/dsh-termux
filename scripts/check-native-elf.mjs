#!/usr/bin/env node
// CLI wrapper: verify that .node files are AArch64 ELF shared objects.
import { inspectElf } from "./native-elf.mjs";

let failed = false;
for (const path of process.argv.slice(2)) {
  try {
    const { apiLevel } = inspectElf(path);
    console.log(`ok: ${path} (aarch64 elf64${apiLevel === null ? "" : `, android api ${apiLevel}`})`);
  } catch (error) {
    failed = true;
    console.error(`fail: ${error.message}`);
  }
}
if (failed) process.exit(1);
