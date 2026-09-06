# techhaven-gateway

TechHaven Agent Control Plane 的当前实现：runner 生命周期、会话管理、SSE 事件桥、runner 权限中继、产品 proposal 查询/决策和基础配额。

> 当前状态：`implemented + verified-mock`。112 项纯域单测与 41 项 mock driver 子进程冒烟通过（含 SSE 断线/重启回放、proposal 查询/审批/幂等与生命周期回放、无缺口/无重复、活动态失败收敛与取消终态、组织授权端口与 PG 实例归属）；浏览器经 Vite 代理的创建、刷新、批准/拒绝及进程重启续传已用 mock runner 实测。live dsh、live PostgreSQL 和生产沙箱尚未验证。架构见 `../../docs/ARCHITECTURE.md`，决策见 `../../docs/TH-RFC-001-agent-engine.md`，门禁见 `../../docs/ROADMAP.md`。

数据流：`driver.startSession`（后台）→ 事件泵消费 `handle.events()` → 权威存储提交 → 内存缓存 + JSONL spool → SSE 订阅者。默认 `jsonl` 权威保持 PoC 兼容；`postgres` 模式先提交 PG，失败时不向 SSE 宣布未落库事实。
SSE 数据帧为**事件信封**（`EventEnvelope`，`id:`=seq，data 含 schemaVersion/eventId/sessionId/orgId/seq/type/occurredAt/traceId/payload，见仓库根 `contracts/` 与 TH-RFC-001 §6）；JSONL 行仍存引擎事件原始形态。
终态（succeeded / failed / cancelled）后 dispose 引擎句柄并关闭 SSE；空闲超时由看门狗合成 failed 终态——「会话不悬空」。

Gateway 只承载控制面，不复制产品域状态机；proposal 权威位于 techhaven-mcp/审批服务。Gateway 通过 `ProposalPort` 暴露同会话、同组织的查询/决策 API，并把 proposal 生命周期投影到 session SSE；批准不等于 Gateway 执行域写，实际应用仍由 MCP 服务端 worker 负责。

### 用户模型配置注入

设置 `TECHHAVEN_AI_CONFIG_URL` 与 `TECHHAVEN_AI_CONFIG_SERVICE_TOKEN` 后，创建会话必须携带受信 BFF 注入的 `X-TechHaven-Actor: user:<id>`。Gateway 使用独立服务令牌向产品后端内部端点读取该用户的 `{ type, provider?, response_type?, url, api_key, model?, reasoning_effort?, max_tokens? }`，再把它转换为只存在于内存中的 dsh runtime 配置。`provider` 支持 `openai | anthropic | zhipu | custom`，`response_type` 支持 `responses | chat_completions | messages`；旧记录缺省这两个字段时按原协议推断，保持向后兼容。

- 浏览器不提交、读取或持有供应商 API key；内部配置端点不得对浏览器开放。
- 脱敏 key、非 HTTPS provider URL（本机回环除外）、非法协议/模型配置一律失败关闭。
- 每个 Agent 会话独占一个 dsh 子进程；不同用户或不同模型配置不会共享进程环境。
- 注入配置不进入 `SessionView`、HTTP 响应、日志或 JSONL；传给子进程的基础环境采用 allowlist，避免顺带泄露 Gateway 其他凭据。
- dsh profile 需要把 provider route 与 `OPENAI_*`、`ANTHROPIC_*`、`ZHIPUAI_*` 环境变量绑定；route 名可通过 `TECHHAVEN_DSH_PROVIDER_OPENAI/CLAUDE/GLM` 调整。
- `response_type` 当前用于选择并校验资源路径、归一化 provider base URL；dsh 最终采用哪一种上游调用协议仍由部署时的 provider route/profile 决定，需在测试环境分别做 live 联调后才能标记为已验证。

产品后端不在本仓库中，因此这里只交付并验证 Gateway 侧适配器与内部 HTTP 契约；真实测试环境仍需实现该只读内部端点并完成 live dsh 联调。

### 组织授权（会话创建准入）

`POST /v1/sessions` 在创建会话前校验「调用者属于目标组织」（`orgAccess` 端口，默认 fail-closed）。装配规则：

| 条件                                                       | 行为                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 配置了 Agent DB 配置资产（`aiConfigStore`）                 | `AiConfigOrgAccess`：以 `ai_org_memberships` 为权威校验成员关系                          |
| 无授权源且 `TECHHAVEN_ENGINE_DRIVER=mock`                  | `LocalDemoOrgAccess`：演示模式默认放行（mock 无真实写入面；CI 冒烟与本地演示开箱可用）   |
| 无授权源且 driver=dsh 等真实链路                           | fail-closed：创建会话返回 503「未配置可信组织授权服务」，必须先接入可信授权源            |

