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
 * [GAP] 上游认可该值、但 v2-to-v3 的 SOURCE_KINDS 漏收了
 *   'fallback' → payload-validation.ts:912 literalValue(source['kind'], ['fallback','user'])
 *   'provider' → payload-validation.ts:905 if (source['kind'] === 'provider')
 *   这两个 kind 是上游格式的一部分，只是 v2-to-v3 那份 Set 没跟上。补进来是
 *   「与上游格式对齐」，不是放宽。
 *
 * [VIOLATION] 第三方插件写进上游事件的契约外成员 —— 上游零归属
 *   判据：compaction/summary 的权威定义 packages/compaction/compaction/src/types.ts:34-100
 *   不含这些成员；且它们在整棵上游源码里零出现。
 *   写入者已定位（本机 profile 实测）：
 *     - billion-context-dsh@0.2.19 → tier / kernelBlockId / parentBlockIds /
 *       directMessageIds / effectiveMessageIds / topic（dist/index.js:3035、:3096）
 *       该插件把 acp-kernel 的块模型压进 DSH 的 compaction/summary；其 region.d.ts
 *       的 AcpBlockLedgerEntry 证明这些字段是它自己的核模型（tier 注释逐字：
 *       "1 (message range), 2 (distills tier-1 blocks), 3 (distills tier-2 blocks)"）。
 *     - @dsh-external/workflow@0.1.2 → tool-workflow/run-start 的 turn
 *     - 自造 source kind 'instruction-hint' / 'automation'（上游校验源码零出现；
 *       'automation' 由 @dsh-external/dsh-automation@0.1.7 写出）
 *
 *   这一组是本脚本**唯一有争议**的部分：它让宿主容忍插件的契约违规，等于替插件
 *   背兼容。保留的理由是「要能读回已经写下的历史数据」；正解在写入侧（插件改用
 *   自己的事件类型），或由上游扩大 v3 的 compaction/summary 契约。见同仓库
 *   docs/ 与本机交接文件 §22 的完整论证。
 *
 * 设计原则：不删除任何校验分支；[DEFECT]/[GAP] 与上游语义对齐，[VIOLATION] 只做
 * 显式、可检索、可回退的容忍。值本身仍受类型校验，真正畸形的载荷照样 loud fail。
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

// ---- [VIOLATION] 1. compaction/summary：billion-context-dsh 写入的 6 个核模型成员 ----
record("VIOLATION", "compaction/summary members (billion-context-dsh)");
await patchOnce(
  V0_TO_V1,
  `\t"compaction/summary": disposition([
\t\t"compactionId",
\t\t"summary",
\t\t"shadowedRange",
\t\t"shadowedSeqs",
\t\t"shadowedTokenCount",
\t\t"provider",
\t\t"model"
\t], [
\t\t"sourceCommandId",
\t\t"maxTokens",
\t\t"usage",
\t\t"rawOutput",
\t\t"llmStreamCall"
\t]),`,
  `\t"compaction/summary": disposition([
\t\t"compactionId",
\t\t"summary",
\t\t"shadowedRange",
\t\t"shadowedSeqs",
\t\t"shadowedTokenCount",
\t\t"provider",
\t\t"model"
\t], [
\t\t"sourceCommandId",
\t\t"maxTokens",
\t\t"usage",
\t\t"rawOutput",
\t\t"llmStreamCall",
\t\t"tier",
\t\t"kernelBlockId",
\t\t"parentBlockIds",
\t\t"directMessageIds",
\t\t"effectiveMessageIds",
\t\t"topic"
\t]),`,
  "session-format: accept released v0 compaction/summary members (billion-context-dsh kernel block model)",
  `\t\t"tier",
\t\t"kernelBlockId",
\t\t"parentBlockIds",`,
);

// ---- [VIOLATION] 2. tool-workflow/run-start：@dsh-external/workflow 写入的 turn ----
record("VIOLATION", "tool-workflow/run-start.turn (@dsh-external/workflow)");
await patchOnce(
  V0_TO_V1,
  `\t"tool-workflow/run-start": disposition(["runId", "name"]),`,
  `\t"tool-workflow/run-start": disposition(["runId", "name"], ["turn"]),`,
  "session-format: accept released v0 tool-workflow/run-start member (turn)",
  `"tool-workflow/run-start": disposition(["runId", "name"], ["turn"])`,
);

// ---- 3. v2-to-v3 SOURCE_KINDS：上游认可的两个 kind 补进来 + 插件自造的两个 ----
// 必须合成一次写入：它们改的是同一个 Set 的同一处尾部。
// fallback / provider 属 [GAP]（上游认可，v3 的 Set 漏收）。
// instruction-hint / automation 属 [VIOLATION]（上游校验源码零出现）。
record("GAP", "message source kinds fallback, provider (upstream-recognised)");
record("VIOLATION", "message source kinds instruction-hint, automation (plugin-invented)");
await patchOnce(
  V2_TO_V3,
  `\t"subagent-report",
\t"subagent-settled",
\t"webhook",
\t"agent-message"
]);`,
  `\t"subagent-report",
\t"subagent-settled",
\t"webhook",
\t"agent-message",
\t"fallback",
\t"provider",
\t"instruction-hint",
\t"automation"
]);`,
  "session-format: accept released message source kinds (fallback, provider = upstream GAP; instruction-hint, automation = plugin VIOLATION)",
  `\t"fallback",
\t"provider",
\t"instruction-hint",
\t"automation"
]);`,
);

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
console.log("attribution of every relaxation (see the header block for the criteria):");
for (const kind of ["DEFECT", "GAP", "VIOLATION"]) {
  const rows = attribution.filter((entry) => entry.kind === kind);
  for (const row of rows) console.log(`  [${kind}] ${row.label}`);
}
