# techhaven-mcp × dsh 挂载演示手册（ATTACH）

把 TechHaven 的 MCP Server（`services/techhaven-mcp`，stdio）挂到 DeepSeek Harness（dsh）上做端到端演示的操作手册。本文所有 dsh 侧的配置键名、命令、文件路径均摘自 dsh 官方文档原文并逐条标注出处；dsh 文档未提及的能力一律标「文档未提及，未经验证」。

> 状态边界：本文是 mock/离线挂载手册，目标是提升到 `verified-integration`，不代表 live dsh 已跑通。产品架构与权限权威见 [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) 和 [`docs/TH-RFC-001-agent-engine.md`](../../../docs/TH-RFC-001-agent-engine.md)；真实 dsh 门禁见 [`docs/ROADMAP.md`](../../../docs/ROADMAP.md) 的 R2。

配套文件：`dsh-mcp-config.example.yml`（可直接粘贴的挂载配置）。

---

## 0. 版本与文档依据

| 项                | 值                                                                                                                      | 出处                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| dsh 版本          | `0.1.2-alpha.1`                                                                                                         | 仓库 `package.json:3`     |
| 对应 commit / tag | `cd5ef8148158c3a752a658978873241fdf8e2bbc`，tag `dsh-v0.1.2-alpha.1`                                                    | `git log` / `git tag`     |
| 官方警示          | 「DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**」 | dsh 仓库根 `README.md:13` |

> **升级警示**：dsh 处于 developer preview，官方明示会有兼容性破坏变更。本手册与示例配置仅对上述 commit 验证过文档一致性；升级 dsh 后请对照 `docs/config-catalog.md` 的 `@deepseek-ai/dsh-mcp-client` 一节重新核对键名。

本手册引用的 dsh 文档（均为该 commit 下的路径）：

1. `docs/config-catalog.md` §`@deepseek-ai/dsh-mcp-client`（1441–1510 行）——配置字段全集（权威来源）
2. `packages/mcp/mcp-client/README.md`——包契约：字段表与默认值（55–66 行）、工具命名（74 行）、启动失败行为（70 行）、重连（91 行）、环境变量净化（131–133 行）
3. `docs/user/guide/mcp-memory.md`——面向用户的挂载指南：启动命令（28 行）、持久化 patch 层（33 行）、自接 MCP server 模板（88–99 行）、发现为异步（82 行）
4. `apps/cli/README.md`——`dsh` 命令模式（11–17 行）、patch 层叠顺序（36–41 行）
5. `apps/cli/reference/README.md`——`--dump-config` 行为（38–42、76 行）
6. `.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md`——设计决策（命名、净化、命名空间）
7. dsh 源码（交叉验证默认值）：`packages/mcp/mcp-client/src/index.ts:107-131`、`packages/subprocess/subprocess/src/index.ts:44`

交叉验证方式：每个关键键名至少有两处独立来源（config-catalog + 包 README 一致；默认值再与源码核对一致）才写入本文。设计笔记（来源 6）与当前版本的差异见 §7。

---

## 1. techhaven-mcp 侧准备

### 1.1 构建

```bash
cd services/techhaven-mcp
npm install
npm run build          # tsc 编译到 dist/，产物入口为 dist/index.js
```

（命令出处：`services/techhaven-mcp/package.json` scripts：`build = tsc -p tsconfig.json`，`outDir: dist`，入口 `src/index.ts` → `dist/index.js`。）

### 1.2 签发 agent token

```bash
TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me \
  npm run token -- issue --org 1 --sid poc-dsh-1 --scopes rd:read,rd:write --ttl 2h
```

（CLI 用法出处：`services/techhaven-mcp/src/cli.ts:15-21` 的用法说明；`--scopes` 只接受 `rd:read` / `rd:write`，见 `src/cli.ts:56`。）

要点：

- **`TECHHAVEN_TOKEN_SECRET` 必须一致**：签发时用的 secret 与运行时注入给 server 的必须完全相同（HMAC 验签，`src/config.ts:28-31` 缺失即抛错）。签发与验签可用同一 secret。
- `--sid` 是会话标识（token 单会话 + 单组织 + scope + TTL，见 techhaven-mcp `README.md:95` 目录注释 `auth/agentToken.ts`），审计里会记录。
- 签发后可自验：`TECHHAVEN_TOKEN_SECRET=... npm run token -- verify thm_v1.xxx.yyy`（`src/cli.ts:20-21、69-76`）。
- **最小 scope 原则**：只做读演示就只签 `--scopes rd:read`（见 §4.3、§5）。

