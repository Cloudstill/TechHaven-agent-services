# TechHaven 架构推进计划

> 版本：v1.0-draft
> 日期：2026-08-29
> 对应架构：`docs/ARCHITECTURE.md`
> 执行原则：按退出门禁推进，不按日期宣布完成

## 1. 状态定义

每项能力只允许使用以下状态：

| 状态                   | 含义                             |
| ---------------------- | -------------------------------- |
| `planned`              | 仅有设计或任务                   |
| `implemented`          | 代码存在并通过静态检查           |
| `verified-mock`        | 在 mock/离线依赖上通过自动化验证 |
| `verified-integration` | 与真实相邻系统在测试环境完成验证 |
| `pilot`                | 有限组织真实使用，可回滚且有观测 |
| `production`           | 满足安全、可靠性、恢复和运营门禁 |

禁止把 `implemented` 或 `verified-mock` 写成“完成上线”。

## 2. 当前状态快照

| 能力                    | 当前状态        | 证据与边界                                                                                                                                                              |
| ----------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPA 博客/组织/研发/后台 | `implemented`   | 页面与 service 已存在；缺少系统化自动化测试                                                                                                                             |
| 根前端正式构建          | `verified-mock` | `npm run build` 通过；主入口 gzip 93.3 KB（预算 256 KB，历史单体约 1.03 MB）                                                                                            |
| 根前端单测基线          | `verified-mock` | vitest 默认 22 项通过；另有 1 项环境门控的真实 Gateway HTTP/SSE 刷新式重连回归，本地已通过                                                                              |
| Mermaid 安全            | `verified-mock` | `securityLevel=strict`；恶意 HTML/脚本/click 注入测试无可执行标记                                                                                                       |
| 凭据脱敏回归            | `verified-mock` | WebSocket 建连日志、AI-SSE 诊断日志、Cookie 取值共 9 项；均用「改回旧写法 → 测试变红」反向验证过有效性                                                                  |
| CI                      | `verified-mock` | `.github/workflows/ci.yml` 四 job：root（build+test+体积）、mcp、bridge、gateway（后三者均 typecheck+test+smoke）                                                       |
| MCP direct 工具流       | `verified-mock` | 9 项离线冒烟通过                                                                                                                                                        |
| MCP staged proposal     | `verified-mock` | 11 项离线冒烟通过；批准后由 server worker 主动应用                                                                                                                      |
| Gateway HTTP/SSE/配额   | `verified-mock` | 41 项 mock driver 子进程冒烟通过，含 proposal 审批/幂等/生命周期回放、断线/重启回放、无缺口/无重复、活动态失败收敛与取消终态                                            |
| 前端 Agent 面板         | `verified-mock` | 浏览器经 Vite→Gateway(mock) 的创建、刷新同 SID、批准/拒绝、进程重启自动续传已实测；非真实 dsh/产品后端                                                                  |
| dsh driver              | `implemented`   | 静态实现；无 live dsh、权限应答和单 turn cancel 验证                                                                                                                    |
| Agent Bridge            | `verified-mock` | 14 项单测 + 4 项假旧后端 HTTP smoke：认证、组织隔离、状态/字段转换、台账恢复/损坏拒绝、幂等冲突、并发重放、写后确认和模糊失败对账；真实旧后端未联调、JSONL 只支持单实例 |
| MCP → 产品域 HTTP       | `implemented`   | 6 项离线 contract 已覆盖 service Bearer/org/幂等/errno/超时；作为直连兼容路径保留，真实凭据、状态机、趋势接口未联调                                                     |
| MCP 纯域/adapter 单测   | `verified-mock` | `npm test` 32 项通过：原 29 项状态机/token/摘要回归 + 3 项 Bridge client 内部身份、组织隔离与 proposal 幂等/前置状态                                                    |
| Gateway 纯域单测        | `verified-mock` | `npm test` 41 项通过（node:test + tsx，无新增依赖）：配置校验、EventChannel、SSE、proposal 隔离/幂等/过期、统一事件编号、会话视图脱敏                                   |
| Agent PostgreSQL        | `implemented`   | schema v0.3、migration、PG 权威 proposal/session/event、并发锁、loader/reconcile/live smoke 已有；无 live PG 证据                                                       |
| 多租户沙箱              | `planned`       | 尚未实现                                                                                                                                                                |
| 全链路可观测性          | `planned`       | 当前以 JSONL 和 stderr 为主                                                                                                                                             |