通过校验的同一 orgId 会同步传入 AI 配置解析与会话 MCP 上下文绑定，保证「授权的 org」与「用配置的 org」是同一个。`TECHHAVEN_ORG_ACCESS_ALLOW_ALL=1` 仅在 mock driver 下允许显式声明逃生舱，真实部署不得启用。

## 快速开始

```bash
npm install
npm run typecheck    # tsc --noEmit（覆盖 src/**/*.test.ts）
npm test             # 纯域单测（node:test + tsx，无新增依赖，无需外部实例）
npm run build        # tsc -p tsconfig.build.json（编译 src/ 到 dist/，排除 *.test.ts）
npm run dev          # tsx src/index.ts
npm run smoke        # build + 端到端冒烟（spawn/restart dist/index.js，41 项检查）
npm run load         # gateway.jsonl → PostgreSQL 装载（见下「事件落库」）
npm run reconcile    # JSONL spool ↔ PG session/event 对账
npm run db:migrate -- --mode fresh --seed
npm run smoke:pg     # 需要 TECHHAVEN_TEST_DB_URL 的 live PG 门禁
```

`npm test` 覆盖 41 项不需要外部实例的纯逻辑：`src/config.test.ts`（环境变量校验的必填项 / 枚举 / 端口与配额边界 / `dbSchema` 标识符注入防护）、
`src/channel.test.ts`（`EventChannel` 的回放与单趟游标、close 唤醒挂起消费者、close 后 push 静默丢弃、waiter 不泄漏）、
`src/sessions.test.ts`（SSE 信封 §6 契约、runner/proposal 统一连续编号、`sessionView` 运行态剥离）、
`src/proposals.test.ts`（sid/org 隔离、内部 ID 脱敏、批准/拒绝幂等、过期 fail-closed），
`src/util.test.ts`（共享工具与 `sha256Hex16` 跨服务固定向量）。

构建用 `tsconfig.build.json` 排除 `*.test.ts`，`dist/` 内不含测试产物；`npm run typecheck` 仍覆盖测试文件。

## 配置（见 `.env.example`）

