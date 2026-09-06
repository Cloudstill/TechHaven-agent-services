# techhaven-mcp

TechHaven 研发平台的 MCP adapter。它把工单/需求/缺陷操作暴露为结构化工具，是 TH-RFC-001 的「工具流」（agent → TechHaven）边界。对于不能改造的旧后端，推荐使用 `bridge` 模式，把旧 API 差异交给独立的 `../techhaven-agent-bridge/`。

> 当前状态：`implemented + verified-mock`。6 读 + 1 写、direct/staged、token、审计、PG 权威 proposal repository 与并发 worker 串行化已实现；真实产品后端与 live PostgreSQL 尚未验证。架构见 `../../docs/ARCHITECTURE.md`，决策见 `../../docs/TH-RFC-001-agent-engine.md`，门禁见 `../../docs/ROADMAP.md`。

## 快速开始

```bash
npm install
npm run typecheck
npm test          # 纯域单测（node:test + tsx，无新增依赖，无需外部实例）
npm run build

# 1) 签发一个 agent token（绑定 org 1，读写 scope，2 小时时效）
TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me \
  npm run token -- issue --org 1 --sid poc-1 --scopes rd:read,rd:write --ttl 2h

# 2) 端到端冒烟（自动起 server 进程、走完整 MCP 握手、调用全部关键路径）
TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me npm run smoke
```

`npm test` 覆盖无外部依赖的纯逻辑：`src/domain/stateMachine.test.ts`（工单状态机合法/非法迁移、终态、未知状态安全降级）与 `src/auth/agentToken.test.ts`（签发/校验往返、错误密钥、格式畸形、payload 篡改、过期、scope/sid/org 校验、TTL 解析）。它用 Node 内置 `node:test` 驱动，**不引入任何新依赖**，也不需要 PostgreSQL 或真实域后端。

> 构建用 `tsconfig.build.json` 排除 `*.test.ts`，因此 `dist/` 内不含测试产物；`npm run typecheck` 仍覆盖测试文件。

smoke 通过只证明 **mock/离线工具流**：9 项 direct、11 项 staged，以及 6 项 HTTP adapter contract（service Bearer、org、幂等键、errno、超时）。它不证明真实域 API、live dsh 或 PostgreSQL 已完成集成。

## 运行模式

| 模式                               | 说明                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `TECHHAVEN_BACKEND=mock`（默认）   | 内置 8 条演示数据（3 需求 + 3 缺陷 + 2 任务，org 1），零依赖跑通全流程                 |
| `TECHHAVEN_BACKEND=bridge`（推荐） | 调独立 Agent Bridge 的规范化内部 API；MCP 不接触旧后端路径、Cookie、`errno` 或数字状态 |
| `TECHHAVEN_BACKEND=http`           | MCP 直接调用旧 `/rd/*`；仅保留给契约已经完全一致的后端，需 `TECHHAVEN_SERVICE_TOKEN`   |

HTTP 和 Bridge 模式默认 5 秒超时，可用 `TECHHAVEN_API_TIMEOUT_MS` 设置 100–60000 ms；网络错误会归一化并失败关闭。

默认域 API 基址为 `https://techhaven.website/api/v1`。本轮匿名探测确认 `/rd/tasks` 路由存在并返回统一结构的 `errno=1101`（未登录）；这只验证路由/错误壳，不证明 service Bearer 已被后端接受。

agent token 只用于本服务与引擎之间的鉴权与审计，**不会**传给 Bridge 或旧后端。Bridge 模式只传内部 Bridge token、会话 ID 和组织 ID；旧后端凭据由 Bridge 单独持有。这落实了「凭据分层、agent 只持 scoped token」的原则。

### 完整配置

