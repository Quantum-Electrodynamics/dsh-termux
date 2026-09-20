#!/usr/bin/env node

/**
 * 让 0.1.6-alpha.2 的 v0 会话迁移层接受「历史格式变体」。
 *
 * 背景（实测，非推断）：
 *   0.1.2 直读 v0 会话，不做 schema 校验，因此容忍 v0 存续期间上游改过的几种写法。
 *   0.1.6 引入 v0→v1→v2→v3 迁移链，逐事件做「冻结发布的成员白名单」校验，
 *   任何未收录成员 → SessionFormatUnsupportedMigrationError → 整个会话不可读。
 *   本机全量实测：3097 个会话中 1505 个被拒（其中主会话 309 个）。
 *
 * 四个补丁点全部有全量语料证据（不是猜）：
 *   1. compaction/summary 的真实成员 tier / kernelBlockId / directMessageIds /
 *      effectiveMessageIds / topic / parentBlockIds（全量语料仅此 6 个）
 *   2. tool-workflow/run-start 的 turn（可观测为 null）
 *   3. v2-to-v3 的 SOURCE_KINDS 缺 fallback / provider / instruction-hint
 *      （三者都在真实会话里由本机 dsh 自己写出）
 *   4. v0-to-v1 对 subagent/descriptor 的非 v3 版本直接 throw，而运行时
 *      parseSubagentDescriptor 对同一数据是 `return void 0`（优雅跳过）
 *      → 迁移层比它所守护的运行时更严，这是明确的不一致。
 *
 * 设计原则：只放宽到「运行时本来就能处理的范围」，不发明新的宽容度。
 * 不删除任何校验分支，只扩充白名单 / 对齐运行时语义。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  throw new Error("usage: patch-session-migration.mjs <dsh-package-directory>");
}

const V0_TO_V1 = "node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js";
const V2_TO_V3 = "node_modules/@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js";

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

// ---- 1. compaction/summary：补上全量语料里真实存在的 6 个成员 ----
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
  "session-format: accept released v0 compaction/summary members (tier, kernelBlockId, parentBlockIds, directMessageIds, effectiveMessageIds, topic)",
  `\t\t"tier",
\t\t"kernelBlockId",
\t\t"parentBlockIds",`,
);

// ---- 2. tool-workflow/run-start：补上 turn ----
await patchOnce(
  V0_TO_V1,
  `\t"tool-workflow/run-start": disposition(["runId", "name"]),`,
  `\t"tool-workflow/run-start": disposition(["runId", "name"], ["turn"]),`,
  "session-format: accept released v0 tool-workflow/run-start member (turn)",
  `"tool-workflow/run-start": disposition(["runId", "name"], ["turn"])`,
);

// ---- 3. v2-to-v3：补上三个真实存在但未收录的 message source kind ----
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
  "session-format: accept released message source kinds (fallback, provider, instruction-hint, automation)",
  `\t"fallback",
\t"provider",
\t"instruction-hint",
\t"automation"
]);`,
);

// ---- 4a. 事件载荷入口：v0 分支不再对旧代描述符 throw，改为原样携带 ----
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

// ---- 4b. 语义校验入口：覆盖 version 1/2 的通用校验路径 ----
//
// 门必须装在函数入口，不能只装在 4a 的 v0 分支：
// 同一条 v2 描述符会在三代校验里各被看一次 —— v0→v1 走 assertReleasedPayloadSemantics(…, 1)
// → :462 case "subagent/descriptor" → subagentDescriptorValue；v2→v3 走 (…, 2) 同路径；
// 只有 (…, 0) 才命中 4a 那个分支。两处合起来才覆盖全部三代。
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
