# techhaven-agent-bridge

`techhaven-agent-bridge` 是 Agent 系统与**不改造的旧 TechHaven 后端**之间的独立兼容层。它不访问 MySQL，也不替代产品后端；它只通过旧 HTTP API 读取和写入产品数据，把旧接口转换成 MCP 所需的稳定契约。

> 当前状态：`implemented + verified-mock`。类型检查、16 项单测和 4 项本地假旧后端 HTTP smoke 已通过；在拿到真实旧后端地址、凭据、状态枚举和响应样本前，不能标记为 `verified-integration` 或生产可用。当前 JSONL 幂等台账只支持单实例。

## 为什么单独部署

```text
dsh / Agent
    │ MCP stdio + session/org scoped token
    ▼
techhaven-mcp
    │ 内部 Bearer + X-TechHaven-Session + X-TechHaven-Org
    ▼
techhaven-agent-bridge
    │ 旧后端 Bearer / Cookie；旧 /rd/* 路径与字段
    ▼
不改造的旧 TechHaven 后端 ── MySQL
```

- MCP 不需要理解旧后端的 `errno/data`、字段别名、数字状态或 Cookie。
- 旧后端不需要理解 Agent token、MCP、proposal 或 Agent 会话。
- 产品 MySQL 仍由旧后端独占；Bridge 不直连数据库，因此不会形成第二套数据写入路径。
- 浏览器不得直连 Bridge。Bridge 默认只监听 `127.0.0.1`，应与 MCP 同机部署，或置于受控服务网络。

## 已适配的旧接口

`TECHHAVEN_LEGACY_BASE_URL=https://host/api/v1`、`TECHHAVEN_LEGACY_RD_PREFIX=/rd` 时，Bridge 调用：

| 规范化能力 | 旧后端请求                                                |
| ---------- | --------------------------------------------------------- |
| 工单详情   | `GET /rd/{requirements                                    | bugs | tasks}/detail?id=...&org_id=...`                       |
| 工单列表   | `GET /rd/{requirements                                    | bugs | tasks}?org_id=...&status=...&page=...&page_size=...`   |
| 需求搜索   | `GET /rd/requirements?org_id=...&search=...&priority=...` |
| 趋势摘要   | 分别读取三类列表，每类最多 200 条，在 Bridge 内聚合       |
| 状态变更   | `POST /rd/{requirements                                   | bugs | tasks}/edit`，JSON 为 `{ id, status, org_id, reason }` |

响应既接受 `{ "errno": 0, "data": ... }`，也兼容直接返回数据；列表数据接受数组或 `{ list, total }`。工单时间字段兼容 snake_case 与 camelCase。真实后端若使用不同路径、方法或字段，应在本服务的 `LegacyBackendPort` adapter 中修改，不应把差异泄漏到 MCP。

## 快速开始

```bash
cd services/techhaven-agent-bridge
npm ci
cp .env.example .env
# 编辑 .env，并把变量注入进程；本服务不会自动读取 .env
npm run typecheck
npm test
npm run dev
```

生产式启动先构建：

```bash
npm ci
npm run build
TECHHAVEN_BRIDGE_TOKEN=... \
TECHHAVEN_LEGACY_BASE_URL=https://legacy.example.com/api/v1 \
TECHHAVEN_LEGACY_AUTH_MODE=bearer \
TECHHAVEN_LEGACY_AUTH_VALUE=... \
npm start
```

健康检查不需要认证：

```bash
curl http://127.0.0.1:3093/healthz
```

## 完整配置

| 环境变量                           | 必填     | 默认值                           | 说明                                                                               |
| ---------------------------------- | -------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `TECHHAVEN_BRIDGE_TOKEN`           | 是       | 无                               | MCP → Bridge 的内部 Bearer。使用至少 32 字节随机值，不与 Gateway/旧后端 token 复用 |
| `TECHHAVEN_BRIDGE_PORT`            | 否       | `3093`                           | 监听端口，范围 1–65535；监听地址固定为 `127.0.0.1`（3092 是 BFF，勿占用）          |
| `TECHHAVEN_BRIDGE_LEDGER_FILE`     | 否       | `./data/bridge-operations.jsonl` | append-only 幂等台账；需放持久卷并限制读权限                                       |
| `TECHHAVEN_LEGACY_BASE_URL`        | 是       | 无                               | 包含 `/api/v1`、不包含 `/rd` 的旧后端基址                                          |
| `TECHHAVEN_LEGACY_RD_PREFIX`       | 否       | `/rd`                            | 旧研发接口公共路径，必须以 `/` 开头且不能含查询串                                  |
| `TECHHAVEN_LEGACY_TIMEOUT_MS`      | 否       | `5000`                           | 单次旧后端请求超时，范围 100–60000 ms                                              |
| `TECHHAVEN_LEGACY_AUTH_MODE`       | 否       | `bearer`                         | `bearer`、`cookie` 或 `none`；`none` 只用于受控测试网络                            |
| `TECHHAVEN_LEGACY_AUTH_VALUE`      | 条件必填 | 空                               | bearer 的 token 值或完整 Cookie 内容；`none` 模式可留空                            |
| `TECHHAVEN_LEGACY_STATUS_MAP_JSON` | 否       | 空映射                           | 单行 JSON，结构为 `{ kind: { legacyValue: canonicalValue } }`；写入时自动反向映射  |

状态映射示例：