| 变量                                                                 | 说明                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `TECHHAVEN_GATEWAY_TOKEN`                                            | Bearer 令牌（必填，缺失拒绝启动）                           |
| `TECHHAVEN_GATEWAY_PORT`                                             | HTTP 监听端口（默认 3091）                                  |
| `TECHHAVEN_ENGINE_DRIVER`                                            | `mock` / `dsh`（默认 mock）                                 |
| `TECHHAVEN_GATEWAY_DATA_DIR`                                         | JSONL 落盘目录（默认 `./data`，文件名固定 `gateway.jsonl`） |
| `TECHHAVEN_PROPOSALS_FILE`                                           | JSONL 模式共享 proposal 日志（默认指向 MCP audit 文件）     |
| `TECHHAVEN_GATEWAY_STORE`                                            | `jsonl` / `postgres`（默认 jsonl）                          |
| `TECHHAVEN_GATEWAY_DB_URL`                                           | store=postgres 时必填；连接失败拒绝启动                     |
| `TECHHAVEN_GATEWAY_DB_SCHEMA`                                        | PostgreSQL schema（默认 public）                            |
| `TECHHAVEN_GATEWAY_INSTANCE_ID`                                      | PG 模式实例 ID（4–128 字符；缺省 `hostname:pid:random`），会话归属与心跳续约依据 |
| `TECHHAVEN_ORG_ACCESS_ALLOW_ALL`                                     | `1` 时跳过组织成员校验；仅 mock driver 允许，真实链路设置即启动失败 |
| `TECHHAVEN_MAX_SESSIONS_PER_ORG`                                     | 单组织活动会话配额（默认 3）                                |
| `TECHHAVEN_SESSION_RETENTION_MINUTES`                                | 终态会话保留分钟数（默认 30；0 = 不淘汰）                   |
| `TECHHAVEN_SESSION_IDLE_TIMEOUT_MINUTES`                             | 活动态空闲超时（默认 30；0 = 关闭）                         |
| `TECHHAVEN_DB_URL`                                                   | loader/migration 兼容变量                                   |
| `TECHHAVEN_DSH_BIN` / `TECHHAVEN_DSH_PROFILE` / `TECHHAVEN_DSH_HOME` | dsh 可执行文件、固定 profile 与工作区                       |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`                             | 由父进程继承给 dsh 的供应商配置；实际键名以 profile 为准    |

## JSONL 行格式（`gateway.jsonl`，append-only）

`jsonl` 模式下它是单实例 PoC 权威并负责重启恢复；`postgres` 模式下它只接收已提交事件的 spool/调试副本，启动恢复只读 PG。原始 prompt 始终不落日志/数据库，恢复视图返回固定占位文本。

## PostgreSQL 权威模式

- 会话创建在事务内获取组织级 advisory lock，再按 PG 活动会话数检查配额，防多实例并发穿透；
- `agent_events (session_id, seq)` 唯一，事件提交成功后才更新内存并推送 SSE；
- 会话写入 `runner_id` 与 `lease_expires_at`，本实例活动会话按心跳周期续约；启动恢复只接管「本实例会话 / 租约已过期的失联会话 / 保留期内已结束会话」，仍在其他实例运行的活动会话不会被误标 failed（审查意见 F4）；
- PG 部署默认以 advisory lock（`pg_try_advisory_lock(141402, 0)`）强制单活：实例归属/租约/fencing 完善前，第二个实例启动直接失败，需联调多实例时显式关闭；
- 重启从 PG 重建历史；无法恢复 runner 句柄的活动会话追加唯一 failed 事件；
- PG 连接或事务失败时 fail-closed，不把 JSONL 提升成第二个可写权威；
- `npm run reconcile` 比对 spool 与 PG 的 session/status/seq，差异时退出码为 2；
- 部署需先应用 [migration 005](../../docs/agent-db/migrations/005-v0.5-to-v0.6-proposal-applying.sql)（提案 `applying` 态）与 [migration 006](../../docs/agent-db/migrations/006-v0.5-to-v0.7-session-ownership.sql)（会话实例归属），见 `docs/agent-db/README.md`。

| kind         | 内容                                                                  | 说明                                                                                                   |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session`    | `{ sid, patch: { status, orgId?, subjectType?, subjectId?, note? } }` | patch 行只在 create（全量归属 + 状态）与注册表释放收尾（status + note）时写；中途状态变化不写 patch 行 |
| `event`      | `{ sid, event: <EngineEvent> }`                                       | 统一事件流（runner 事件 + proposal_lifecycle），事件行不含归属字段                                     |
| `permission` | `{ sid, orgId, requestId, decision, ts }`                             | 权限应答审计行（`orgId` 供装载器按组织归档）                                                           |

## 事件落库

`scripts/load-events.ts` 把 `gateway.jsonl` 装载进 `docs/agent-db/schema.sql` 定义的
`agent_identities` / `agent_sessions` / `agent_events`，列名与类型逐字对照 schema。

### 用法

```bash
# 连接串来自 env（必填，缺失退出并提示）
TECHHAVEN_DB_URL=postgres://postgres:postgres@127.0.0.1:5432/techhaven npm run load -- --file ./data/gateway.jsonl

# 或用 --url 覆盖（优先级高于 env）
npm run load -- --file ./data/gateway.jsonl --url postgres://postgres:postgres@127.0.0.1:5432/techhaven

# --file 缺省为 ./data/gateway.jsonl
TECHHAVEN_DB_URL=... npm run load
```

Windows PowerShell 下设置环境变量：`$env:TECHHAVEN_DB_URL = "postgres://..."` 后再执行。

### 幂等

同一文件可安全重跑：

- `agent_identities` 按 `UNIQUE (org_id, name)` upsert（name 固定 `techhaven-gateway`，kind `pipeline`，`created_by=0` 哨兵，与 techhaven-mcp `src/audit/dbSink.ts` 同约定），命中时把 `status` 复位为 `active`；
- `agent_sessions` 按 `sid` 唯一键 upsert，`started_at` 用 `COALESCE(库内值, 新值)` 保留最早起点，`ended_at` 只进不退；
- `agent_events` 按 `UNIQUE (session_id, seq)` `ON CONFLICT DO NOTHING`，重跑不产生重复事件行。

`started_at` / `ended_at` 是从事件行推导的尽力映射：`started_at` 取会话首个 `status_change: running` 事件的 ts（缺则退化为首条事件 ts），`ended_at` 取最后一个终态事件的 ts——推导规则同时保证 schema 的 `CHECK (ended_at IS NULL OR started_at IS NOT NULL)` 恒成立。会话最终 `status` 取文件序最后见到的状态（patch 行与 `status_change` 事件行合并推进）。

