# AI 配置资产（Agent DB v0.5）

把每个账号的模型 API Key 当作**账号资产**管理：一个账号可持有多套命名配置，可显式切换；组织可共享配置给成员；个人配置优先于组织配置；每套配置可独立设置用量配额并按天/月统计消耗。

assets 模式的数据落在 Agent DB（PostgreSQL），由 Gateway 管理。浏览器仅在用户输入和保存请求时处理明文密钥；读取配置只返回脱敏串，产品后端不参与 assets 模式的密钥保存。

## 数据模型

见 `docs/agent-db/schema.sql` 第 11 节（迁移：`migrations/003-v0.3-to-v0.4-ai-config-assets.sql`）。

| 表                    | 职责                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| `ai_configs`          | 配置本体。`scope` 区分 `user` / `org`；密钥只存 AES-256-GCM 密文 + 指纹 + 脱敏串 |
| `ai_usage_daily`      | 按「配置 × 天」聚合用量；金额以微元（cost_micros）整数累加                       |
| `ai_quotas`           | 单套配置的配额：`daily/monthly` × `tokens/requests/cost_micros`                  |
| `ai_config_usages`    | 使用明细：谁、哪个会话、用了哪把钥匙（审计追责）                                 |
| `user_ai_preferences` | 用户当前选中的配置；为空走默认解析链                                             |
| `ai_org_memberships`  | 由可信管理通道维护的组织共享授权                                                 |
| `ai_usage_receipts`   | 配置/根会话/事件键去重，与用量写入同事务                                         |

## 解析优先级

会话创建时 Gateway 按 `X-TechHaven-Actor` 解析该用户的配置：

```text
1. explicit      用户显式选中（个人，或已共享的组织配置）
2. user_named    个人配置中按名字指定
3. user_default  个人默认配置
4. org_default   组织默认配置（必须 shared = true）
全落空 → 412 提示先配置
```

配额按已记录用量在新会话启动前检查，超限返回 429。显式选择的配置不可用时返回 409；默认个人配置被禁用时才继续寻找组织默认配置。已在运行中的请求可能超过剩余额度，当前不提供严格的逐 token 停机。

## HTTP API（Bearer Gateway Token + X-TechHaven-Actor）

| 方法   | 路径                        | 说明                                                   |
| ------ | --------------------------- | ------------------------------------------------------ |
| GET    | `/v1/ai-configs`            | 个人配置 + 组织共享配置（脱敏）+ 当前选中              |
| POST   | `/v1/ai-configs`            | 新建个人配置（body 含 `name`/`type`/`url`/`api_key`…） |
| GET    | `/v1/ai-configs/resolve`    | 预览当前会话将命中的配置与来源，不含明文               |
| PUT    | `/v1/ai-configs/preference` | 设置选中：`{config_id, org_id}`，null 表示清空         |
| GET    | `/v1/ai-configs/:id`        | 单条详情（脱敏）                                       |
| PATCH  | `/v1/ai-configs/:id`        | 更新元数据 / 置默认 / 启停                             |
| PUT    | `/v1/ai-configs/:id/key`    | 更换密钥（重新加密）                                   |
| DELETE | `/v1/ai-configs/:id`        | 删除（用量与配额级联清理，使用明细保留）               |
| GET    | `/v1/ai-configs/:id/usage`  | 日/月窗口用量 + 累计值                                 |

响应视图与前端 `AiConfigParams` 契约兼容：`type` / `provider` / `response_type` / `url` / `api_key`（脱敏）/ `model` / `reasoning_effort` / `max_tokens`，另有 `id` / `name` / `is_default` / `status` 等资产管理字段。

安全不变量：

- 所有写操作限定 `scope=user AND owner=当前用户`，无法触达他人配置；
- 组织共享必须有 `ai_org_memberships` 的有效成员授权。设置偏好和运行解析均检查授权，旧偏好不能绕过撤权；
- 明文密钥只流向 dsh 子进程环境变量，任何 HTTP 响应只含脱敏串；
- 路由需要 Bearer Token（Nginx/BFF 注入），不暴露公网。

