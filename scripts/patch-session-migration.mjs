#!/usr/bin/env node

/**
 * 让 0.1.6-alpha.2 的 v0 会话迁移层接受「历史格式变体」。
 *
 * 背景（实测，非推断）：
 *   0.1.2 直读 v0 会话，不做 schema 校验，因此容忍 v0 存续期间被写进去的几种写法。
 *   0.1.6 引入 v0→v1→v2→v3 迁移链，逐事件做「冻结发布的成员白名单」校验，
 *   任何未收录成员 → SessionFormatUnsupportedMigrationError → 整个会话不可读。
 *   本机全量实测：3097 个会话中 1505 个被拒（其中主会话 309 个）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 归因纪律（本脚本最重要的部分）
 *
 * 每一处放宽都标注它属于哪一类。「上游有缺陷」「上游遗漏」「插件违约」是三件
 * 不同的事，混为一谈会让后续维护者误判该找谁修。判据统一为：
 *   **该值是否出现在上游的 release 校验源码里**（session-format-v0-to-v1 /
 *   session-format-v2-to-v3 的 src/）。出现 = 上游认可；零出现 = 插件自造。
 *
 * [DEFECT] 上游两层自相矛盾 —— 真缺陷，无取舍空间
 *   subagent/descriptor 的非当前版本：消费端 dsh-subagent parseSubagentDescriptor
 *   （lib/index.js:1402）对 version !== 3 返回 void 0（优雅跳过），而守护它的迁移层
 *   在 session-format-v0-to-v1 里 throw。上游自己已选容忍语义，迁移层违背了它。
 *
 * 本脚本**只修这一类**。曾经补过、现已全部删除的两类，见文件中部
 * 「明确不补的三处：插件兼容」区块 —— 它们都不是上游问题，是插件把契约外成员
 * 写进上游事件；宿主容忍等于替插件背兼容，会冻结写入侧的欠债。
 *
 * 设计原则：不删除任何校验分支；只把迁移层拉回它本来就承诺的语义（与消费端一致）。
 * 值本身仍受类型校验，真正畸形的载荷照样 loud fail。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  throw new Error("usage: patch-session-migration.mjs <dsh-package-directory>");
}

const V0_TO_V1 = "node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js";
const V2_TO_V3 = "node_modules/@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js";

/** 本次运行按归因分组的登记表，收尾打印，便于产物审计。 */
const attribution = [];
function record(kind, label) {
  attribution.push({ kind, label });
}