| 环境变量                         | 必填条件           | 默认值                             | 说明                                                                  |
| -------------------------------- | ------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| `TECHHAVEN_AGENT_TOKEN`          | 运行 server 必填   | 无                                 | 用 token CLI 签发的 session/org/scope token                           |
| `TECHHAVEN_TOKEN_SECRET`         | 必填               | 无                                 | agent token HMAC 密钥；与签发方共享，不得复用 Bridge 或 Gateway token |
| `TECHHAVEN_AGENT_NAME`           | 否                 | `techhaven-mcp-poc`                | 审计和 Agent 身份显示名                                               |
| `TECHHAVEN_BACKEND`              | 否                 | `mock`                             | `mock`、`bridge` 或 `http`                                            |
| `TECHHAVEN_BRIDGE_URL`           | bridge 模式必填    | 无                                 | 例如 `http://127.0.0.1:3093`（Bridge 端口，不是 BFF 的 3092）          |
| `TECHHAVEN_BRIDGE_TOKEN`         | bridge 模式必填    | 无                                 | MCP → Bridge 内部 Bearer                                              |
| `TECHHAVEN_API_BASE_URL`         | http 模式          | `https://techhaven.website/api/v1` | MCP 直连产品 API 的基址                                               |
| `TECHHAVEN_SERVICE_TOKEN`        | http 模式必填      | 无                                 | MCP 直连产品 API 的服务 Bearer                                        |
| `TECHHAVEN_API_TIMEOUT_MS`       | 否                 | `5000`                             | HTTP/Bridge 超时，100–60000 ms                                        |
| `TECHHAVEN_AUDIT_FILE`           | 否                 | `./audit/agent-audit.jsonl`        | append-only 工具审计                                                  |
| `TECHHAVEN_WRITE_MODE`           | 否                 | `direct`                           | `direct` 或 `staged`                                                  |
| `TECHHAVEN_WRITE_STAGED_TOOLS`   | 否                 | `update_ticket_status`             | staged 下仍需审批的写工具，逗号分隔；显式空值表示全部直写             |
| `TECHHAVEN_PROPOSALS_FILE`       | mirror/staged      | `./audit/proposals.jsonl`          | JSONL proposal 权威日志                                               |
| `TECHHAVEN_PROPOSAL_TTL_MINUTES` | 否                 | `30`                               | pending proposal 的正整数分钟 TTL                                     |
| `TECHHAVEN_DB_MODE`              | 否                 | `mirror`                           | `mirror` 或 `authoritative`；后者强制 staged                          |
| `TECHHAVEN_DB_URL`               | authoritative 必填 | 空                                 | Agent PostgreSQL 连接串；与旧后端 MySQL 无关                          |
| `TECHHAVEN_APPROVAL_ORG_ID`      | PG 审批 CLI 必填   | 无                                 | 人工审批目标组织                                                      |
| `TECHHAVEN_APPROVER_ID`          | 否                 | 无                                 | 审批人 ID                                                             |

默认值与注释可直接复制 `.env.example`。服务从进程环境读取配置，不应把真实密钥提交到仓库。

## 挂载到 dsh

dsh 侧通过 mcp-client 把本服务挂为外部工具源（stdio 方式，token 走 env 注入）。配置**示意**如下——字段名请以 dsh 仓库 `docs/config-catalog.md` 中 `mcp-client` 条目的实际 schema 为准：

```jsonc
// 示意：在 dsh 配置中新增一个 MCP server 条目（opt-in，默认不启用）
{
  "command": "node",
  "args": ["/绝对路径/techhaven-mcp/dist/index.js"],
  "env": {
    "TECHHAVEN_AGENT_TOKEN": "thm_v1....", // 每会话签发一次
    "TECHHAVEN_TOKEN_SECRET": "dev-only-secret-change-me",
    "TECHHAVEN_BACKEND": "bridge",
    "TECHHAVEN_BRIDGE_URL": "http://127.0.0.1:3093",
    "TECHHAVEN_BRIDGE_TOKEN": "与 Bridge 配置一致的随机值",
    "TECHHAVEN_AUDIT_FILE": "./audit/agent-audit.jsonl",
  },
}
```

挂载后 agent 即可原生调用 `get_ticket` / `list_my_tickets` / `search_requirements` / `get_trend_summary` / `get_semantics` / `get_proposal` / `update_ticket_status`。

## 工具目录（7 工具 = 6 读 + 1 写）

| 工具                   | scope    | 说明                                                                            |
| ---------------------- | -------- | ------------------------------------------------------------------------------- |
| `get_ticket`           | rd:read  | 读单张工单详情（kind: requirement/bug/task，hashId 入参）                       |
| `list_my_tickets`      | rd:read  | 列本组织工单，可按类型/状态过滤，单页上限 50                                    |
| `search_requirements`  | rd:read  | 按关键词/优先级搜需求                                                           |
| `get_trend_summary`    | rd:read  | 近 N 天趋势摘要（各类型 open/closed、窗口内新建/关闭）                          |
| `get_semantics`        | rd:read  | 语义层读取：字段业务含义与指标口径（查数/改数前先读口径）                       |
| `get_proposal`         | rd:read  | 只查询写提案状态；批准后由 server worker 主动应用                               |
| `update_ticket_status` | rd:write | 变更状态；**非法迁移一律拒绝**；必须附原因；staged 且列入分级审批清单时先建提案 |