```dotenv
TECHHAVEN_LEGACY_STATUS_MAP_JSON={"bug":{"0":"new","1":"accepted","2":"processing","3":"verified","4":"closed"},"requirement":{"0":"new","1":"developing","2":"testing","3":"done","4":"closed"},"task":{"0":"todo","1":"doing","2":"done","3":"closed"}}
```

同一 kind 内 canonical 值必须唯一，否则无法安全反向映射，服务会拒绝启动。若旧后端已使用 canonical 字符串状态，可以不配置此项。

本服务只读取进程环境，不内置 dotenv loader。开发时可由 shell、进程管理器、Docker/Compose、systemd `EnvironmentFile` 或密钥管理服务注入；不要提交真实 `.env`。

## Bridge 内部 API

除 `/healthz` 外，所有请求都必须包含：

```http
Authorization: Bearer <TECHHAVEN_BRIDGE_TOKEN>
X-TechHaven-Session: <agent session id>
X-TechHaven-Org: <positive integer org id>
```

| 方法与路径                                                              | 用途                  |
| ----------------------------------------------------------------------- | --------------------- |
| `GET /internal/v1/tickets/:kind/:id`                                    | 读取详情              |
| `GET /internal/v1/tickets?kind=&status=&page=&pageSize=`                | 列表                  |
| `GET /internal/v1/requirements/search?query=&priority=&page=&pageSize=` | 搜索需求              |
| `GET /internal/v1/trends?days=30`                                       | 趋势摘要，最大 365 天 |
| `POST /internal/v1/tickets/:kind/:id/transition`                        | 状态变更              |

写请求还必须包含 `Idempotency-Key`，body 示例：

```json
{
  "toStatus": "processing",
  "reason": "用户批准 proposal thp_123",
  "expectedFromStatus": "accepted"
}
```

`expectedFromStatus` 是乐观并发前置条件；旧后端当前状态不一致时返回 `STALE_PRECONDITION`。body 上限 1 MiB。

## 幂等、失败与恢复

同一工单的读—校验—写—确认整段**按工单主体 `(orgId, kind, id)` 串行**：两个不同幂等键的提案改同一工单时，后到者排队等待，读到前者写入后的最新状态再做 `expectedFromStatus` 校验——避免并发读后互相覆盖（审查意见 F5）。幂等键只负责请求去重与重放，两者职责分离。

一次状态变更按下面顺序执行：

1. 读取当前状态，并校验可选的 `expectedFromStatus`。
2. 在 JSONL 台账写入 `started` 并 `fsync`，成功后才允许调用旧后端。
3. 调用旧后端一次；Bridge 不对不确定的写请求盲目重试。
4. 重新读取工单。目标状态已出现则写入 `confirmed`。
5. 写请求超时、网络断开或 5xx 时，先读后端对账；仍无法确认则记录 `uncertain` 并停止自动重试。

同一 `Idempotency-Key` 与相同请求摘要可安全重放；复用该 key 发送不同内容会返回 `IDEMPOTENCY_CONFLICT`。处于 `uncertain`/`failed` 且未对账到目标状态的 key 会被拒绝再次写入，需人工核对旧后端和台账后再创建新的 proposal。

台账只保存 key、请求摘要、session/org、工单定位、目标状态、状态和简短错误，不保存 reason、旧后端凭据或完整请求体。
启动恢复遇到任何损坏或字段不完整的台账行时会 fail-closed，避免把未知历史操作当作新写入；应从备份恢复或人工核对后修复文件，不能直接删除损坏行继续启动。

## 部署约束与安全

- **单实例**：当前台账是进程内串行化 + JSONL，不能为多个 Bridge 副本提供跨进程锁。上线初期只能运行一个副本。
- **持久化**：`TECHHAVEN_BRIDGE_LEDGER_FILE` 必须位于持久卷；丢失台账会丢失跨重启幂等证据。
- **网络**：进程只绑定 loopback。跨主机部署时应经 mTLS sidecar/受控反向代理暴露，并保持 Bridge 本身不监听公网。
- **密钥**：Bridge token 只给 MCP；旧后端凭据只给 Bridge。二者都不得进入前端、Git、JSONL 或普通应用日志。
- **组织隔离**：Bridge 把受信 MCP 传来的 org 写入旧请求；当前静态内部 token 本身不绑定 org，因此 MCP 是信任边界。若多个非同信任 MCP 共用 Bridge，需要升级为 mTLS 或带 audience/org claims 的短期服务 token。
- **趋势口径**：当前趋势由最多 200 条/类型的列表近似聚合，不是全量权威统计。真实后端若有聚合接口，应替换该 adapter 实现。
- **MySQL**：无需新增连接串、表或迁移；Bridge 不直连产品数据库。

## 验证

```bash
npm run typecheck
npm test
npm run smoke
```

`npm test` 覆盖配置、旧响应/字段/状态转换、幂等冲突、重放、写后确认和模糊失败对账。`npm run smoke` 会在本进程启动假旧后端和真实 Bridge HTTP server，检查认证、状态映射、写入确认与重复请求不二次写入。两者都不需要外部后端，也不证明真实旧接口契约已对齐。

真实联调前至少冻结并留存以下样本：三类详情/列表响应、编辑成功/业务失败响应、认证方式、状态枚举、组织隔离行为、重复写行为、超时后最终状态。联调通过后再决定是否把 JSONL 台账迁移到 PostgreSQL/MySQL 唯一键表以支持多实例。