## 3. 阶段计划

### R0：稳定基线（预计 1–2 周）

目标：让主干重新具备可信构建、测试和文档基线。

工作项：

- 修复残留 `@ant-design/icons`，恢复 `npm run build`；
- 修复 HTTP 1101 只清 TokenManager、不清 AuthContext 的状态分裂；
- WebSocket 不再在 URL/日志暴露长时 token，形成同源 Cookie 或一次性 ticket 设计；
- Mermaid 改为严格模式并增加恶意输入测试；
- Router 使用 `React.lazy` 分割 admin/rd/article/agent 等路由；
- 建立 root、MCP、Bridge、Gateway 四个 CI job；
- 将现有 smoke 纳入 CI，增加最小纯域测试；
- README、RFC、服务文档统一使用本状态模型。

退出门禁：

- `npm ci && npm run build` 在干净 checkout 通过；
- 三个服务 typecheck + 各自 smoke 全通过；
- 不存在未声明依赖和 README 依赖漂移；
- 主 JS gzip 体积建立预算并较当前约 1.03 MB 明显下降；
- 高优先级认证与 Mermaid 安全问题有自动化回归测试。

> **R0 进度（更新于 2026-08-31）**：构建阻断（antd icons 残留）、1101 状态分裂、路由分包、WS token 日志脱敏、
> Mermaid strict + 回归、CI 四 job、主入口 gzip 预算均已落地并本地复验；`npm test`/`npm run build`/三个服务
> typecheck+smoke 全绿。当前三服务单测共 87 项（MCP 32 + Gateway 41 + Bridge 14）。
>
> **Gateway 单测发现并已归档**（非缺陷，是语义澄清）：`EventChannel` 的消费者若正挂起在内部 await 上，
> 调用 `iterator.return()` **不会落地**——按 AsyncGenerator 规范，return 请求要排队到生成器体让出控制权后
> 才处理，而让出的唯一途径是 `push` 或 `close`。因此终止消费的唯一可靠路径是 `channel.close()`；
> 源文件注释中的「finally 摘除 waiter」只是 yield 点退出时的兜底，不是取消挂起消费者的手段。
> 现有调用方（mock / dsh 驱动的 `dispose`）走的都是 `close()`，与此语义一致。已写入 `src/channel.ts` 注释并用单测锁定。
>
> **R0 补充（2026-08-29 晚）**：R0 退出门禁里「高优先级认证问题有自动化回归测试」此前只覆盖了
> HTTP 1101，本次补齐了另外两处**已修复但无回归保护**的凭据泄露：
>
> - `src/utils/websocket.test.ts`（5 项）：建连 URL 仍带 token（后端鉴权依赖该 query 参数，传输方式未变），
>   但控制台输出绝不出现 token / token_time 原文；同时断言脱敏不误伤 uid、重连不绕过脱敏。
> - `src/hooks/useAiSummary.test.tsx`（3 项）：AI-SSE 诊断日志不出现 token 原文或 ≥6 位前缀，
>   同时断言 `Authorization: Bearer` 头仍正确携带（脱敏不能牺牲功能）。
>
> 三处改动都做了**有效性反证**：把旧写法临时改回去，确认测试会变红（分别 2 项 / 1 项 / 1 项失败），再恢复。
> 前端 vitest 因此由 11 项增至 20 项。
>
> 顺带修掉一个潜在缺陷：`src/utils/websocket.ts` 的 `getCookie` 原用 `split("=")` 取值，Cookie 值含
> `=`（base64 填充、JWT 分段）时会在第一处切断，导致 token 被静默截断 —— 症状是「Cookie 明明有值却鉴权失败」。
> 改为 `indexOf("=")` 取值并加了回归测试（旧写法下断言实测得到 `PADDED_BASE64_TOKEN_` 而非完整值）。
>
> **剩余**：WebSocket token 从 URL 参数迁移到同源 Cookie/一次性 ticket（需后端配合，
> 见 ARCHITECTURE §6）、干净 checkout `npm ci` 复核（CI 完成后自动覆盖）。