`add_ticket_comment`、`create_bug` 等后续工具不是既定交付；每个写工具需单独完成风险、幂等、审批和域契约评审。

## 写模式：direct / staged

`TECHHAVEN_WRITE_MODE` 控制写工具（目前是 `update_ticket_status`）的生效方式：

| 模式             | 行为                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `direct`（默认） | 变更直接生效（P0 现状，行为不变）                                     |
| `staged`         | 变更先存为**提案**（pending，带过期时间），人工批准后才由 server 应用 |

staged 流程（文字版时序）：

```
agent 调 update_ticket_status（合法迁移）
  → server 校验 scope + 状态机，创建提案（pending，TECHHAVEN_PROPOSAL_TTL_MINUTES 内有效），
    返回 { proposal: { id, status: "pending", to_status, expires_at } }   —— 变更未生效
  → 人工执行 `npm run proposal -- approve <id>`（或 reject / 放任过期）
  → server proposal worker 检测到 approved：先独占领取（pending/approved → applying，含应用租约），
    再重读工单当前状态、重新过状态机 → 应用变更，补记 applied 事件
  → agent 可调用 get_proposal { id } 查询状态；查询本身不触发写入
  → 返回 { id, status: "applied", updated: {...} }
```

以上流程同时支持两种存储门禁：默认 `TECHHAVEN_DB_MODE=mirror` 保持 JSONL PoC 兼容；`TECHHAVEN_DB_MODE=authoritative` 时 `agent_write_proposals` 是唯一权威，连接或事务失败会拒绝启动/写入，不会回退到另一份可写真相。authoritative 模式强制 `TECHHAVEN_WRITE_MODE=staged`，禁止绕过 proposal 的 direct 写。

要点：

- **快速失败**：工单不存在或迁移非法时直接报错，不产生提案——审批负担只留给合法请求。
- **批准后二次校验**：应用前 server 重读工单当前状态、重新过状态机；审批窗口内工单若已被人工改动且迁移不再合法，提案转 rejected 并返回说明，不会硬改。
- **应用独占领取（applying）**：worker 应用前先把提案领取为 `applying`（JSONL 单进程 CAS 等价；PG 事务内 UPDATE + 应用租约 `apply_lease_expires_at`，默认 5 分钟，租约过期允许重新领取）。领取后人工撤回/重复批准返回 409；应用异常由系统侧补偿为 rejected——杜绝「撤回成功但写入已发生」（审查意见 F2）。迁移 005（schema v0.6）为 authoritative 模式提供 `applying` 枚举与租约列。
- **未决过期 = 默认拒绝**（安全侧倾斜）：`TECHHAVEN_PROPOSAL_TTL_MINUTES`（默认 30 分钟）内未批准即 expired。
- **幂等**：已 applied 的提案重复查询不会重复应用。
- **分级审批过渡**：staged 模式下只有列入 `TECHHAVEN_WRITE_STAGED_TOOLS`（默认 `update_ticket_status`）的写工具走提案；目标由 `tool_catalog` / `org_tool_policy` 服务端策略取代环境清单。
- mirror 模式的提案事件落 `TECHHAVEN_PROPOSALS_FILE`；authoritative 模式的人工 CLI 需要同时设置 `TECHHAVEN_DB_URL`、`TECHHAVEN_APPROVAL_ORG_ID`，可选 `TECHHAVEN_APPROVER_ID`，直接事务更新 PG。

PG repository 通过 `SELECT ... FOR UPDATE` 在域幂等调用期间持有 proposal 行锁：两个批准者只有一个能从 pending 推进，多个 worker 只有一个执行域写回调。该实现已通过编译和 JSONL 回归；live 并发证据需运行 `TECHHAVEN_TEST_DB_URL=... npm run smoke:pg` 后才能标记 `verified-integration`。

## 工单状态机（须与后端对齐后冻结）