整文件读入内存、逐会话装载（PoC 规模足够，幂等可重跑）；单行 JSON 解析失败只计数并继续，不中断。

### permission 行为何不落库

`kind:"permission"` 行装载时**跳过**（只打印计数）：`agent_tool_calls` 的权威台账在
techhaven-mcp 侧（DB 双写见 `services/techhaven-mcp/src/audit/dbSink.ts`，其 session 维度绑定
MCP 自有会话与 identity）。gateway 的 permission 行只是「用户应答」的中继留痕，若在本侧再写
`agent_tool_calls` / `agent_write_proposals` 会造成双份审计与外键语义错位（gateway 侧并无
args_digest / risk_level / proposal 等权威字段）。当前审计留痕仍在 JSONL；生产目标由 MCP tool-call/proposal 权威表承担，Gateway permission 行只保留中继关联。

### 装载目标 ↔ JSONL 来源 ↔ schema 出处（交叉核对表）

| 装载目标表                   | JSONL 来源行                                                                                                            | schema 出处（文件:节）                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agent_identities`           | `kind:"session"` patch 行（`orgId`；name/kind/created_by 为装载器固定值）                                               | `docs/agent-db/schema.sql` §1 Control（agent_identities）                              |
| `agent_sessions`             | `kind:"session"` patch 行（sid / orgId / status / 归属）+ `kind:"event"` 行（started_at / ended_at / 最新 status 推导） | `docs/agent-db/schema.sql` §2 会话 / 运行 / 事件流（agent_sessions）                   |
| `agent_events`               | `kind:"event"` 行（`event` 去 seq/ts/type 后整体为 payload）                                                            | `docs/agent-db/schema.sql` §2 会话 / 运行 / 事件流（agent_events）                     |
| （不落库）`agent_tool_calls` | `kind:"permission"` 行 —— 只计数跳过，原因见上                                                                          | `docs/agent-db/schema.sql` §3 Control（agent_tool_calls，权威台账在 techhaven-mcp 侧） |

> **仍未经 live PostgreSQL 验证**：本机无 Docker/PG。schema v0.3、v0.2→v0.3 migration、loader、reconcile 和两套 `smoke:pg` 已实现并通过 TypeScript 构建，但必须在 PostgreSQL 14+ 测试实例实跑后才能升级状态。

在完成 `../../docs/ROADMAP.md` R2 的迁移、并发、补写和恢复门禁前，不得把 loader 标记为 `verified-integration`。

## 目标演进

- R1：共享事件 contract、前端真实 SSE、服务端 proposal worker、重启恢复；
  （R1 进度 2026-08-29：共享契约、SSE 信封、前端 Gateway client/DEV 接线、浏览器刷新/重连、JSONL 单实例重启恢复和 MCP proposal worker 已通过 mock 门禁）
- R2：PG 权威代码、JSONL spool、迁移/对账/live 门控已 `implemented`；真实 PG、域 API 和 live dsh 仍待 `verified-integration`；
- R3：单组织本地 runner 试点、OpenTelemetry、runbook；
- R4：多组织沙箱、bulkhead、retry budget、SLO 和安全门禁。

dsh SDK 的权限应答与取消限制见 `docs/DSH_SDK.md`。产品域写审批由 TechHaven proposal/policy 掌权，不把 dsh `approval/asked` 事件当作授权事实。

## Proposal API

- `GET /v1/sessions/:sid/proposals`：列出当前组织、当前会话的产品写入提案；
- `GET /v1/sessions/:sid/proposals/:proposalId`：读取单个提案；
- `POST /v1/sessions/:sid/proposals/:proposalId/decision`：`{ decision: "approve" | "reject", note? }`；
- 决策 actor 只接受受信 BFF/代理注入的 `X-TechHaven-Actor: user:<id>`，不读取浏览器 body 自报身份；
- 跨组织与跨会话都返回不可区分的 404；重复同向决策幂等，反向改判/过期批准冲突；
- 提案进入 `applying`（MCP worker 已领取应用）后，撤回/重复批准返回 409「正在应用，无法撤回」——应用先独占领取再执行业务写，杜绝「撤回成功但写入已发生」（审查意见 F2）；
- runner `permission_request` 与产品 `proposal_lifecycle` 是两套独立状态机，UI 不得把前者显示为后者已获批准。