### R1：契约与真实控制面接线（预计 2–3 周）

> **R1 进度（2026-08-29）**：共享契约包 `contracts/` 已成为事件/API 类型单源；Gateway SSE 已升级为
> 版本化事件信封；前端 Gateway client 与 DEV 双路径面板已实现；MCP proposal worker 已实现“批准后主动重校验并应用”，
> `get_proposal` 已退回纯查询，并通过离线 staged smoke；Gateway client 契约回归与 mock driver 子进程的断线回放/取消闭环
> 已通过；DEV 页活动 SID 刷新恢复、浏览器真实网络中断续传和 Gateway JSONL 单实例重启恢复均已完成 mock 门禁。
> 2026-08-31 补齐 Gateway `ProposalPort`、会话级 proposal 查询/决策 API、proposal 生命周期 SSE 与 DEV 产品提案卡片；
> mock 门禁覆盖跨组织/跨会话拒绝、重复批准幂等、拒绝、过期和重启回放。runner permission 与产品 proposal 在契约和 UI 中保持独立。
> **剩余**：live dsh/真实产品域集成；PG 权威代码与环境门控并发测试已进入 R2，但尚无 live PostgreSQL 证据。

目标：前端通过稳定契约使用真实 Gateway，但仍可选择 mock driver。

工作项：

- 建立共享 `contracts` 模块：session、event envelope、proposal、error、API schema；
- Agent 面板实现 Gateway client：创建会话、SSE 断线续传、取消、proposal 审批；
- 事件加入 `schemaVersion/eventId/traceId/orgId`；
- Gateway 会话与 proposal API 做 contract test；
- 明确 dsh 权限限制：产品域写走 proposal 权威流程，runner 权限不可应答时 fail-closed；
- proposal 批准后由服务端 worker 主动应用，移除“模型查询才生效”的关键依赖；
- feature flag 控制 mock/real UI 路径，可快速回退。

退出门禁：

- 浏览器刷新/断线后从 `Last-Event-ID` 恢复，持久化事件无缺口、无重复副作用；
- 拒绝 proposal 后域状态不变；重复批准只执行一次；
- UI 展示的权限结果与服务端权威状态一致；
- Gateway 重启后历史会话仍可查询。

### R2：真实域后端与 PostgreSQL（预计 2–3 周）