组织配置（`scope=org`）的创建与配额管理**不开放 HTTP**：Gateway 无法验证「谁是组织管理员」，该操作走 DBA / 管理通道。

## 启用步骤

```bash
# 1. 迁移（可重复执行）
cd services/techhaven-gateway
npm run db:migrate -- --url "postgres://…/techhaven" --mode upgrade

# 2. 生成主密钥并写入 gateway.env（一次性的，丢了已存密钥就解不开）
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 3. gateway.env 中启用
TECHHAVEN_GATEWAY_STORE=postgres
TECHHAVEN_GATEWAY_DB_URL=postgres://…/techhaven
TECHHAVEN_AI_CONFIG_MASTER_KEY=<上一步生成值>

# 4. 重启 Gateway；日志出现「AI 配置资产已启用」即成功
```

主密钥轮换：`TECHHAVEN_AI_CONFIG_MASTER_KEY` 换新值，`_VERSION` 加一，旧值放 `_PREVIOUS`；存量密文在用户重新保存时逐条重加密，完成后移除 `_PREVIOUS`。

## 与现有链路的关系

- 未配置主密钥或存储为 jsonl 时，路由返回 503，会话创建回退到 `TECHHAVEN_AI_CONFIG_URL`（产品后端）链路，行为与升级前一致；
- 个人中心通过 `/v1/ai-configs/mode` 确认当前存储：assets 模式读写 Gateway 配置，只有明确返回 legacy 才使用产品后端接口。认证错误和服务异常均不回退。
- 旧后端的脱敏密钥不能迁移成可用凭据；首次启用 assets 后，用户需在个人中心重新输入完整密钥。保存时自动选择该个人配置供 Agent 使用。
- 已配置主密钥时，缺少 v0.5 表会阻断启动，避免数据库升级遗漏时静默切换存储。
- **组织授权（审查意见 F1）**：启用配置资产后，Gateway 同时以 `ai_org_memberships` 为权威校验会话创建的组织成员关系（`AiConfigOrgAccess`）——「授权的 org」「解析配置的 org」「MCP 凭据绑定的 org」三者强制一致。未配置资产的真实 dsh 链路创建会话 fail-closed（503）；mock driver 本地演示默认放行。

## 已知边界

- 配额未含通知/预警，超限时直接 429；`ai_quotas` 表结构已支持后续加软阈值；
- `recordUsage` 按会话启动、dsh `step/start` 和 `assistant/message.usage` 回写。请求数表示模型调用尝试；token 采用完成消息的最终统计，包含单独报告的缓存输入，流式 usage 片段不重复累加；子会话消耗也归属根会话配置。Mock 只记录模拟请求数，不虚构 token 消耗。
- `ai_usage_receipts` 与日聚合、明细同事务提交，以配置/根会话/事件键去重。进程异常退出前尚未到达 Gateway 的最后一段用量仍可能缺失。
- 当前 dsh 不提供可信费用数据，`cost_micros` 配额会以 412 拒绝运行；请使用 requests/tokens 配额。费用字段的零值不代表供应商实际收费为零。
- 明细保留 365 天、日聚合保留 400 天（见 schema 保留策略注释），由 DB 定时任务执行。

## v0.5 升级与共享授权

先执行 `npm run db:migrate -- --url "postgres://…/techhaven" --mode upgrade`，再部署 Gateway。
迁移 004 增加成员授权和用量去重表；不会从用户偏好自动创建成员授权。

组织管理员通过可信 DBA/同步通道维护授权，例如：

```sql
-- 仅在确认真实成员关系后执行；这里的 ID 是示例。
INSERT INTO ai_org_memberships (org_id, user_id) VALUES (7, 100) ON CONFLICT DO NOTHING;
-- 成员退出时撤销：
DELETE FROM ai_org_memberships WHERE org_id = 7 AND user_id = 100;
```

Gateway 会话按创建者隔离；JSONL 与 PG 的 `exit_info.owner_actor` 保留归属。
历史上无归属的会话默认不可通过用户 API 访问，不会自动归给当前登录者。
