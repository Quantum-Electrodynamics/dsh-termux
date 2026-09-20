// ELF inspection shared by the build-time architecture check and the package verifier.
//
// scripts/build-termux.sh used `file ... | grep "ARM aarch64"`, but the Termux image has no
// `file`, so the checks read the ELF header directly instead. The Android API level recorded in
// .note.android.ident is reported too: an architecture-correct addon can still be unloadable on a
// given device, and for prebuilt binaries that is the realistic failure mode.
import { readFileSync } from "node:fs";

export const EM_AARCH64 = 0xb7;

export function inspectElf(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 64 || buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw new Error(`${path}: not an ELF file`);
  }
  if (buffer[4] !== 2) throw new Error(`${path}: not ELF64`);
  if (buffer[5] !== 1) throw new Error(`${path}: not little-endian`);
  const machine = buffer.readUInt16LE(18);
  if (machine !== EM_AARCH64) {
    throw new Error(`${path}: e_machine=0x${machine.toString(16)}, expected 0x${EM_AARCH64.toString(16)} (AArch64)`);
  }
  return { path, apiLevel: androidApiLevel(buffer) };
}

// Walk the section table for .note.android.ident and read its api_level descriptor.
function androidApiLevel(buffer) {
  const sectionOffset = Number(buffer.readBigUInt64LE(0x28));
  const sectionEntrySize = buffer.readUInt16LE(0x3a);
  const sectionCount = buffer.readUInt16LE(0x3c);
  const namesIndex = buffer.readUInt16LE(0x3e);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * sectionEntrySize;
    sections.push({
      name: buffer.readUInt32LE(offset),
      offset: Number(buffer.readBigUInt64LE(offset + 0x18)),
    });
  }
  const names = sections[namesIndex];
  const sectionName = (index) => {
    let cursor = names.offset + index;
    let value = "";
    while (buffer[cursor] !== 0) value += String.fromCharCode(buffer[cursor++]);
    return value;
  };
  const note = sections.find((section) => sectionName(section.name) === ".note.android.ident");
  if (note === undefined) return null;
  const nameSize = buffer.readUInt32LE(note.offset);
  const descriptorOffset = note.offset + 12 + Math.ceil(nameSize / 4) * 4;
  return buffer.readUInt32LE(descriptorOffset);
}