> **R2 进度（2026-08-29）**：schema v0.3 与 v0.2→v0.3 migration 已加入；MCP 支持
> `TECHHAVEN_DB_MODE=authoritative`，proposal 批准和 worker 应用由 PG 行锁串行化；Gateway 支持
> `TECHHAVEN_GATEWAY_STORE=postgres`，session/event 提交优先于 SSE，组织配额由 advisory lock 控制，
> JSONL 降为提交后 spool；migration、幂等 loader、spool 对账和两套 `smoke:pg` 已 `implemented`。
> **未验证边界**：本机没有 PostgreSQL/Docker/连接串，故 DDL、迁移、并发、恢复仍未达到
> `verified-integration`；真实产品域 API 与 live dsh 也尚未接入。
>
> **旧后端兼容进度（2026-08-31）**：新增独立 `techhaven-agent-bridge`，MCP 已支持推荐的
> `TECHHAVEN_BACKEND=bridge`。Bridge 不访问 MySQL，使用旧 HTTP API，隔离 Bearer/Cookie、`errno/data`、
> 路径/字段和状态枚举；状态写入具备 JSONL 幂等台账、写前置条件、写后确认及模糊失败对账。
> 14 项单测与 4 项假旧后端 HTTP smoke 已通过，因此为 `verified-mock`；真实旧后端契约未冻结且当前仅允许单实例。
>
> > **本机能力审计（2026-08-30）**：逐项确认阻断原因，PG 路径因此停在 `implemented`，代码本身无缺陷证据。
> >
> > | 项                      | 结果   | 说明                                                                              |
> > | ----------------------- | ------ | --------------------------------------------------------------------------------- |
> > | `psql` 可执行文件       | 缺失   | 无法执行 DDL 或手工核对迁移结果                                                   |
> > | Docker                  | 缺失   | 无法就地起一次性 PostgreSQL 测试实例                                              |
> > | `TECHHAVEN_TEST_DB_URL` | 未配置 | 两套 `smoke:pg` 均以此为唯一入口，缺失时以退出码 1 明确失败（已复验，非静默跳过） |
> > | 两服务 `.env`           | 不存在 | 仅有 `.env.example`；`TECHHAVEN_DB_URL` / `TECHHAVEN_GATEWAY_DB_URL` 均未填写     |
> > | `TECHHAVEN_DSH_BIN`     | 未配置 | live dsh 烟测同样无法进入                                                         |
> > | Node / npm / `tsx`      | 可用   | Node v22.22.2；`tsx` 经各自 `node_modules/.bin` 可用，mock 冒烟不受影响           |
> >
> > 因此本轮复验到的仍是**不依赖外部实例**的部分：MCP typecheck + 26 项 mock smoke（9 direct / 11 staged /
> > 6 HTTP contract）、Gateway typecheck + 35 项 mock smoke、根前端 typecheck + 11 项 vitest，全部通过。
> > 解除门禁只需提供 `TECHHAVEN_TEST_DB_URL`（两套 `smoke:pg` 自建临时 schema 并在 finally 中
> > `DROP SCHEMA ... CASCADE`，不需要预先建库）。

目标：把 mock 工具流替换为真实测试环境集成。

工作项：

- 与产品后端冻结 service identity、audience、scope、状态机和错误契约；
- 用真实旧后端响应样本冻结 Bridge 的认证、路径、字段、状态枚举、分页和组织隔离；
- 演练 Bridge uncertain 操作人工核对、ledger 备份恢复；多实例前迁移幂等台账到事务型权威存储；
- 域后端提供 idempotency key、actor、reason、trace ID；
- PostgreSQL 执行 schema/migration/seed/loader；
- 以 PostgreSQL 为 proposal/session/event 权威，JSONL 改为 spool；
- 双写对账工具、补写策略、备份恢复和并发批准测试；
- MCP HTTP adapter 与域 API contract test；
- dsh runtime 精确版本安装并完成 Windows live smoke。

退出门禁：

- 测试环境完成“真实工单读取 → proposal → 人批 → 域状态更新 → 审计回放”；
- 跨组织、错误 audience、过期 token、非法迁移全部拒绝；
- 数据库短暂不可用不会产生未经审计的写；恢复后可幂等补写；
- dsh 版本、profile、事件映射和已知限制生成可审阅报告。

### R3：单组织试点（预计 2–4 周）

目标：在受控开发者组织中验证价值、可靠性与运营流程。

范围：

- 本地 runner；
- 只读工具 + `update_ticket_status` 一个 staged 写工具；
- 组织/会话/工具配额；
- 运行历史、proposal 审批、失败解释和人工回滚；
- OpenTelemetry traces/metrics/logs 与审计关联；
- on-call、kill switch、数据导出和事件保留策略。

退出门禁：

