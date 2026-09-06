# TechHaven Agent 数据平面

**架构基线**：`docs/ARCHITECTURE.md`
**推进门禁**：`docs/ROADMAP.md` R2
**产出**：[`schema.sql`](./schema.sql)（PostgreSQL 14+ DDL）、[`migrations/002-v0.2-to-v0.3-authoritative.sql`](./migrations/002-v0.2-to-v0.3-authoritative.sql) 与 [`seed-semantics.sql`](./seed-semantics.sql)
**当前状态**：`implemented`；PG 权威 repository、迁移、loader、对账与环境门控 smoke 已存在，尚未在 live PostgreSQL 执行，不能标记 `verified-integration`

PR #122 修复使用 schema v0.5：新增 [004 成员授权与用量去重迁移](./migrations/004-v0.4-to-v0.5-access-and-usage.sql)。启用 AI 配置资产的部署须先迁移，再更新服务；组织共享授权需由可信管理通道同步到 `ai_org_memberships`，不会从用户偏好自动推导。详见 [配置与升级说明](../../services/techhaven-gateway/docs/AI_CONFIG_ASSETS.md)。

2026-09 审查勘误新增两个迁移，PG 部署必须按顺序补齐后再升级服务：

- [005 v0.5→v0.6 提案应用态](./migrations/005-v0.5-to-v0.6-proposal-applying.sql)：`proposal_status` 枚举新增 `applying`（应用阶段独占领取态），`agent_write_proposals` 增加 `apply_lease_expires_at` 应用租约列与索引。撤回与应用不再竞争同一段状态。
- [006 v0.5→v0.7 会话实例归属](./migrations/006-v0.5-to-v0.7-session-ownership.sql)：`agent_sessions` 新增 `runner_id` / `lease_expires_at` 与两个索引。PG 启动恢复只接管本实例或租约过期的会话；实例归属/租约/fencing 完善前 PG 部署强制单活（advisory lock）。

## 一句话定位

本数据平面承载 Agent Control（身份、会话、配额、审批、审计）与 Context（mini 语义层）的元数据。**域数据不搬**：工单、需求、缺陷、用户和组织仍归产品后端，本层只存引用和 Agent 运行事实。

兼容模式仍可用 JSONL 完成离线 PoC；显式 authoritative 模式已把 MCP proposal 与 Gateway session/event 切到 PostgreSQL 权威，JSONL 只在 PG 提交后作为本地 spool/调试导出。数据库不可用时写路径失败关闭，不允许 JSONL 同时接受权威写。

## 文章概念 → 本设计的映射

| 文章的痛点/理念                             | 本设计的落地                                                                          | 表                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Control**：Agent 独立身份、配额、操作边界 | agent 身份体系，与人的账号完全隔离                                                    | `agent_identities` `agent_tokens` `agent_quotas`        |
| **Control**：全链路审计、每次访问落盘       | 结构化工具调用台账（替代 JSONL）+ 引擎事件流                                          | `agent_tool_calls` `agent_events`                       |
| **Control**：事前守护——高风险进审批流       | 写操作一律**提案暂存 → 人批 → 应用**，未批不落库                                      | `agent_write_proposals` `org_tool_policy`               |
| **Context**：Nexa Knowledge 语义层          | mini 语义层：物理字段 → 业务语义、指标口径显式化（人工策展起步）                      | `semantic_objects` `semantic_fields` `semantic_metrics` |
| **Context**：敏感数据按主体动态脱敏         | 字段级敏感标记 + 脱敏策略（供工具层执行）                                             | `semantic_fields.sensitive / mask_policy`               |
| **Tool**：一个平台找到全部工具、默认不启用  | 工具目录 + 组织级 opt-in 策略（对齐 dsh mcp 理念）                                    | `tool_catalog` `org_tool_policy`                        |
| **失忆**：召回缺权限/时效过滤               | 所有查询强制 token 的组织绑定（MCP 层已实现）+ 敏感字段标记                           | 复用 §05.2 + `semantic_fields`                          |
| **窒息**：脉冲式负载、资源隔离              | 配额四指标（并发/时长/日会话/日调用）+ 引擎一次性进程（架构层）                       | `agent_quotas`                                          |
| **进化困难**：克隆/回滚/时光机              | 我们的对应物：写提案未批准=零副作用（天然回滚）+ 事件流可重放                         | `agent_write_proposals` `agent_events`                  |
| **Agent Memory**（团队记忆 60%→80% 成功率） | 个体/团队两级记忆，团队记忆 = `identity_id IS NULL`                                   | `agent_memory`                                          |
| Trace 可观测                                | `agent_events` 保存业务事件；分布式 trace 由 OpenTelemetry 承担，两者以 trace ID 关联 | `agent_events`                                          |

