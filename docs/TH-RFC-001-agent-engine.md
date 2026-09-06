# TH-RFC-001 · TechHaven Agent 集成架构决策

> **版本** v0.2
> **状态** 已采纳 · 迁移中
> **日期** 2026-08-29
> **架构基线** `docs/ARCHITECTURE.md`
> **推进计划** `docs/ROADMAP.md`
> **引擎勘察** `services/techhaven-gateway/docs/DSH_SDK.md`

## 1. 摘要

TechHaven 保持产品外壳、域模型和数据主权，将 dsh 视为**可替换的外部 runner**。平台经 Agent Control Plane 驱动 runner，经 TechHaven MCP 把受控业务工具提供给 agent；当旧后端不能改造时，再由独立 Agent Bridge 转换旧 HTTP 契约。产品域写入由服务端策略、proposal 状态机和域后端共同强制，不能由模型提示、MCP annotations 或当前 dsh SDK 的权限事件决定。

当前代码已通过 MCP direct/staged 与 Gateway mock 冒烟；前端 Gateway client 和 DEV 双路径面板已实现；独立 Bridge 代码、MCP bridge client 和假旧后端验证路径也已加入。PG 权威 proposal/session/event、事务并发控制、migration、loader/reconcile 与环境门控 live smoke 已实现，但本机没有 PostgreSQL 实例。真实产品后端、live dsh 和 PostgreSQL 仍未形成真实端到端闭环。因此当前准确表述仍是：**控制面、工具面与旧后端兼容层已实现，离线路径可验证；真实集成尚在推进**。

## 2. 问题

TechHaven 已拥有博客与研发管理面，但缺少可控的 Agent 执行面。直接把 agent 嵌入产品进程、让 agent 操作 UI 或把用户凭据传进 runner，都会扩大故障和安全边界；另一方面，过早拆成大量微服务会增加当前团队的部署与一致性成本。

需要同时解决：

- 从工单派发、观察、审批和回写；
- 组织隔离、最小权限、幂等和审计；
- dsh alpha 契约变化与运行时故障隔离；
- 事件回放、断线恢复、配额和成本；
- mock PoC 到真实后端、数据库和沙箱的渐进迁移。

## 3. 目标与非目标

### 3.1 目标

| 编号 | 目标                                                   |
| ---- | ------------------------------------------------------ |
| G1   | 用户从 TechHaven 工单上下文派发并观察 Agent 会话。     |
| G2   | Agent 只通过结构化、版本化、可审计的工具读写产品域。   |
| G3   | 每个写操作可追溯到策略或人工决定，并由域后端再次授权。 |
| G4   | runner、产品域、控制面和浏览器凭据相互隔离。           |
| G5   | mock、dsh 或未来 runtime 通过同一 Runner Port 替换。   |
| G6   | 事件可持久化、回放、去重和关联 trace。                 |
| G7   | 每一阶段可验证、可回滚，并有明确停止条件。             |

### 3.2 非目标

| 编号 | 非目标                                                       |
| ---- | ------------------------------------------------------------ |
| N1   | 不 fork dsh，不把其源码合并进 TechHaven。                    |
| N2   | 不在产品后端进程内 import dsh runtime。                      |
| N3   | 不通过 UI 自动化完成已有产品 API 能表达的操作。              |
| N4   | 当前不拆产品域微服务，不引入消息总线或服务网格。             |
| N5   | 不把 mock 冒烟、静态 SQL 核对或文档设计称为生产完成。        |
| N6   | 不承诺 MCP Tasks、ACP、插件寄宿或云沙箱，除非后续 RFC 验证。 |

## 4. 决策记录

### ADR-01：受管 runner 进程 + Runner Port

**决定**：Gateway/Control Plane 只依赖 `EngineDriver` 端口；mock 和 dsh 是 adapter。dsh 以独立进程运行，每个会话显式创建和释放。

**理由**：隔离进程故障和依赖变化；可在无 dsh 环境下测试；未来替换 runtime 不影响 SPA、域后端或 MCP。

**后果**：必须维护 adapter contract test；dsh 版本/profile/事件映射需要精确记录。

### ADR-02：双向协议边界

**决定**：

- 人到 Agent：SPA → Web BFF → Agent Control Plane → Runner Port；
- Agent 到平台：runner → TechHaven MCP → Agent Bridge（旧后端场景）→ 产品域 API。

**理由**：驱动流和工具流的授权、容量与版本节奏不同，必须独立演进。

### ADR-03：MCP 工具治理与旧协议转换分层

**决定**：MCP 负责工具协议、schema、agent 身份、scope、工具策略、proposal 和状态机前置校验；独立 Agent Bridge 负责旧后端认证、路径/字段/响应/状态转换，以及旧写入的幂等台账与结果对账。工单状态机和业务数据的权威仍在产品域后端。