- 所有写调用都可关联到策略或人工决定；越权写成功数为 0；
- 会话创建、事件回放、审批等待、工具失败有可查询指标；
- 完成故障演练：runner 崩溃、Gateway 重启、域 API 超时、数据库短暂不可用；
- 试点用户确认核心流程有价值，且失败可理解、可恢复；
- 形成继续生产化或停止投入的量化决策记录。

### R4：生产硬化（预计 4–6 周）

目标：满足多组织生产门禁。

工作项：

- 每会话一次性容器/沙箱、只读或最小仓库挂载、网络出站 allowlist；
- bulkhead、retry budget、circuit breaker、容量和成本配额；
- ASVS 检查、威胁建模、依赖/SBOM、密钥轮换、审计保留；
- 负载、长稳、恢复、升级/回滚和数据迁移演练；
- SLO 与告警、容量模型、成本看板；
- 灰度发布和组织级 kill switch。

退出门禁：

- 沙箱无法访问白名单外网络、未授权路径和其他组织数据；
- 配额、慢客户端、retry storm 和依赖故障不会扩散到其他组织；
- 备份恢复、版本回滚和事件重放演练通过；
- 安全、可靠性和运营负责人共同签署生产验收。

### R5：数据驱动扩展（无固定日期）

仅在 R3/R4 数据证明必要时评估：

- `create_bug`、`add_ticket_comment` 等更多写工具；
- MCP Tasks 等实验性长任务协议；
- 多 runner 或其他 agent runtime；
- ACP/SDK 新版权限应答；
- 独立 BFF 部署、消息总线、微服务或多区域。

每个选项都需单独 RFC，不继承“规划即承诺”。

## 4. 并行工作流

| 工作流        | R0                | R1                   | R2              | R3           | R4         |
| ------------- | ----------------- | -------------------- | --------------- | ------------ | ---------- |
| Frontend      | 构建/安全/分包    | 真实 Agent client    | 错误与恢复 UI   | 试点体验     | 性能与灰度 |
| Contracts     | 状态模型          | 事件/API schema      | 域/MCP contract | 兼容性监控   | 版本治理   |
| Control Plane | CI/纯域测试       | 持久会话/审批 worker | PG 权威迁移     | 配额/OTel    | 隔离/容量  |
| MCP           | 测试与 token 基线 | proposal 契约        | 真实域 API      | 一个写工具   | 工具治理   |
| Runner        | mock 基线         | fail-closed 权限     | live dsh        | 本地试点     | 沙箱池     |
| Security      | Web 风险修复      | threat model         | audience/跨租户 | 试点审计     | ASVS/渗透  |
| Operations    | CI                | trace ID             | PG 备份恢复     | 告警/runbook | SLO/成本   |

## 5. 指标

产品与工程指标分开，避免只优化技术吞吐：

### 5.1 产品效果

- 首次有用结果时间；
- 人工接受的 Agent 建议比例；
- proposal 批准/拒绝/过期比例；
- 因 Agent 产生的返工或回滚比例；
- 单次成功会话的人工作业时间节省。

### 5.2 运行质量

- 会话创建成功率与 p95 排队时间；
- 事件回放缺口/重复；
- 工具成功率、超时率、p95 latency；
- 审批等待时间；
- runner 异常退出、配额拒绝、跨组织拒绝；
- 每成功会话 token/运行时/沙箱成本。

### 5.3 交付能力

按 DORA 当前五指标观察趋势，不用于个人绩效：change lead time、deployment frequency、failed deployment recovery time、change fail rate、deployment rework rate。参考：https://dora.dev/guides/dora-metrics/

## 6. 决策与报告模板

每个阶段结束提交一页结论：

1. 目标与退出门禁；
2. 当前状态（使用标准状态词）；
3. 自动化证据与真实环境证据；
4. 未验证边界；
5. 指标变化；
6. 风险和回滚方案；
7. 决策：继续、调整、暂停或终止。