## 明确不做的事（边界）

- **不自建多引擎/智能路由/Iceberg-Lance 存储层**——那是 Nexa 本体，是腾讯云的产品；我们的域数据量级用不上，也不该造。
- **不做自动语义扫描**——Nexa Knowledge 自动翻译物理 schema；我们 P0 人工策展几十个字段即可启动，等 agent 调用量证明价值再谈自动化。
- **域表不进本库**——`requirements/bugs/tasks/users/organizations` 留在产品后端；跨库引用用 ID（后端同库则改 FK）。

## 与 services/techhaven-mcp 的衔接

| 当前实现                                        | R2 目标                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| JSONL 审计（`audit.ts`）+ 可选 PG 双写          | PG `agent_tool_calls` 权威；JSONL 为 spool；按 call ID 幂等补写    |
| CLI 手动签发 token                              | `agent_tokens` 只存指纹/jti/状态；签发、吊销和 audience 校验服务化 |
| PG/JSONL 可配置；批准后由服务端 worker 主动应用 | live PG 验证事务锁、域幂等与恢复                                   |
| `TECHHAVEN_WRITE_STAGED_TOOLS` 环境清单         | `tool_catalog` + `org_tool_policy` 服务端策略                      |
| mock/DB 双 Provider                             | live PG 策展数据、版本化语义和 contract test                       |

## 状态机与约束

- 会话状态机 = TH-RFC-001 图 2（`agent_session_status` 枚举）。
- 写提案 `expires_at` 未决自动过期 = 默认拒绝（安全侧倾斜，同图 2 审批超时语义）。
- `agent_events (session_id, seq)` 唯一 = 会话内事件可重放、不丢序。

## 候选保留策略

以下数值是待法务、隐私、容量和恢复评审的初始候选，不是已上线策略：

| 表                      | 保留         | 理由                                  |
| ----------------------- | ------------ | ------------------------------------- |
| `agent_events`          | 90 天        | 观测数据，量大                        |
| `agent_tool_calls`      | 365 天       | 审计合规                              |
| `agent_write_proposals` | 365 天       | 追责与回滚依据                        |
| `agent_tokens`          | 过期后 30 天 | 台账可核                              |
| `agent_memory`          | 按组织治理   | 陈旧经验会误导 agent，靠 `expires_at` |

## 落地顺序

1. **R0/R1**：冻结事件/proposal/token contract，补齐纯域和 adapter 测试。
2. **R2.1**：在测试 PostgreSQL 执行 schema、migration、seed、loader 和备份恢复。
3. **R2.2**：JSONL→PG 双写对账；验证幂等键、并发批准、重复事件和补写。
4. **R2.3**：切换 PG 为 session/event/proposal/tool-call 权威，JSONL 改 spool；保留回滚开关。
5. **R3+**：基于实际调用量启用配额、语义策展和保留策略；`agent_memory` 另行风险评审后再启用。

## live PostgreSQL 验收清单

- [ ] `schema.sql` 在空库和已有 v0.1 库均可迁移；
- [ ] `seed-semantics.sql` 可重复执行或有明确一次性策略；
- [ ] loader 重跑不产生重复 session/event；
- [ ] 两个并发批准者只能有一个成功应用 proposal；
- [ ] 数据库短暂失败时不产生未经审计的域写；
- [ ] 恢复后 spool 可幂等补写并完成对账；
- [ ] 备份恢复后 session、event、proposal 和审计关联完整；
- [ ] 敏感字段、token、prompt 和个人数据保留符合策略。

## 可执行门禁

```powershell
# 空 schema 建表并播种；已有 v0.2 用 --mode upgrade
$env:TECHHAVEN_GATEWAY_DB_URL = "postgres://..."
npm --prefix services/techhaven-gateway run db:migrate -- --mode fresh --seed

# 两套 live PG smoke：proposal 并发批准/应用；Gateway 多实例配额/事件恢复
$env:TECHHAVEN_TEST_DB_URL = "postgres://..."
npm --prefix services/techhaven-mcp run smoke:pg
npm --prefix services/techhaven-gateway run smoke:pg

# spool 与权威表对账
npm --prefix services/techhaven-gateway run reconcile -- --file ./data/gateway.jsonl
```

两套 smoke 都创建独立临时 schema 并在结束时删除；测试账号因此需要 `CREATE SCHEMA` 权限，禁止指向生产数据库。
