// 服务端口组合检查（审查意见 F3）
//
// 背景：BFF 与 Bridge 的代码默认值都曾是 3092，Nginx 模板把 3092 当作 BFF、
// MCP 示例把 3092 当作 Bridge。两个服务各自的单测都通过（只测自己），
// 同机按默认配置启动完整链路时第二个服务才会端口占用。
//
// 本脚本做「组合视角」的静态核对：
//   1. 从各服务配置源码里读出监听端口默认值，检查互不冲突；
//   2. 从各服务 .env.example 读出实际部署值，检查互不冲突（覆盖默认值后仍可能撞车）；
//   3. 检查 MCP 示例里的 TECHHAVEN_BRIDGE_URL 端口与 Bridge 端口一致。
// 只做读与静态解析，不启动任何服务、不占用端口。

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

/** 端口表：Gateway 3091 / BFF 3092 / Bridge 3093（本次统一后的约定） */
const SERVICES = [
  {
    name: "Gateway",
    envVar: "TECHHAVEN_GATEWAY_PORT",
    source: "services/techhaven-gateway/src/config.ts",
    // let port = 3091;
    sourcePattern: /let port = (\d+);/,
    example: "services/techhaven-gateway/.env.example",
  },
  {
    name: "BFF",
    envVar: "TECHHAVEN_BFF_PORT",
    source: "services/techhaven-bff/src/config.ts",
    // positiveInt(env.TECHHAVEN_BFF_PORT, 3092, ...)
    sourcePattern: /positiveInt\(env\.TECHHAVEN_BFF_PORT,\s*(\d+)/,
    example: "services/techhaven-bff/.env.example",
  },
  {
    name: "Bridge",
    envVar: "TECHHAVEN_BRIDGE_PORT",
    source: "services/techhaven-agent-bridge/src/config.ts",
    // integer(env, "TECHHAVEN_BRIDGE_PORT", 3093, ...)
    sourcePattern: /integer\(env,\s*"TECHHAVEN_BRIDGE_PORT",\s*(\d+)/,
    example: "services/techhaven-agent-bridge/.env.example",
  },
];

function envValue(text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*(\\S+)`, "m").exec(text);
  return match ? match[1].trim() : undefined;
}

const problems = [];
const rows = [];

for (const service of SERVICES) {
  const sourceText = read(service.source);
  const sourceMatch = service.sourcePattern.exec(sourceText);
  if (!sourceMatch) {
    problems.push(`无法从 ${service.source} 解析 ${service.envVar} 默认值（源码结构变化？）`);
    continue;
  }
  const defaultValue = Number(sourceMatch[1]);
  const exampleRaw = envValue(read(service.example), service.envVar);
  const exampleValue = exampleRaw === undefined ? undefined : Number(exampleRaw);
  if (exampleValue !== undefined && !Number.isInteger(exampleValue)) {
    problems.push(`${service.example} 中的 ${service.envVar} 不是整数：${exampleRaw}`);
  }
  rows.push({ name: service.name, envVar: service.envVar, defaultValue, exampleValue });
}

/** 检查一组端口是否有重复 */
function checkConflicts(ports, label) {
  const seen = new Map();
  for (const { name, port } of ports) {
    if (port === undefined) continue;
    const previous = seen.get(port);
    if (previous) problems.push(`${label}：${previous} 与 ${name} 都使用端口 ${port}（同一台机器上第二个服务会启动失败）`);
    else seen.set(port, name);
  }
}

checkConflicts(
  rows.map((r) => ({ name: `${r.name}(代码默认)`, port: r.defaultValue })),
  "代码默认端口",
);
checkConflicts(
  rows.map((r) => ({ name: `${r.name}(.env.example)`, port: r.exampleValue })),
  ".env.example 端口",
);

// MCP → Bridge 的 URL 必须指向 Bridge 端口，而不是 BFF
const bridge = rows.find((r) => r.name === "Bridge");
if (bridge) {
  const expected = bridge.exampleValue ?? bridge.defaultValue;
  const targets = [
    { label: "services/techhaven-mcp/.env.example", file: "services/techhaven-mcp/.env.example" },
    { label: "services/techhaven-mcp/README.md", file: "services/techhaven-mcp/README.md", all: true },
    { label: "README.md", file: "README.md", all: true },
  ];
  for (const target of targets) {
    const text = read(target.file);
    const matches = [...text.matchAll(/TECHHAVEN_BRIDGE_URL[^\n]*?127\.0\.0\.1:(\d+)/g)];
    if (matches.length === 0) continue;
    for (const match of target.all ? matches : matches.slice(0, 1)) {
      const port = Number(match[1]);
      if (port !== expected) {
        problems.push(`${target.label} 的 TECHHAVEN_BRIDGE_URL 端口为 ${port}，与 Bridge 端口 ${expected} 不一致`);
      }
    }
  }
}

console.log("服务端口表：");
for (const row of rows) {
  console.log(`  ${row.name.padEnd(8)} ${row.envVar.padEnd(26)} 代码默认 ${row.defaultValue}   .env.example ${row.exampleValue ?? "(未设置)"}`);
}

if (problems.length > 0) {
  console.error("\n端口组合检查未通过：");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\n端口组合检查通过：无冲突，MCP 的 Bridge URL 与 Bridge 端口一致。");