```
requirement: new → developing → testing → done → closed      （testing 可回退 developing）
bug:         new → accepted → processing → verified → closed （processing 可 reopened；closed 可 reopened）
task:        todo → doing → done → closed                    （doing 可回退 todo）
```

枚举来源：TechHaven `src/types/rdPlatform.ts`。**迁移规则是本仓库先拟的**，需要朋友后端确认。

## 审计

每次工具调用写一行 JSONL（`TECHHAVEN_AUDIT_FILE`，append-only）：时间、会话、组织、工具、参数摘要（SHA-256，不落原始参数）、allow/deny 与原因、耗时。趋势分析（P2）直接吃这份数据。

当前配置 `TECHHAVEN_DB_URL` 后同步镜像 `agent_tool_calls`；DB 失败只记 stderr、JSONL 继续记录。目标在 R2 切换为 PG 权威并增加 spool 补写、对账和告警，当前降级不应被视为生产可靠性保证。

## 与 docs/agent-db 的衔接

`TECHHAVEN_DB_URL` 非空时，由 `PgContext` 统一建连接池并 bootstrap `agent_identities` / `agent_sessions`。`TECHHAVEN_DB_MODE=mirror` 保持兼容降级；`authoritative` 要求 DB 必须可用，并把 proposal 切到 PG 权威 repository：

| 能力               | DB 落点                                                                 | 状态                              |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------- |
| 审计双写           | `agent_tool_calls`（当前 JSONL 主、DB 镜像）                            | `implemented`，live PG 未验证     |
| 写提案权威         | `agent_write_proposals`（`proposal_ref` 并发键、事务行锁）              | `implemented`，live PG/并发未验证 |
| 语义层 DB Provider | `semantic_objects` / `semantic_fields` / `semantic_metrics`（60s 缓存） | `implemented`，live PG/策展未验证 |

分级审批：staged 写模式下仅 `TECHHAVEN_WRITE_STAGED_TOOLS` 清单中的写工具走提案审批；后续 `tool_catalog` / `org_tool_policy` 就位后，该清单改由组织级工具策略驱动。

## 真实域后端集成清单（ROADMAP R2）

- [x] 独立 Bridge adapter 与 MCP client 已实现
- [ ] 旧后端认证方式与 Bridge `bearer` / `cookie` 配置实测
- [ ] `/rd/*` 路径、字段、`errno` 和分页结构用真实响应样本确认
- [ ] 工单状态机迁移规则核对/修正
- [ ] 趋势权威接口或统计口径确认（当前 Bridge/http 都由列表聚合，上限 200/类）
- [ ] Bridge JSONL 台账备份、人工处理 uncertain 操作与单实例运行手册演练

## 目录结构

```
src/
  index.ts            # MCP Server 入口（stdio）
  cli.ts              # agent token 签发/校验 CLI
  proposalCli.ts      # 写提案人工审批 CLI（list / approve / reject）
  smoke.ts            # 端到端冒烟测试（direct 模式）
  smoke.staged.ts     # 端到端冒烟测试（staged 写模式：提案 → 人批 → 应用）
  smoke.http.ts       # HTTP adapter 离线契约（身份、组织、幂等、错误、超时）
  smoke.pg.ts         # 环境门控的 live PG DDL/并发/失败关闭测试
  config.ts           # 环境变量解析
  audit.ts            # JSONL 审计
  hashid.ts           # TechHaven hashId 镜像（同盐同长度）
  auth/agentToken.ts  # HMAC token：单会话 + 单组织 + scope + TTL
  db/context.ts       # DB 会话上下文（PgContext：pool + 身份/会话 bootstrap，三条落地路径共用）
  domain/             # 领域类型与工单状态机
  audit/dbSink.ts     # 审计 DB 双写（agent_tool_calls）
  proposals/store.ts  # 当前 PoC 写提案存储（JSONL append-only）
  proposals/pgStore.ts# PG 权威 proposal repository（事务并发控制）
  proposals/worker.ts # 批准后主动重校验、应用与恢复对账
  proposals/dbSink.ts # 写提案 DB 双写（agent_write_proposals）
  semantics/          # 语义层 Provider：mock（人工策展）/ db（semantic_* 表，60s 缓存）
  techhaven/          # 数据访问：mock / bridge / http 三实现
  tools/index.ts      # P0 工具注册（scope 守卫 + 审计 + 分级审批的 staged 提案分支）
```