**理由**：旧后端当前无法配合 Agent 契约改造。把兼容逻辑做成独立服务，可以不动产品后端和 MySQL，同时避免 MCP 同时承担工具治理与遗留接口细节。

**后果**：浏览器不得直连 Bridge，MCP 不持有旧凭据，Bridge 不访问 MySQL。当前 `stateMachine.ts` 只作为 fail-closed 前置校验；真实联调时必须用真实响应冻结状态/错误契约。Bridge JSONL 幂等台账只允许单实例，横向扩容前必须迁移到带唯一约束和事务锁的权威存储。

### ADR-04：产品审批状态机是写权限权威

**决定**：高风险写工具统一走持久化 proposal。批准后由服务端 worker 重新校验并执行，模型查询仅用于观察状态。

**理由**：dsh v0.1.2-alpha.1 SDK 线协议没有权限应答方法；把 UI 批准映射成未实际送达引擎的决定会制造错误安全感。服务端 proposal 能提供幂等、过期、并发控制和完整审计。

**迁移进度**：批准后由 MCP 服务端 proposal worker 主动重校验并应用；`get_proposal` 已改为纯查询。PG repository 已用事务行锁串行化并发批准和 worker 应用，并提供 live PG smoke；真实实例与真实域幂等仍待 R2 验证。

### ADR-05：模块化单体 + BFF 逻辑边界

**决定**：产品域后端保持模块化单体；先在现有后端/同源代理中建立 Web BFF 逻辑边界，不立即新增独立部署服务。

**理由**：当前只有一个 Web 客户端，独立 BFF 会增加运维跳数；但浏览器会话、聚合、限流和内部地址隐藏仍需要清晰边界。

**拆分触发条件**：出现差异显著的第二客户端、独立发布/扩缩容需求或故障隔离数据后，再单独评估。

### ADR-06：PostgreSQL 逐步成为 Agent 平面权威存储

**决定**：生产目标中 session/event/proposal/tool-call 以 PostgreSQL 为权威；JSONL 退为本地 spool、调试导出与短时降级缓冲。

**理由**：JSONL 无法可靠承担多进程审批、并发写、索引查询、唯一约束和恢复流程。

**迁移**：通过双写对账和幂等 loader 渐进迁移，不允许两个权威源同时接受写。

### ADR-07：OpenTelemetry 统一观测语义

**决定**：BFF、Control Plane、MCP、runner adapter 和域 API 传播 W3C trace context；运行日志、指标、trace 与审计分离但可通过 ID 关联。

**理由**：JSONL 和 stderr 能证明 PoC 流程，却不足以定位跨服务延迟、重试风暴和组织级容量问题。

### ADR-08：按门禁而非日期推进

**决定**：采用 `planned → implemented → verified-mock → verified-integration → pilot → production` 状态模型；路线见 `docs/ROADMAP.md`。

**理由**：防止把“代码存在”误写成“真实集成完成”，并让每阶段可独立停止或回滚。

## 5. 权限与凭据模型

### 5.1 浏览器

- 目标为同源 BFF + `HttpOnly/Secure/SameSite` Cookie；
- Agent token、Gateway 管理 token、域服务 token 不进入浏览器；
- WebSocket/SSE 校验 Origin、CSRF、会话过期和每消息权限；
- token 不放入 URL、事件、日志或前端持久存储。

### 5.2 Agent token

最小 claims：

| claim     | 含义                              |
| --------- | --------------------------------- |
| `aud`     | 目标 MCP server/resource          |
| `sid`     | 单次会话                          |
| `org`     | 单组织                            |
| `scopes`  | `rd:read` / `rd:write` 等最小集合 |
| `iat/exp` | 签发和过期                        |
| `jti`     | 唯一 ID，用于吊销和重放检测       |

Inbound agent token 不能透传给 Bridge 或产品域 API；MCP 使用独立 Bridge token，Bridge 再使用独立旧后端 Bearer/Cookie。三个凭据不可复用。

### 5.3 工具风险

| 类别              | 默认策略                                                |
| ----------------- | ------------------------------------------------------- |
| 只读、封闭世界    | 免人工审批，仍做 org/scope/速率限制                     |
| 可逆写            | staged，人工或组织策略批准，要求幂等键                  |
| 破坏性/外部世界写 | 默认禁止；单独 RFC 和高强度审批后才开放                 |
| 文件、命令、网络  | runner sandbox/profile 控制；SDK 无法应答时 fail-closed |

MCP tool annotations 只帮助 UI 和模型理解风险，服务端策略引擎不得信任来自不可信 server 的 annotations。

## 6. 生命周期与事件

会话状态保持：

```text
queued → running → awaiting_permission → running → succeeded
            │                │
            ├──────────────→ failed
            └──────────────→ cancelled
```

约束：