async function patchOnce(relativePath, before, after, label, alreadyMarker) {
  const filename = join(root, relativePath);
  const source = await readFile(filename, "utf8");
  const matches = source.split(before).length - 1;
  if (matches === 1) {
    await writeFile(filename, source.replace(before, after));
    console.log(`patched: ${label}`);
    return "patched";
  }
  if (matches === 0 && alreadyMarker !== undefined && source.includes(alreadyMarker)) {
    console.log(`skipped: ${label} (already patched)`);
    return "skipped";
  }
  throw new Error(`${label}: expected exactly one match in ${relativePath}, found ${matches}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 明确不补的三处：插件兼容（2026-09-20 用户政策：不准为插件做兼容）
//
// 下面这些曾经被本脚本补过，现已**全部删除**。它们不是上游缺陷，也不是上游
// 遗漏，而是第三方插件把契约外成员写进了上游事件。宿主容忍它们 = 替插件背
// 兼容，会让插件永远不必修正写入侧。删掉后这些会话不可读，这是有意的代价。
//
// ① compaction/summary 的 6 个 acp-kernel 块模型成员
//      tier / kernelBlockId / parentBlockIds / directMessageIds /
//      effectiveMessageIds / topic
//      写入者 billion-context-dsh@0.2.19（dist/index.js:3035、:3096）
//      上游 v3 契约 packages/compaction/compaction/src/types.ts:34-100 不含它们，
//      整棵上游源码 grep 零出现。全量语料 209 个会话命中（主会话 132 个）。
//
// ② tool-workflow/run-start 的 turn
//      写入者 @dsh-external/workflow@0.1.2。
//      v0 disposition 为 disposition(["runId","name"])（dispositions.ts:193）。
//      全量语料 76 个会话命中（主会话 75 个）。
//
// ③ v2-to-v3 SOURCE_KINDS 的四个 kind
//      'instruction-hint' / 'automation' 是插件自造（上游校验源码零出现）。
//      'fallback' / 'provider' 虽被上游校验源码认可
//        （payload-validation.ts:912 literalValue(source['kind'], ['fallback','user'])
//         payload-validation.ts:905 if (source['kind'] === 'provider')）
//      但这一处补丁整体只为让插件写下的数据可读，同为插件兼容，一并删除。
//      全量语料 67 个会话命中（全是主会话）。
//
// 正解在写入侧：插件应改用官方扩展通道（session-format-v0-to-v1/src/
// relationships.ts:64 extensions.stepEvents）或自有事件类型；或由上游扩大 v3 契约。
// ═════════════════════════════════════════════════════════════════════════

// ---- 4a. [DEFECT] 事件载荷入口：v0 分支不再对旧代描述符 throw，改为原样携带 ----
record("DEFECT", "subagent/descriptor passthrough at the v0 payload gate");
await patchOnce(
  V0_TO_V1,
  `\t\tconst descriptorVersion = sessionFormatCount(data["version"], \`\${event.type} \${event.seq} version\`);
\t\tif (version === 0) throw new SessionFormatUnsupportedMigrationError(\`\${event.type} \${event.seq} uses unsupported descriptor version \${descriptorVersion}\`);
\t\treturn;`,
  `\t\tconst descriptorVersion = sessionFormatCount(data["version"], \`\${event.type} \${event.seq} version\`);
\t\tif (version === 0) {
\t\t\t/* Carried through as released: the consuming runtime skips non-current
\t\t\t * descriptors rather than refusing them (dsh-subagent
\t\t\t * parseSubagentDescriptor returns undefined for version !== 3).
\t\t\t * MIGRATION_DESCRIPTOR_PASSTHROUGH */
\t\t\tvoid descriptorVersion;
\t\t\treturn;
\t\t}
\t\treturn;`,
  "session-format: carry released non-current subagent descriptors through the v0 payload gate",
  `\t\t\t/* Carried through as released: the consuming runtime skips non-current`,
);

// ---- 4b. [DEFECT] 语义校验入口：覆盖 version 1/2 的通用校验路径 ----
//
// 门必须装在函数入口，不能只装在 4a 的 v0 分支：
// 同一条 v2 描述符会在三代校验里各被看一次 —— v0→v1 走 assertReleasedPayloadSemantics(…, 1)
// → :462 case "subagent/descriptor" → subagentDescriptorValue；v2→v3 走 (…, 2) 同路径；
// 只有 (…, 0) 才命中 4a 那个分支。两处合起来才覆盖全部三代。
// （教训：同一语义可能有多道闸，装一处不等于修好。）
record("DEFECT", "subagent/descriptor alignment with runtime semantics");
await patchOnce(
  V0_TO_V1,
  `function subagentDescriptorValue(data, label) {
\tliteralValue(data["version"], [3], \`\${label} version\`);`,
  `function subagentDescriptorValue(data, label) {
\t/*
\t * The runtime that consumes these artifacts treats a non-current subagent
\t * descriptor as ignorable rather than fatal: dsh-subagent
\t * parseSubagentDescriptor returns undefined for version !== 3, and
\t * foldSubagentDescriptor propagates that undefined unchanged, so the
\t * record is skipped. The migration layer must not be stricter than the
\t * layer it feeds, so a released descriptor from an older generation is
\t * carried through untouched instead of failing the whole Session.
\t * The value is still required to be a count so genuinely malformed
\t * payloads keep failing loudly.
\t */
\tif (sessionFormatCount(data["version"], \`\${label} version\`) !== 3) return;
\tliteralValue(data["version"], [3], \`\${label} version\`);`,
  "session-format: align migration with runtime on non-current subagent descriptors",
  `if (sessionFormatCount(data["version"], \`\${label} version\`) !== 3) return;`,
);

console.log("session-migration patches applied");
console.log("applied relaxations (all of them are upstream [DEFECT] fixes):");
for (const kind of ["DEFECT"]) {
  const rows = attribution.filter((entry) => entry.kind === kind);
  for (const row of rows) console.log(`  [${kind}] ${row.label}`);
}
console.log("deliberately NOT patched (plugin compatibility, see the mid-file block):");
console.log("  compaction/summary acp-kernel members, tool-workflow/run-start.turn,");
console.log("  and the four plugin-written message source kinds.");
