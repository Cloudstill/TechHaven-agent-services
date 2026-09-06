# techhaven-contracts

TechHaven Agent 控制面共享契约（**类型单源**，零运行时依赖，types-only）。

消费者：

- `services/techhaven-gateway`：引擎事件（types.ts 重导出、改动冻结语义）、SSE 事件信封、会话与 API 形态；
- `services/techhaven-mcp`：提案状态与生命周期事件；
- 根 SPA（后续）：Gateway client 消费信封/API 类型（R1 前端接线）。

## 边界

- `index.d.ts` 是**唯一事实源**；任何跨边界类型不得在消费方自行重定义。
- 变更流程：修改 → Gateway/MCP 双方 `npm run typecheck` + smoke 全绿 → 评审。
- 事件信封字段定义与理由见 `../../docs/TH-RFC-001-agent-engine.md` §6（生命周期与事件）、
  `docs/ROADMAP.md` R1（schemaVersion/eventId/traceId/orgId）。

## 约定

- `schemaVersion` 当前为 `1`；新增必选字段走版本升级，不静默加字段。
- `eventId = "<sessionId>:<seq>"`，与 SSE `id:` 对齐（`Last-Event-ID` 回放）。
- `traceId`：R2 OpenTelemetry 接入前固定空串，不得伪造。
- `permission_request` 只表示 runner 执行权限；产品域写入必须使用独立的
  `proposal_lifecycle` 与 Proposal API，二者不得在 UI 或服务端互相冒充。
