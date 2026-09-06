import { parseArgs } from "node:util";
import {
  parseTtl,
  signAgentToken,
  verifyAgentToken,
  READ_SCOPE,
  WRITE_SCOPE,
  type Scope,
} from "./auth/agentToken.js";
import { log } from "./log.js";

/**
 * agent token 签发/校验 CLI（P0 手动签发；P1 起由 Agent Gateway 承担）
 *
 *   npm run token -- issue  --org 1 --sid poc-1 --scopes rd:read,rd:write --ttl 2h
 *   npm run token -- verify thm_v1.xxx.yyy
 */

const USAGE = `用法：
  npm run token -- issue  --org <组织ID> --sid <会话ID> [--scopes rd:read,rd:write] [--ttl 2h]
  npm run token -- verify <token>
环境变量：TECHHAVEN_TOKEN_SECRET 必须设置（与 MCP Server 侧一致）`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      org: { type: "string" },
      sid: { type: "string" },
      scopes: { type: "string" },
      ttl: { type: "string" },
    },
  });

  const secret = process.env.TECHHAVEN_TOKEN_SECRET?.trim();
  const cmd = positionals[0];

  if (cmd === "issue") {
    if (!secret) {
      console.error("缺少环境变量 TECHHAVEN_TOKEN_SECRET");
      console.error(USAGE);
      process.exit(1);
    }
    const org = Number(values.org);
    if (!Number.isFinite(org) || org <= 0) {
      console.error("--org 必须是正整数（agent 会绑定到该组织）");
      console.error(USAGE);
      process.exit(1);
    }
    const sid = values.sid?.trim() || `poc-${Date.now()}`;
    const scopes = (values.scopes?.trim() || READ_SCOPE)
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Scope => s === READ_SCOPE || s === WRITE_SCOPE);
    if (scopes.length === 0) {
      console.error(`--scopes 只能包含 ${READ_SCOPE} / ${WRITE_SCOPE}，逗号分隔`);
      process.exit(1);
    }
    const ttlSeconds = parseTtl(values.ttl ?? "2h");
    const now = Math.floor(Date.now() / 1000);
    const token = signAgentToken({ v: 1, sid, org, scopes, iat: now, exp: now + ttlSeconds }, secret);

    console.log("── agent token（粘贴到 TECHHAVEN_AGENT_TOKEN / dsh 的 env 配置）──");
    console.log(token);
    console.log(`── sid=${sid} org=${org} scopes=${scopes.join(",")} ttl=${ttlSeconds}s ──`);
    return;
  }

  if (cmd === "verify") {
    const token = positionals[1];
    if (!secret || !token) {
      console.error("verify 需要 token 参数与 TECHHAVEN_TOKEN_SECRET 环境变量");
      console.error(USAGE);
      process.exit(1);
    }
    const result = verifyAgentToken(token, secret);
    if (result.ok) {
      console.log("✓ 有效");
      console.log(JSON.stringify(result.payload, null, 2));
    } else {
      console.error("✗ 无效：", result.reason);
      process.exit(1);
    }
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((e) => {
  log(e);
  process.exit(1);
});