- 终态不可复活；重试创建新 session，并关联 parent session；
- 事件信封包含 `schemaVersion/eventId/sessionId/orgId/seq/type/occurredAt/traceId/payload`；
- `seq` 会话内递增，`sid + seq` 唯一；SSE `Last-Event-ID` 与它对齐；
- runner 事件与 `proposal_lifecycle` 由 Gateway 串行分配同一 `seq`，防并发来源产生碰撞；
- 前端断线只影响观察，不影响服务端会话；
- approval 超时默认拒绝；session 超时 cancel + dispose；
- runner 崩溃必须产生终态和最后可用诊断，不静默悬空。

## 7. 当前工具目录

| 工具                   | 类型 | 当前状态        | 目标治理                                   |
| ---------------------- | ---- | --------------- | ------------------------------------------ |
| `get_ticket`           | 读   | `verified-mock` | contract test + 真实域 API                 |
| `list_my_tickets`      | 读   | `verified-mock` | 服务端分页与组织隔离                       |
| `search_requirements`  | 读   | `verified-mock` | 查询上限、超时和审计                       |
| `get_trend_summary`    | 读   | `verified-mock` | 冻结指标口径，不在 MCP 临时聚合 200 条列表 |
| `get_semantics`        | 读   | `verified-mock` | live PG 策展和版本化                       |
| `get_proposal`         | 读   | `verified-mock` | 仅查询状态，不负责触发应用                 |
| `update_ticket_status` | 写   | `verified-mock` | proposal worker + 域状态机 + 幂等键        |

`add_ticket_comment`、`create_bug` 等不再写入“下一阶段默认交付”，必须在单工具风险评审后进入计划。

## 8. 验证要求

### 8.1 当前已验证

- MCP direct：9 项 mock smoke；
- MCP staged：11 项 mock smoke；
- MCP HTTP adapter：6 项离线 contract smoke（service identity、org、幂等键、错误与超时）；
- MCP Bridge client 与 Agent Bridge：离线单测/假旧后端 HTTP smoke 覆盖内部认证、session/org、状态映射、幂等冲突、重放、写后确认和模糊失败对账；
- Gateway：41 项 mock smoke（含 proposal 审批/幂等/生命周期回放、SSE 断线/进程重启回放、连续性、活动态失败收敛与取消终态）；
- 前端 Gateway client：默认 6 项契约回归 + 1 项环境门控的真实 Gateway 刷新式重连回归；DEV mock 链路覆盖 runner 权限与产品 proposal 的独立批准/拒绝；
- MCP/Gateway/Bridge TypeScript typecheck。
- PG 权威 adapter、migration、reconcile 与 live smoke 已通过编译；这是 `implemented` 证据，不是 live PG 证据。

### 8.2 当前未验证

- PostgreSQL 权威存储下的 live 重启/并发恢复，以及批准/应用竞态实跑；
- live dsh spawn/prompt/event/close；
- dsh 权限应答与单 turn cancel（当前协议明确不可用）；
- Bridge 到真实产品域 API（认证、路径/字段、状态枚举、组织隔离和最终一致性）；
- live PostgreSQL DDL、并发、恢复和 loader；
- 多组织沙箱、网络隔离、渗透和容量。

详细退出门禁不得在本 RFC 复制维护，以 `docs/ROADMAP.md` 为唯一来源。

## 9. 风险登记

| 风险                         | 概率 | 影响 | 当前处理                                                 |
| ---------------------------- | ---- | ---- | -------------------------------------------------------- |
| dsh alpha 契约变化           | 高   | 高   | adapter 单点、精确版本、contract/live smoke、可回退 mock |
| UI 批准与引擎实际权限脱节    | 高   | 高   | 产品 proposal 权威；runner 权限 fail-closed              |
| 多份状态机漂移               | 高   | 高   | 域后端权威 + contract test                               |
| JSONL 多进程竞争/恢复困难    | 中   | 高   | PG 权威迁移 + spool + 幂等装载                           |
| token 泄露或 confused deputy | 中   | 高   | audience、短 TTL、独立上游凭据、禁止 passthrough         |
| 重试风暴/慢依赖级联          | 中   | 高   | timeout、单层 retry budget、circuit breaker、bulkhead    |
| 前端包过大                   | 高   | 中   | 路由 lazy、重依赖按需加载、体积预算                      |
| 文档再次漂移                 | 中   | 中   | 状态词、门禁、CI 文档检查、事实/目标分离                 |

## 10. 方案演进

| 版本 | 变更                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| v0.1 | 确立外壳/引擎/协议边界、SDK 驱动流 + MCP 工具流和 P0–P3 路线。                                                    |
| v0.2 | 修正成熟度；采用模块化单体 + BFF 逻辑边界、Ports & Adapters、产品 proposal 权威、PG 权威迁移、OTel 和门禁式路线。 |

架构来源与安全规范集中维护在 `docs/ARCHITECTURE.md`，避免本 RFC 重复一份易漂移的链接清单。