### 1.3 后端模式：从 `TECHHAVEN_BACKEND=mock` 起步

| 模式           | 说明                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock`（默认） | 内置 8 条演示数据（3 需求 + 3 缺陷 + 2 任务，全在 org 1），零外部依赖（techhaven-mcp `README.md:27`；种子数据见 `src/techhaven/mockClient.ts` 的 `SEEDS`） |
| `http`         | 调真实后端 `/rd/*`，需要 `TECHHAVEN_SERVICE_TOKEN`；朋友侧 P0 交付后再联调（techhaven-mcp `README.md:28`）                                                 |

演示一律从 `mock` 开始。先跑一次冒烟确认服务本身闭环：

```bash
TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me npm run smoke
```

（出处：techhaven-mcp `README.md:18`；smoke 覆盖握手 → 列工具 → 读 → 合法迁移 → 非法迁移被拒 → 伪造 hashId 得友好错误，`README.md:21`。）

### 1.4 techhaven-mcp 注入给子进程的环境变量全集

| 变量                                                 | 必填          | 说明                                                            | 出处（techhaven-mcp）                 |
| ---------------------------------------------------- | ------------- | --------------------------------------------------------------- | ------------------------------------- |
| `TECHHAVEN_AGENT_TOKEN`                              | 是            | `npm run token -- issue` 签发的 thm_v1 token；缺失即启动失败    | `src/config.ts:24-27`                 |
| `TECHHAVEN_TOKEN_SECRET`                             | 是            | HMAC 验签密钥，须与签发方一致                                   | `src/config.ts:28-31`                 |
| `TECHHAVEN_BACKEND`                                  | 否            | `mock` \| `http`，默认 `mock`                                   | `src/config.ts:33-36`                 |
| `TECHHAVEN_AUDIT_FILE`                               | 否            | 审计 JSONL 路径，默认 `./audit/agent-audit.jsonl`，目录自动创建 | `src/config.ts:51`、`src/audit.ts:34` |
| `TECHHAVEN_API_BASE_URL` / `TECHHAVEN_SERVICE_TOKEN` | http 模式必填 | 后端基地址与服务凭据（agent token 不传给后端）                  | `src/config.ts:39-42`                 |
| `TECHHAVEN_DB_URL` / `TECHHAVEN_AGENT_NAME`          | 否            | DB 审计双写 / agent 身份名（可选）                              | `src/config.ts:10-12、52-53`          |

---

## 2. dsh 侧准备

1. **Node 版本**：dsh 要求 `node: "^22.19.0 || >=24.0.0"`（dsh `package.json:8-9`）；techhaven-mcp 要求 `>=20`（其 `package.json` engines）。装满足两者的高版本即可。
2. **安装 dsh**（二选一，dsh 根 `README.md:21-38`）：
   ```sh
   npx @deepseek-ai/dsh web          # 免克隆直接跑
   # 或源码方式：
   pnpm install && pnpm run build && pnpm dsh web
   ```
3. **模型 Provider**：Web UI 里 Settings → Models 配 key（文档：`docs/user/guide/providers.md`）。没配 provider 时 harness 能启动、MCP 工具能注册，但无法跑对话演示。
4. `$DSH_HOME` 是 dsh 的家目录，持久化 patch 层放在其下（见 §3.3）。

---

## 3. dsh 侧挂载配置

### 3.1 机制一句话

dsh 通过插件 `@deepseek-ai/dsh-mcp-client` 消费外部 MCP server：**每个 MCP server 是一行插件配置**，stdio 方式下 dsh 以子进程拉起你的命令，完成 MCP 握手后发现工具，注册为模型可见的原生工具，名字为 `mcp__<serverName>__<rawName>`（包 README §Use this package / 12、28、74 行；config-catalog.md:1453-1457）。「nothing ships enabled, so you opt in」——默认不加载任何 MCP server，必须显式加行（包 README:12）。

只桥接 **Tools**：MCP Resources 与 Prompts 不支持（包 README:12、191 行）。

### 3.2 配置 schema（真实键名，两源一致）

`Config = StdioConfig | StreamableHttpConfig`，按 `transport` 判别。以下逐键给出出处，**全部来自 dsh 文档原文**：

**stdio 传输**（`docs/config-catalog.md:1449-1473`；字段表与默认值见 `packages/mcp/mcp-client/README.md:55-66`；默认值另与源码 `src/index.ts:118-122` 核对一致）：

| 键                   | 类型 / 默认                        | 含义                                                                                                                           | 出处                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `transport`          | 必填，`'stdio'`                    | 选择子进程 stdio 传输                                                                                                          | catalog:1451-1452                |
| `serverName`         | 必填                               | 工具命名空间，须匹配 `[A-Za-z0-9_-]{1,32}`，在存活的 mcp-client 实例间唯一；重复时**后加载的实例失败**                         | catalog:1453-1457；README:58、77 |
| `command`            | 必填                               | 启动 server 的可执行文件                                                                                                       | catalog:1459-1460                |
| `args`               | `string[]`，默认 `[]`              | 参数原样传递，**不做 shell 插值**                                                                                              | catalog:1461-1462；index.ts:118  |
| `env`                | `Record<string,string>`，默认 `{}` | 额外 env，**合并在净化后的父环境之上**（见 §3.4）                                                                              | catalog:1463-1464；index.ts:119  |
| `cwd`                | `string`，默认 `''`                | 子进程工作目录                                                                                                                 | catalog:1465-1466；index.ts:120  |
| `toolCallTimeoutMs`  | number，默认 `60000`               | 单次 `tools/call` 超时（毫秒）                                                                                                 | catalog:1467-1468；README:61     |
| `failOnStartupError` | boolean，默认 `false`              | 为 `true` 时，首连/工具同步失败使插件激活失败（harness 启动中止）；`false` 时 harness 照常启动，该 server 工具不出现并记录错误 | catalog:1469-1470；README:62、70 |
| `reconnect`          | ReconnectConfig，可省略            | 断线自动重连策略，省略即用默认值                                                                                               | catalog:1471-1472                |

**`reconnect` 子块**（`docs/config-catalog.md:1497-1507`；默认值与源码 `index.ts:107-110` 一致；行为见 README:91）：

| 键               | 默认    | 含义                                                                                   |
| ---------------- | ------- | -------------------------------------------------------------------------------------- |
| `enabled`        | `true`  | 断线后自动重连；`false` 则工具保持列出但调用失败，直到 reload/重启                     |
| `initialDelayMs` | `500`   | 首次重连延迟，逐次翻倍                                                                 |
| `maxDelayMs`     | `30000` | 退避上限；也是「存活多久后重置尝试预算」的阈值                                         |
| `maxAttempts`    | `10`    | 每次断线的连续失败预算，耗尽后该 server 的工具被摘除、停止重连，直到 reload 配置或重启 |

**Streamable HTTP 传输**（`docs/config-catalog.md:1475-1495`；`docs/user/guide/mcp-memory.md:101`）：`transport: 'streamable-http'` + `serverName` + `url`（MCP endpoint URL）+ `headers`（附加请求头）+ `toolCallTimeoutMs` + `failOnStartupError` + `reconnect`。techhaven-mcp P0 **仅支持 stdio**，此组键名仅作记录（见 §7 第 5 条）。

### 3.3 配置写在哪、怎么加载（真实文件路径）

配置形态是 **YAML 的 Cordis patch overlay**，行格式 `- insert: [ - id: …, name: '@deepseek-ai/dsh-mcp-client', config: … ]`（`docs/user/guide/mcp-memory.md:88-99` 及同仓库示例 `apps/cli/config/examples/mcp-memory/memorix.cordis.yml`）。三个加载位置（均为文档原文用法）：

| 方式               | 命令 / 位置                                       | 出处             |
| ------------------ | ------------------------------------------------- | ---------------- |
| 临时（推荐演示用） | `dsh web --patch "<yml 绝对路径>"`                | mcp-memory.md:28 |
| 单 profile         | 并入 `$DSH_HOME/profiles/<name>/cordis.patch.yml` | mcp-memory.md:33 |
| 全机生效           | 并入 `$DSH_HOME/cordis.patch.yml`                 | mcp-memory.md:33 |

层叠顺序：bundle patch → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays（`apps/cli/README.md:36-41`）。**并入已有文件时只合并自己的 `- insert:` 块，不要整文件覆盖**（mcp-memory.md:33 原文提醒目标文件可能已含其他 patch）。编辑 patch 文件会**就地热重载**该 server 连接，未变的工具名保持不变（包 README:91；HMR 机制另见设计笔记 §Lifecycle）。

完整可粘贴示例见本目录 **`dsh-mcp-config.example.yml`**，核心行：

```yaml
- insert:
    - id: techhaven-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: techhaven
        command: node
        args: ["D:/Desktop/Chen/TechHaven/services/techhaven-mcp/dist/index.js"] # ← 绝对路径
        env:
          TECHHAVEN_AGENT_TOKEN: !!js process.env.TECHHAVEN_AGENT_TOKEN
          TECHHAVEN_TOKEN_SECRET: !!js process.env.TECHHAVEN_TOKEN_SECRET
          TECHHAVEN_BACKEND: mock
          TECHHAVEN_AUDIT_FILE: "D:/Desktop/Chen/TechHaven/services/techhaven-mcp/audit/agent-audit.jsonl"
```

（`!!js process.env.X` 是 dsh 官方示例的原文写法：包 README:43 `GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN`；mcp-memory.md:98 `cwd: !!js process.cwd()`。**用此写法前必须先 export 对应变量**；若图省事直接写明文字面量也可以——`env` 是 `Record<string,string>`——但含密钥的 patch 文件不要提交仓库。）

### 3.4 关键陷阱：环境变量净化（environment scrubbing）

> **dsh 在拉起 stdio 子进程前，会把父环境中名字命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和全部 `DSH_*` 变量剥掉，其余照常继承；配置里的 `env` 再合并到净化结果之上，显式声明总是生效。**

出处（三处文档 + 源码一致）：包 README §Environment scrubbing (stdio)（131–133 行）；mcp-memory.md:11-13；设计笔记 §Subprocess environment（150–152 行）；净化正则定义于 `packages/subprocess/subprocess/src/index.ts:44`（`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`）。

对 techhaven-mcp 的直接后果：

- `TECHHAVEN_AGENT_TOKEN`、`TECHHAVEN_TOKEN_SECRET` 均命中净化模式 → **仅靠「先 export 再启动 dsh」不会传进子进程，必须写进配置的 `env`**（值可硬编码，也可用 `!!js process.env.X` 从 dsh 自身环境取）。
- `TECHHAVEN_BACKEND`、`TECHHAVEN_AUDIT_FILE` 不命中模式，理论上可 ambient 继承；为确定性起见，示例配置里同样显式声明（mcp-memory.md:13 的建议即「需要什么就加到该行的 `config.env`」）。

### 3.5 挂载后的工具名

`serverName: techhaven` 时，P0 的 6 个工具以如下名字出现在模型工具列表（命名规则出处：包 README:74、config-catalog.md:1453-1457、设计笔记:95-97；工具清单出处：techhaven-mcp `src/tools/index.ts:94-231` 的 `registerTool` 调用）：

| 模型侧工具名                           | scope    | 说明                                                               |
| -------------------------------------- | -------- | ------------------------------------------------------------------ |
| `mcp__techhaven__get_ticket`           | rd:read  | 读单张工单（入参 `kind` + `id`=hashId）                            |
| `mcp__techhaven__list_my_tickets`      | rd:read  | 列本组织工单（`kind`/`status`/`page` 可选，单页上限 50）           |
| `mcp__techhaven__search_requirements`  | rd:read  | 按关键词/优先级搜需求                                              |
| `mcp__techhaven__get_trend_summary`    | rd:read  | 近 N 天趋势摘要                                                    |
| `mcp__techhaven__update_ticket_status` | rd:write | 状态迁移（非法迁移拒绝，必填 `reason`；staged 模式下先建提案）     |
| `mcp__techhaven__get_semantics`        | rd:read  | 语义层：字段业务含义与指标口径                                     |
| `mcp__techhaven__get_proposal`         | rd:read  | 只查询写提案状态；staged 模式下人工批准后由 server worker 主动应用 |

> 差异说明：techhaven-mcp `README.md` 的工具表列了 5 个，代码实际注册 6 个（`get_semantics` 未同步进 README 表）。以代码为准。

---

## 4. 端到端演示脚本

### 4.1 演示前 checklist

```bash
# ① techhaven-mcp 构建并冒烟（§1）
cd services/techhaven-mcp && npm install && npm run build
TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me npm run smoke

# ② 签发演示 token 并 export（dsh 启动前必须已 export，!!js 才取得到）
export TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me
export TECHHAVEN_AGENT_TOKEN=$(TECHHAVEN_TOKEN_SECRET=dev-only-secret-change-me \
  npm run token -- issue --org 1 --sid poc-dsh-1 --scopes rd:read,rd:write --ttl 2h \
  | grep -o 'thm_v1\.[^ ]*')
```

（`grep` 只是取输出里的 token；token 形如 `thm_v1.…`，见 `src/cli.ts` 用法注释与 `npm run token -- verify` 示例。若不想用管道，手动复制输出中的 token 再 `export` 即可。）

```bash
# ③ 复制示例配置并按需改路径
cp dsh/dsh-mcp-config.example.yml /tmp/techhaven.cordis.yml
#    编辑 /tmp/techhaven.cordis.yml：args 里的 dist/index.js 改成你的绝对路径；
#    TECHHAVEN_AUDIT_FILE 同理
```

### 4.2 启动前检查与启动

**检查 patch 是否接线**（dsh 文档提供的真实检查命令）：

```sh
dsh web --patch /tmp/techhaven.cordis.yml --dump-config
```

预期：输出中出现 `id: techhaven-mcp` 的行，且带注释标明该行由哪个文件提供；`--patch` overlay 在组合树中排在最后（`apps/cli/reference/README.md:38-42`：dump 会打印注释指明每行来源文件，找不到目标的 patch 会报到 stderr；`--dump-default-config` 只打印 bundle 层，`--dump-config` 才包含 patch 层）。注意 dump 不会求值 `!!js` 表达式（reference/README.md:42），所以 dump 里 env 显示为表达式原文属正常。

**启动**：

```sh
dsh web --patch /tmp/techhaven.cordis.yml
```

（`dsh web` 是 `--profile web` 的别名，`apps/cli/README.md:16`；`--patch` 用法见 mcp-memory.md:28。）

### 4.3 验证 techhaven 工具已出现

dsh 文档**没有**提供独立的「列出工具」CLI 命令（检索过 `docs/` 与 `apps/cli/`，未提及；见 §7 第 1 条）。文档记载的验收方式是：

1. **等待异步发现**：初始发现是异步的，先等 provider 的 `mcp__...` 工具出现，再发第一条验证 prompt（mcp-memory.md:82 原文：「Initial discovery is asynchronous, so wait for the provider's `mcp__...` tools before sending the first validation prompt.」）。Web 界面的工具列表中应能看到 `mcp__techhaven__get_ticket` 等 7 个名字（命名规则见 §3.5）。
2. **首连失败的表现**（用于对照排除）：harness 仍会启动，但该 server 的工具不出现，且会记录一条错误日志；想让失败在启动期就显式中止，设 `failOnStartupError: true`（包 README:70）。
3. **脚本化验证**（用 headless 模式跑一条就退出，`apps/cli/README.md:13`「Run one fresh persisted session, print the final answer, and exit.」）：
   ```sh
   dsh --profile headless --patch /tmp/techhaven.cordis.yml \
     "调用 mcp__techhaven__list_my_tickets，kind 传 task，把返回的工单标题列出来"
   ```
   返回了两条任务标题（Vite 升级、评论树用例）即代表工具流闭环。
4. **服务端对照**：每次工具调用后 `TECHHAVEN_AUDIT_FILE` 追加一行 JSONL（§5）；server 的日志以 `[techhaven-mcp]` 前缀走 stderr（`src/log.ts:1-4`）。

### 4.4 三个演示 prompt

以下 prompt 直接发给已挂载 techhaven 的 dsh 会话。期望工具调用列在括号里。

**① 列出我们组织的任务工单**

> 列出我们组织的任务工单。

（→ `mcp__techhaven__list_my_tickets`，`kind: task`。mock 数据下返回 2 条任务。）

**② 读取缺陷并总结**

> 读取缺陷 <hashId>，用中文总结它的标题、描述、当前状态与优先级。

（→ `mcp__techhaven__get_ticket`，`kind: bug`，`id: <hashId>`。）

**③ 变更缺陷状态**

> 把缺陷 <hashId> 的状态改为 accepted，理由：复现路径已确认，安排进入处理。

（→ `mcp__techhaven__update_ticket_status`，`kind: bug`，`id: <hashId>`，`to_status: accepted`，`reason: …`。bug 的 `new → accepted` 是合法迁移（techhaven-mcp `README.md:68` 状态机）。）

**获取 `<hashId>` 的两种方式**（hashId 是 52 位 hashids 串，盐与 scope 见 techhaven-mcp `src/hashid.ts:12-28`，**不可自行构造**，`get_ticket` 的入参说明亦如此要求）：

- **推荐**：先发演示 ①② 的前置问题「列出我们组织的缺陷工单」，从 `mcp__techhaven__list_my_tickets` 出参的 `id` 字段复制（`src/tools/index.ts:32` 出参 `id: encodeId(t.id, t.kind)`）。
- 或构建后在本地用仓库自己的 hashid 镜像算一条（例如 bug #1「KaTeX 公式在暗色主题下对比度不足」，mock 中状态为 `new`，正好走 ③ 的 `new → accepted`）：
  ```sh
  node -e "import('file:///D:/Desktop/Chen/TechHaven/services/techhaven-mcp/dist/hashid.js').then(m=>console.log(m.encodeId(1,'bug')))"
  ```

**可选反向演示**（体现守卫与审计的价值）：

- 非法迁移：对同一缺陷说「把状态直接改成 closed」→ `new → closed` 非法，被状态机拒绝（smoke 已覆盖该路径，techhaven-mcp `README.md:21`）。
- scope 不足：用只带 `rd:read` 的 token 挂载，再发演示 ③ → 被 scope 守卫拒绝并记入审计。

---

## 5. 安全边界

- **scope 最小化**：演示 ①② 只需 `rd:read`——建议为读演示单独签 `--scopes rd:read` 的 token；只有演示 ③ 需要 `rd:write`。CLI 只接受这两个 scope（`src/cli.ts:56`）。
- **TTL**：演示用 `--ttl 2h`；过期后所有调用验签失败，需重签并更新配置 env（编辑 patch 文件即热重载，§3.3）。签发前不确定时可 `npm run token -- verify` 自验（`src/cli.ts:69-76`）。
- **组织绑定**：token 绑定 `--org 1`；mock 数据全部在 org 1，跨组织不可见（techhaven-mcp `README.md:27`）。
- **审计**：每次工具调用向 `TECHHAVEN_AUDIT_FILE`（默认 `./audit/agent-audit.jsonl`）追加一行 JSONL：时间、会话、组织、工具、**参数摘要（SHA-256，不落原始参数）**、allow/deny 与原因、耗时；目录不存在会自动创建（techhaven-mcp `README.md:76`、`src/audit.ts:34`）。**注意相对路径按子进程 cwd 解析**：dsh 侧 `cwd` 默认空串（index.ts:120），此时子进程继承 dsh 的工作目录，即你启动 `dsh` 的目录——演示配置里建议写绝对路径（示例配置已如此）。
- **凭据只在服务端**：agent token 只用于本服务与引擎之间，**不会**传给 TechHaven 后端；后端调用走独立的服务凭据（techhaven-mcp `README.md:30`）。
- **dsh 侧的可寻址性**：`mcp__techhaven__*` 的稳定命名形状可用作权限/遥测规则（设计笔记:97「`mcp__*`, `mcp__github__*`」；config-catalog.md:1690 显示 `exclude: [mcp_*]` 在不含 MCP 工具的部署里也合法）。
- **patch 文件卫生**：若在 `env` 里写明文 token/secret，该文件等同密钥，勿提交仓库；dsh 文档的偏好是把变量名放进 `config.env`、值经 `!!js` 引自环境（mcp-memory.md:13、包 README:43）。

---

## 6. 故障排查

**server 日志走 stderr**：stdio 传输下 stdout 是 MCP JSON-RPC 通道，任何杂音都会污染协议——techhaven-mcp 的全部日志经 `src/log.ts` 输出到 **stderr**，带 `[techhaven-mcp]` 前缀。dsh 文档只笼统说错误会「logged」、重连进度「visible in the logs」（包 README:70、91），**未描述子进程 stderr 在 dsh 侧如何转发/展示——文档未提及，未经验证**；dsh 侧排查以 dsh 自己的日志输出与 `--dump-config` 为准。

| 症状                                    | 可能原因 / 处置                                                                                                                         | 依据                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 工具完全没出现，dsh 正常启动            | 首连失败被默认策略吞掉（`failOnStartupError` 默认 `false`）；查 dsh 日志中的错误，或临时设 `failOnStartupError: true` 让失败显式中止    | 包 README:62、70                          |
| 工具过一会儿才出现                      | 发现是**异步**的，等 `mcp__techhaven__*` 出现再发 prompt                                                                                | mcp-memory.md:82                          |
| 每次调用都验签失败                      | token 过期（TTL 到）→ 重签；`npm run token -- verify` 先自验                                                                            | `src/cli.ts:69-76`                        |
| 验签失败但 token 未过期                 | 签发与运行时 `TECHHAVEN_TOKEN_SECRET` 不一致 → 统一；**或犯了净化陷阱**：变量只 export 没写进配置 `env` → 按本文 §3.4 补进 `config.env` | §3.4；`src/config.ts:28-31`               |
| 工具一个都没有 + `npm run build` 没跑过 | `args` 里的 `dist/index.js` 路径错误/文件不存在 → 构建并写绝对路径                                                                      | `package.json` scripts、catalog:1461-1462 |
| `dump-config` 时 patch 行没接上         | patch 目标不匹配会报到 stderr；确认顶层是 `- insert:` 且 `name`/键名拼写与本文一致                                                      | reference/README.md:42                    |
| `serverName` 冲突报错                   | 同一部署里另一个 mcp-client 实例占了 `techhaven` → 换名（同名时后加载实例失败，不会静默遮蔽）                                           | catalog:1453-1457；README:77              |
| 运行中断线后工具消失                    | 重连预算耗尽（默认连续 10 次失败）→ 工具被摘除，reload 配置或重启恢复；存活超过 `maxDelayMs` 会重置预算                                 | README:66、91                             |
| 审计文件「不见了」                      | `TECHHAVEN_AUDIT_FILE` 是相对路径，落在了子进程 cwd（即 dsh 启动目录）下 → 用绝对路径                                                   | §5；index.ts:120                          |
| server 启动即报缺少 token/secret        | techhaven-mcp 的 `ConfigError`：env 没注入成功 → 检查 §3.4 净化与 `!!js` 变量是否已 export                                              | `src/config.ts:24-31`                     |

---

## 7. 未确认事项与差异记录（诚实清单）

1. **「列出工具」的专用命令**：dsh 文档未提供独立的工具列表/检查 CLI 命令（文档未提及，未经验证）。§4.3 的验证方法均为文档明确记载或可从文档直接推出：`--dump-config`（验证接线）、异步发现等待（mcp-memory.md:82）、headless 试跑（apps/cli/README.md:13）、审计文件对照。
2. **子进程 stderr 的去向**：dsh 文档未描述 stdio 子进程的 stderr 如何转发/展示（文档未提及，未经验证）。techhaven-mcp 侧「stdout 只走协议、日志走 stderr」是 MCP stdio 的协议约束与本仓库实现（`src/log.ts:1-4`）。
3. **设计笔记与当前版本的漂移**：2026-07-07 设计笔记里的 `StdioConfig`（35-55 行）没有 `failOnStartupError` 与 `reconnect`（它们由 2026-08-06 auto-reconnect 特性加入）。以当前版本为权威：`docs/config-catalog.md:1449-1507` 与源码 `src/index.ts:107-131` 两处一致。
4. **catalog 与包 README 的字段可选性表述**：config-catalog 的 TS 片段把 `args/env/cwd/toolCallTimeoutMs/failOnStartupError` 写成无 `?`（schema 层有默认值，实际可省略）；包 README 字段表与源码默认值（`index.ts:118-131`）证实可省略。本文按「可省略 + 默认值」呈现。
5. **HTTP 传输对 techhaven-mcp 未验证**：dsh 支持 `streamable-http`（键名见 §3.2，出处 config-catalog.md:1475-1495、mcp-memory.md:101），但 techhaven-mcp P0 只有 stdio 入口（`src/index.ts`），该组键名仅记录、未对着本服务验证。
6. **`!!js` 未导出变量的行为**：`env` 值用 `!!js process.env.X` 而变量未 export 时 dsh 的具体行为未见文档（未经验证）——演示脚本要求先 export（§4.1 ②）。
7. **techhaven-mcp README 与代码的工具数差异**：README 表列 5 个工具，代码注册 6 个（含 `get_semantics`，`src/tools/index.ts:210-231`）；本文以代码为准（§3.5）。
