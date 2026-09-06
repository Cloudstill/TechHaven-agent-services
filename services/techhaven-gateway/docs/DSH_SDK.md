# dsh SDK 真实 API 考察（供 `src/drivers/dsh.ts` 实现依据）

> 架构决策更新（TH-RFC-001 v0.2）：本文是 v0.1.2-alpha.1 源码勘察记录，不是 live 集成证明。由于 SDK 线协议不能编程式应答权限或取消单个在途 turn，TechHaven 产品域写入以服务端 proposal/policy 为权威；runner 内部权限无法可靠应答时必须 fail-closed。推进门禁见 [`docs/ROADMAP.md`](../../../docs/ROADMAP.md) 的 R1/R2。

- 考察基线：**dsh v0.1.2-alpha.1**（GitHub `deepseek-ai/deepseek-harness`，tag `dsh-v0.1.2-alpha.1`，commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`，浅克隆源码阅读）。
- 考察方式：源码阅读 + 包清单 + README；文内「出处」均为该仓库内相对路径 `文件:行`。
- 本文所有结论均标注出处；**无法从源码确认的点集中在文末「未验证清单」**。
- npm 发布状态（2026-08-29 通过 registry.npmjs.org 在线核实，见 §1）。

---

## 1. 包名与安装方式

dsh 的 SDK 由四个包组成（组地图：`packages/sdk/README.md:29-31`）：

| 角色                                  | npm 包名（逐字取自 package.json）     | 出处                                   |
| ------------------------------------- | ------------------------------------- | -------------------------------------- |
| TypeScript 客户端（本文主对象）       | `@deepseek-ai/dsh-sdk-client`         | `packages/sdk/client/package.json:2`   |
| 线协议（类型 + 传输）                 | `@deepseek-ai/dsh-sdk-protocol`       | `packages/sdk/protocol/package.json:2` |
| runtime 侧 JSON-RPC 服务插件          | `@deepseek-ai/dsh-sdk-jsonrpc-server` | `packages/sdk/server/package.json:2`   |
| dsh CLI（runtime 本体，含 `bin.dsh`） | `@deepseek-ai/dsh`                    | `apps/cli/package.json:2,14`           |

导出面（`packages/sdk/client/src/index.ts:12-30`，逐字）：
`DeepSeekHarness`、`HarnessSession`、`RunOptions`（type）、`HarnessClient`、`RequestTimeoutError`、`SdkProtocolError`、`TransportClosedError`、`NotificationSubscription`（type）、`JsonRpcResponseError`（re-export 自 protocol）、`ContentBlock`、`SdkPromptContentBlock`、`DeepSeekHarnessOptions`、`HarnessClientOptions`、`HarnessNotification`、`NotificationFilter`、`RunResult`（均 type）。

### npm 发布状态（2026-08-29 在线核实）

- `@deepseek-ai/dsh-sdk-client` **已发布**：dist-tag `latest` 停在 `0.0.1-rc.1`（陈旧），`next` 指向 **`0.1.1-rc.2`**（历史版本 0.0.1-rc.1 ~ 0.1.1-rc.2 共 10 个）。
- `@deepseek-ai/dsh` **已发布**：`latest` = `next` = **`0.1.1-rc.2`**（2026-08-21 发布）。
- **`0.1.2-alpha.1` 尚未发布到 npm**（两个包均无该版本）。

### 安装结论

1. **走 npm（推荐，能装到 0.1.1-rc.2）**：
   ```sh
   npm i @deepseek-ai/dsh-sdk-client@0.1.1-rc.2 @deepseek-ai/dsh@0.1.1-rc.2
   ```
   - 客户端与 dsh CLI **必须同版本**：客户端启动时校验两个包 manifest 的 `version` 严格相等，不等即抛 `dsh SDK client <v> requires the same dsh version, got <v>`（`packages/sdk/client/src/launch.ts:55-66`，检查在 `:58-60`）。
   - 已发布的 0.1.1-rc.2 客户端将 monorepo 内的依赖关系改为 `peerDependencies`（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-sdk-protocol`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/cordis`，均为 `^0.1.1-rc.2`；registry 0.1.1-rc.2 元数据），npm 7+ 会自动装 peer 依赖；仓库内源码清单里另有 `dependencies: { "@deepseek-ai/dsh": "workspace:*" }`（`packages/sdk/client/package.json:25`）。
   - 注意 `latest` tag 陈旧指向 0.0.1-rc.1，**务必用显式版本号或 `@next`**。
2. **源码构建（要 0.1.2-alpha.1 时）**：
   ```sh
   git clone https://github.com/deepseek-ai/deepseek-harness.git && cd deepseek-harness
   git checkout dsh-v0.1.2-alpha.1
   pnpm install && pnpm build          # pnpm@11.7.0、Node ^22.19 || >=24（根 package.json engines）
   ```
   随后在本服务内以本地依赖方式接入（例如 `npm i file:../deepseek-harness/packages/sdk/client` 之类），**不要**写进 package.json dependencies（本驱动用动态 import，允许运行时缺失）。源码模式可直接运行：客户端检测 `@deepseek-ai/dsh` 无构建产物时回退为 `node --import tsx src/bin.ts --profile sdk` 并自动附加源码兼容 patch（`packages/sdk/client/src/launch.ts:86-109`）。

> 本驱动（`src/drivers/dsh.ts`）通过 `await import("@deepseek-ai/dsh-sdk-client")` 动态加载，包缺失或字段不符时抛出带中文说明的 Error；mock 驱动仍是默认，dsh 失败只影响显式选择 dsh 的部署。

---

## 2. 启动 runtime 的真实调用形状

### 2.1 高层入口 `DeepSeekHarness`（`packages/sdk/client/src/api.ts:22`）

README 逐字示例（`packages/sdk/client/README.md:32-46`）：

```ts
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

await using harness = new DeepSeekHarness({
  profile: "sdk",
  patches: ["./automation.cordis.yml"],
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  reasoningEffort: ReasoningEffortId("max"),
  maxTokens: 49_152,
});
const result = await harness.run("say hi");
console.log(result.finalResponse);
```

构造参数表（类型出处 `packages/sdk/client/src/types.ts:24-67`）：

| 参数                   | 类型                | 语义                                                                                                     | 出处                              |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `dshBin?`              | `string`            | dsh CLI 入口（绝对或相对路径）；**缺省时解析同版本 `@deepseek-ai/dsh` 包的 bin**，不做任何捆绑运行时发现 | types.ts:26；client/README.md:122 |
| `profile?`             | `string`            | 服务 SDK 协议的命名 profile，**默认 `"sdk"`**                                                            | types.ts:28；launch.ts:132        |
| `patches?`             | `string[]`          | 有序 per-launch profile patch 文件；相对路径在 spawn 前解析，argv 形如 `... --patch <abs>`               | types.ts:30；launch.ts:136-143    |
| `dshHome?`             | `string`            | 子进程的 Harness home；相对路径 spawn 前解析，经 `DSH_HOME` 环境变量下发                                 | types.ts:32；launch.ts:140,148    |
| `processCwd?`          | `string`            | dsh 进程自身的工作目录                                                                                   | types.ts:34                       |
| `env?`                 | `NodeJS.ProcessEnv` | 完整子进程环境；**给对象则整体替换父环境**，`undefined` 继承父 env（凭据策略归调用方）                   | types.ts:42                       |
| `initializeTimeoutMs?` | `number`            | 初始握手上限，默认 10000（`DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000`）                                     | types.ts:44；launch.ts:12         |
| `requestTimeoutMs?`    | `number`            | 单请求超时；`undefined` 无限等（一轮 turn 可以合法地跑很久）                                             | types.ts:46                       |
| `shutdownTimeoutMs?`   | `number`            | `close()` 内协议 shutdown 交换上限，默认 1000                                                            | types.ts:48                       |
| `disposeEofGraceMs?`   | `number`            | close 时 stdin-EOF 静默宽限，默认 6000                                                                   | types.ts:50                       |
| `disposeGraceMs?`      | `number`            | SIGTERM/SIGKILL 后确认窗口，默认 3000                                                                    | types.ts:52                       |
| `cwd?`                 | `string`            | 记录到每个 SDK 会话 header 的工作目录；默认进程 cwd                                                      | types.ts:58；api.ts:41            |
| `provider?`            | `string`            | SDK 会话的 provider 路由，默认 `deepseek-official`                                                       | types.ts:60；api.ts:42            |
| `model?`               | `string`            | SDK 会话的模型，默认 `deepseek-v4-flash`                                                                 | types.ts:62；api.ts:43            |
| `reasoningEffort?`     | `ReasoningEffortId` | adapter 拥有的推理档位标识（非空字符串），省略用模型默认                                                 | types.ts:64；server.ts:135-138    |
| `maxTokens?`           | `number`            | 每次会话模型请求的输出上限（正整数），被进程内后代继承                                                   | types.ts:66；server.ts:139-142    |

子进程 argv 的最终形状（`packages/sdk/client/src/launch.ts:128-157`，拼接在 `:143`）：

```
node <dshBin 或 解析出的入口> --profile <profile> [--patch <absPatch> ...]
```

- `dshBin` 缺省：`installedDshNodeLaunch()` 用 `import.meta.resolve('@deepseek-ai/dsh/package.json')` 找 CLI 包（launch.ts:72-77,115-120），要求与客户端版本一致（`:55-66`）；无构建产物则回退 tsx 源码模式（`:86-109`）。
- stdin/stdout/stderr 全部管道化，stdout 专用于 newline-delimited JSON-RPC（`client.ts:214-217`；sdk-app README「Stdout is reserved for newline-delimited JSON-RPC frames」）。

### 2.2 成员方法（`packages/sdk/client/src/api.ts`）

| 方法                      | 签名                                                                                     | 语义                                                                                                    | 出处                   |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `start()`                 | `(): Promise<void>`                                                                      | 懒启动子进程并 memoize `initialize` 握手；失败且清理成功则换新客户端重试，清理也失败抛 `AggregateError` | api.ts:69-95           |
| `session(id?)`            | `(sessionId?: string) => HarnessSession`                                                 | 开会话句柄（无线上流量，runtime 在首个 prompt 时建会话）；省略 id 则铸造 `session-<uuid>`               | api.ts:103-105         |
| `run(input, opts?)`       | `(input: string \| SdkPromptContentBlock[], options?: RunOptions) => Promise<RunResult>` | 一次性：订阅会话树 → 发 prompt → 从 inbox 回执收集到 agent idle                                         | api.ts:113-115,176-224 |
| `close()`                 | `(): Promise<void>`                                                                      | 关停并收割子进程；幂等且终态（关了不再重试握手）                                                        | api.ts:122-125         |
| `[Symbol.asyncDispose]()` | 同 `close()`                                                                             | `await using` 支持                                                                                      | api.ts:131-133         |
| `client`（getter）        | `(): HarnessClient`                                                                      | 暴露底层协议客户端                                                                                      | api.ts:55-57           |

`RunResult`（types.ts:70-79）：`{ sessionId, finalResponse, events, notifications }`；`finalResponse` 是区间内最后一条根会话 `assistant/message` 的文本拼接（api.ts:300-310），**不是**因果归因于该 prompt 的响应（steering/注入内容可能在 idle 前贡献）。

`RunOptions`（api.ts:152-157）：`{ sessionId?; onNotification?: (n: HarnessNotification) => void }`。

### 2.3 底层协议客户端 `HarnessClient`（`packages/sdk/client/src/client.ts:185`）

| 方法                                   | 签名                                                        | 语义                                                                                                | 出处                    |
| -------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------- |
| `start()`                              | `(): void`                                                  | spawn runtime 并开始读帧；进程存活期间幂等，`close()` 后拒绝复用                                    | client.ts:211-269       |
| `initialize(params)`                   | `(params: InitializeParams) => Promise<InitializeResult>`   | 进程级握手：cwd + provider/model 路由（+ 可选 effort/maxTokens）；校验 `serverInfo`                 | client.ts:276-283       |
| `prompt(sessionId, contentBlocks)`     | `=> Promise<string>`                                        | 排队一条 prompt，**立即**返回 durable 消息 id（`SessionPromptResult.messageId`），不等待 agent 活动 | client.ts:291-298       |
| `request(method, params?, timeoutMs?)` | `=> Promise<unknown>`                                       | 通用 JSON-RPC 请求（带超时放弃语义）                                                                | client.ts:309-342       |
| `subscribe(filter?)`                   | `(filter?: NotificationFilter) => NotificationSubscription` | 订阅全部服务器通知；`next()`/`tryNext()`/`close()`，可 async-iterate                                | client.ts:351-361,76-93 |
| `subscribeSessionTree(sessionId)`      | `(sessionId: string) => NotificationSubscription`           | 订阅一个会话及其由 `subagent.started` 血缘发现的后代（客户端侧过滤）                                | client.ts:370-381       |
| `close()`                              | `(): Promise<void>`                                         | 协议 `shutdown`（限时）→ stdin-EOF → SIGTERM → SIGKILL 阶梯；幂等                                   | client.ts:389-410       |

错误词汇（全从包根导出，`index.ts:14-19`）：`JsonRpcResponseError`（wire 错误响应，保留 code/data；re-export 自 protocol）、`RequestTimeoutError`（超时）、`SdkProtocolError`（协议外响应，如 prompt 响应无 `accepted`/`messageId`）、`TransportClosedError`（runtime 死亡，消息带退出码 + 最多 400 行 stderr 尾巴）（client.ts:39-66,29）。

---

## 3. 会话驱动 API（开 / 发 prompt / steer / 取消 / 事件订阅）

- **开**：`harness.session(sessionId)`（api.ts:103-105）→ 首次 `client.prompt(sessionId, blocks)` 时 runtime 懒创建 agent+session（server.ts:258-291，`SessionId(sessionId)` 在 `:279`）。
- **发 prompt / steer（同一个方法）**：`client.prompt(sessionId, contentBlocks)`（client.ts:291-298）。服务端实现是 `rec.handle.agent.followup(message)`（server.ts:190-191）；agent 正在跑时 `followup` 的消息进入 inbox，成为 steering/后续工作（`core/agent/src/runtime-types.ts:126-130` 的 `followup` 契约；inbox 落盘事件 `agent/inbox/spliced` 由 `core/agent/src/inbox.ts:186` append）。**dsh 侧 steer 与 followup 在 wire 上没有区别，都是再发一条 `session/prompt`**；进程内 API 才区分 `followup()`（下轮）与 `steer()`（最近 step 边界）（runtime-types.ts:130,139）。
- **取消**：**wire 上没有取消方法**。协议只有 3 个 client→server 方法（protocol/src/types.ts:115-119），README 明言「No mid-turn cancel — the wire has no prompt-cancel method; abandoning a turn means closing the runtime」（client/README.md:123；protocol/README.md:115）。进程内 `agent.cancel(cause, options?)`（runtime-types.ts:84-91，cause 见 `core/session/src/types.ts:143-148` 的 `user/parent/hook/disposed`）不可达。
- **事件订阅**：`subscribeSessionTree(sessionId)`（client.ts:370-381）或 `subscribe()`；高层 `run()` 的收集循环 = 等 `agent/inbox/spliced` 回执（api.ts:289-293）→ 收到 `session.status idle` 停（api.ts:199-212）。长期会话应自建泵循环（本驱动即如此，见 §6）。

`InitializeParams`（protocol/src/types.ts:16-27）：`{ cwd: string; provider: string; model: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }`。
`SessionPromptParams`（同文件 :36-41）：`{ sessionId: string; contentBlocks: SdkPromptContentBlock[] }`；`SdkPromptContentBlock = ContentBlock | { type:'image'; data: base64; mimeType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif' }`（:44-53）。
`SessionPromptResult`（:56-59）：`{ messageId: string }`。
serverInfo：`{ name: 'deepseek-harness-sdk-runtime', version: '0.0.1' }`（server.ts:167；版本 0.0.1 未被客户端校验，protocol/README.md:114）。

---

## 4. 线协议与通知类型总表

传输：newline-delimited JSON-RPC 2.0；`id+method`=请求、`id`=响应、`method`=通知；畸形行忽略（protocol/README.md:32；`JsonRpcLineTransport` 在 `protocol/src/transport.ts`）。

| 方向          | method              | 载荷                                                                                                                                   | 出处（types）                 | 出处（服务端实现）                                                               |
| ------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| client→server | `initialize`        | `InitializeParams → InitializeResult`                                                                                                  | protocol/src/types.ts:115-119 | server.ts:245-256（dispatch :247）                                               |
| client→server | `session/prompt`    | `SessionPromptParams → SessionPromptResult`                                                                                            | 同上                          | server.ts:175-192                                                                |
| client→server | `shutdown`          | `{}`                                                                                                                                   | 同上                          | server.ts:205-208                                                                |
| server→client | `session.event`     | `SessionEventNotification { sessionId, event: SessionEvent }`，**runtime 内每个会话、不过滤**                                          | types.ts:65-70,107-112        | server.ts:94-97                                                                  |
| server→client | `session.status`    | `{ sessionId, status: 'idle' \| 'running' }`（whole-agent）                                                                            | types.ts:73-78                | server.ts:98-100（源事件 `agent/status`，`core/agent/src/runtime-types.ts:185`） |
| server→client | `subagent.started`  | `{ parentSessionId, childSessionId }`                                                                                                  | types.ts:81-86                | server.ts:101-109                                                                |
| server→client | `subagent.finished` | `{ provider, agentId, parentSessionId, childSessionId, status: 'ok'\|'error', stopReason, lastAssistantMessage? }`（仅进程内运行上报） | types.ts:88-104               | server.ts:110-126                                                                |

`session.event` 的 `event` 是 dsh 会话日志事件信封 `{ type, seq, time(UNIX ms), data }`（`packages/core/session/src/types.ts:396-417`，`seq` :399、`time` :401）。核心事件词汇（`SessionEventMap`，同文件 :221-325；插件可扩展，全仓库已知类型清单见 `packages/core/session/src/known-event-types.ts:19-66`）：

| 事件 type                                                                            | data 形状                                                                                                                                                                                                          | 出处                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `turn/start`                                                                         | `{ turn }`                                                                                                                                                                                                         | core/session/src/types.ts:228                                                          |
| `turn/end`                                                                           | `{ turn, reason: TurnEndReason }`；reason.kind ∈ `completed` \| `aborted`(带 cause) \| `blocked` \| `error`(带 `LlmFailure`) \| `max-tokens` \| `interrupted`（插件可扩展）                                        | types.ts:237；TurnEndReasonMap :155-174                                                |
| `step/start` / `step/end`                                                            | `{ turn, step }`                                                                                                                                                                                                   | types.ts:239-241                                                                       |
| `user/message`                                                                       | 完整 `UserMessage { id, role:'user', content, source }`                                                                                                                                                            | types.ts:249；`llm/llm/src/message.ts:130-144`                                         |
| `assistant/chunk`                                                                    | `{ turn, step, chunk: StreamChunk }`；chunk.type ∈ `block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`                                                                     | types.ts:251；`llm/llm/src/types.ts:364-376`（`text-delta` :366）                      |
| `assistant/message`                                                                  | `{ turn, step, message: AssistantMessage, usage?, interrupted? }`                                                                                                                                                  | types.ts:262                                                                           |
| `tool/call`                                                                          | `{ turn, step, callId, name, arguments }`（arguments = 模型产出的**原始 JSON 字符串**，未解析）                                                                                                                    | types.ts:268                                                                           |
| `tool/result`                                                                        | `{ turn, step, message: ToolResultMessage, error?: {name,code}, meta? }`；`ToolResultMessage.content = [ToolResultBlock { type:'tool-result', toolCallId, content, isError? }]`；**source 只带 callId 不带工具名** | types.ts:280-286；`llm/llm/src/types.ts:88-93`；`llm/llm/src/message.ts:153-157,28-31` |
| `request/header` / `request/context`                                                 | 日志专用（请求头快照 / 路由元数据）                                                                                                                                                                                | types.ts:291-301                                                                       |
| `agent/inbox/spliced`                                                                | `{ target:'next-turn'\|'next-step', start, removedCount?, inserted: UserMessage[], outcome? }`                                                                                                                     | known-event-types.ts:20；`core/agent/src/inbox.ts:178-186`                             |
| `approval/asked`                                                                     | `{ id: ApprovalRequestId, toolName, callId?, reason? }`（审计事件，log-only）                                                                                                                                      | known-event-types.ts:21；`packages/interaction/user-approval/src/types.ts:44-49`       |
| `approval/decided`                                                                   | `{ id, outcome: 'allowed-once'\|'rejected'\|'cancelled'\|'unavailable' }`（审计事件）                                                                                                                              | known-event-types.ts:22；user-approval/src/types.ts:32,55-58                           |
| 其余扩展事件（`todo/write`、`compaction/*`、`permission/preset` 等；全清单共 51 项） | 见已知类型清单                                                                                                                                                                                                     | known-event-types.ts:19-66                                                             |

---

## 5. 权限请求的编程式应答机制

**结论：dsh v0.1.2-alpha.1 的 SDK 线协议没有权限请求的编程式应答通道。** 依据：

1. client→server 只有 `initialize` / `session/prompt` / `shutdown` 三个方法（protocol/src/types.ts:115-119；服务端 dispatch 表 server.ts:245-256，未知方法抛错 :254）。
2. client README 逐字：「Client→server notifications and server→client requests are unimplemented on both wire ends; the transport carries them for future approval flows.」（client/README.md:125）；协议 README：「Server→client requests are a dead capability — the transport supports them, but the server never sends one; the Python SDK's responder surface exists for future approval flows.」（protocol/README.md:116）。
3. dsh 的权限机制是**进程内**的：`ctx.approval.request()` 走 cordis `approval/request` waterfall，由组合的应答器回答（`packages/interaction/user-approval/src/types.ts:85-89`）；没有应答器或会话策略为 `never` 时 fail-closed（`unavailable` / 一律拒绝，`packages/interaction/user-approval/README.md`）。SDK 侧能看到的只有审计事件 `approval/asked` / `approval/decided`（log-only，随 `session.event` 透传，server.ts:94-97 不过滤）。

因此本驱动的取舍（均在 `src/drivers/dsh.ts` 注明）：

- `approval/asked` → **映射为 `permission_request` 事件**（requestId=`data.id`，tool=`data.toolName`，reason=`data.reason`）。
- `answerPermission(requestId, decision)` → **无法下发到引擎**：记录并打日志后 **reject**，错误信息说明该 SDK 版本无编程式应答通道（引用出处）；不会假装成功。
- 每会话对同一 `requestId` 去重，避免重复 `permission_request`。

---

## 6. 会话事件映射表（dsh → TechHaven `EngineEvent`）

`src/drivers/dsh.ts` 的泵循环：`harness.start()` → `client.subscribeSessionTree(sessionId)` → 循环 `subscription.next()`，逐条按下表映射；`send()` 即再次 `client.prompt()`。**仅映射根会话事件**：`subscribeSessionTree` 会放行后代（subagent）会话的 `session.event` / `session.status`（client.ts:370-381），驱动按 `params.sessionId === 本会话` 过滤，后代事件忽略（保守取舍，见未验证清单 #6）。出处列标注映射依据。

| dsh 侧                                                                                                            | 条件                                                                                         | TechHaven 事件                                                                                       | 出处                                                          |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `session.event` 信封                                                                                              | `params.sessionId === 本会话`                                                                | （进入分发）                                                                                         | protocol/src/types.ts:65-70                                   |
| `assistant/chunk`                                                                                                 | `data.chunk.type === 'text-delta'`                                                           | `assistant_chunk { text }`                                                                           | core/session/src/types.ts:251；llm/llm/src/types.ts:366       |
| `assistant/chunk`                                                                                                 | `reasoning-delta` / 其余 chunk                                                               | 忽略（无对应事件；TODO(unverified)）                                                                 | llm/llm/src/types.ts:364-376                                  |
| `tool/call`                                                                                                       | —                                                                                            | `tool_call { tool: data.name, argsDigest: sha256(data.arguments) 前 16 hex, args: 尝试 JSON.parse }` | core/session/src/types.ts:268                                 |
| `tool/result`                                                                                                     | 以 `data.message.content[0].toolCallId` 关联先前 `tool/call` 取工具名                        | `tool_result { tool, ok: !isError 且无 data.error, summary: 文本块拼接 }`                            | core/session/src/types.ts:280-286；llm/llm/src/types.ts:88-93 |
| `approval/asked`                                                                                                  | 同 requestId 只发一次                                                                        | `permission_request { requestId: data.id, tool: data.toolName, reason: data.reason }`                | user-approval/src/types.ts:44-49                              |
| `approval/decided`                                                                                                | —                                                                                            | 忽略（无对应事件；TODO(unverified)）                                                                 | user-approval/src/types.ts:55-58                              |
| `turn/end`                                                                                                        | reason.kind=`completed`/`max-tokens`                                                         | `status_change { status: 'succeeded', detail: kind }`                                                | core/session/src/types.ts:237,155-174                         |
| `turn/end`                                                                                                        | reason.kind=`aborted`                                                                        | `status_change { status: 'cancelled', detail: cause.kind }`                                          | 同上                                                          |
| `turn/end`                                                                                                        | reason.kind=`error`/`blocked`/`interrupted`                                                  | `status_change { status: 'failed', detail }`                                                         | 同上                                                          |
| `turn/end`                                                                                                        | 未知 kind（插件扩展）                                                                        | `status_change { status: 'failed', detail: '未识别的 turn 结束原因' }`（保守）                       | TurnEndReasonMap 为 merge-extensible（types.ts:153-154,177）  |
| `session.status`                                                                                                  | `status === 'running'` 且根会话                                                              | `status_change { status: 'running' }`                                                                | protocol/src/types.ts:73-78；server.ts:98-100                 |
| `session.status`                                                                                                  | `status === 'idle'`                                                                          | 忽略（turn/end 已给出本轮终态；会话级终态语义保守处理，见未验证清单 #5）                             | 同上                                                          |
| `subagent.finished`                                                                                               | `status === 'error'` 且 `parentSessionId === 本会话`                                         | `error { message: stopReason 摘要 }`                                                                 | protocol/src/types.ts:88-104；server.ts:110-126               |
| `subagent.finished`                                                                                               | `status === 'ok'`                                                                            | 忽略（子代理输出已随 `session.event` 可见）                                                          | 同上                                                          |
| `subagent.started`                                                                                                | —                                                                                            | 忽略（TODO(unverified)，无对应事件）                                                                 | protocol/src/types.ts:81-86                                   |
| `turn/start`、`step/*`、`user/message`、`request/header`、`request/context`、`agent/inbox/spliced` 及其他已知类型 | —                                                                                            | 忽略（无对应事件，映射表内注明）                                                                     | core/session/src/types.ts:228-324；known-event-types.ts:19-66 |
| 未知 `event.type` / 未知通知 method                                                                               | 不在已知词汇内                                                                               | `error { message: 透传原文 }`（保守透传）                                                            | 保守策略；已知清单 known-event-types.ts:19-66                 |
| SDK 异常                                                                                                          | `TransportClosedError` / `SdkProtocolError` / `RequestTimeoutError` / `JsonRpcResponseError` | `error { message }`                                                                                  | client.ts:39-66                                               |
| seq / ts                                                                                                          | —                                                                                            | seq 会话内自增（1 起）；ts 优先取 dsh `event.time`（UNIX ms）转 ISO，无则 `new Date().toISOString()` | core/session/src/types.ts:399-401                             |

**发送/取消对照**：`send(text)` → `client.prompt(sessionId, [{ type:'text', text }])`（client.ts:291-298；服务端 `agent.followup`，server.ts:190-191）；`cancel()` → **无 wire 方法，reject 并说明**（protocol/README.md:115；client/README.md:123）；`dispose()` → `harness.close()`（api.ts:122-125）。

---

## 7. 生命周期与清理（dispose 语义）

- **runtime 侧 `AgentHandle`**：`{ agent: Agent; dispose(): Promise<void> }`；`dispose()` 停循环、等退出、注销 agent、删会话存储、展开 scoped world（`packages/core/agent/src/index.ts:162-165` 及其上方文档注释）。SDK 服务在 `shutdown` 时对每个会话调用 `handle.dispose()`（server.ts:205-236，`rec.handle.dispose()` 在 :226）。
- **客户端侧 `DeepSeekHarness.close()` / `[Symbol.asyncDispose]()`**（api.ts:122-133）：幂等、终态；内部 `HarnessClient.close()` = 限时协议 `shutdown` → stdin-EOF（默认 6s 宽限）→ SIGTERM（默认 3s 确认）→ SIGKILL，**以进程实际退出为准**（client.ts:389-410；`disposeRuntimeProcess` 在 dispose.ts:82-99；Windows 无 POSIX 信号语义，SIGTERM 被跳过直接强杀，dispose.ts:92-96 注释）。stdin EOF 即 runtime 侧协作关停信号（sdk-app README：startup provider 把 stdin EOF 绑定到有界成功关停）。
- **本驱动分层幂等**：每个 TechHaven 会话独占一个 `DeepSeekHarness` 子进程；会话 `dispose()` 关闭自己的订阅与 runtime，driver `dispose()` 并行关闭全部仍存活的 runtime（全路径可重入，重复调用为 no-op）。这样 provider/model/env 等进程级配置不会跨用户会话复用。

---

## 8. 未验证清单（源码无法确认 / 未实跑）

1. **未做 live dsh 端到端验证**：本机未安装 dsh runtime、无 DeepSeek API key，驱动仅按 v0.1.2-alpha.1 源码实现并静态核对；真实子进程行为（stderr 噪声、启动时序、Windows 下 `dshBin` 指向 `.cmd` 等）未实测。
2. **npm 无 0.1.2-alpha.1**（截至 2026-08-29，最新为 0.1.1-rc.2）：0.1.1-rc.2 与 0.1.2-alpha.1 之间的事件/协议是否完全一致未逐行 diff；驱动按 0.1.2-alpha.1 源码实现，运行时对 SDK 缺字段做了中文报错的形状校验。
3. **权限编程式应答不可用**（§5）：`approval/asked` 是否真出现在 `sdk` profile 的 `session.event` 流中，取决于该 profile 的 approval 插件组合（base profile 拥有 policy/credentials，sdk-app README），**未验证** `sdk` profile 是否注册 approval 服务及其默认策略（`ask`/`never`）。
4. **取消不可用**（§3/§6）：放弃在途 turn 的唯一方式是关掉整个 runtime；对长会话这是硬限制。
5. **`session.status === 'idle'` 未映射**：dsh 的 status 是 whole-agent 状态而非 TechHaven 会话级状态，终态以根会话 `turn/end` 为准是**实现取舍**（映射表已注明），live 行为待验证。
6. **`subagent.started`/`approval/decided`/`assistant/message` 映射为忽略**：TechHaven 事件集没有对应项；若后续需要子代理进度或整条消息事件，需要扩展契约（TODO(unverified)）。
7. **`turn/end` 未知 kind 保守映射为 `failed`**：TurnEndReasonMap 是 merge-extensible 的，插件扩展 kind 在本映射下会被判为失败，属保守选择。
8. **per-session runtime 隔离尚未 live 压测**：profile 是 launch 参数（launch.ts:132-143），用户 provider/model/env 也是 initialize/runtime 级配置。当前驱动以“一会话一 runtime”隔离配置，避免跨用户密钥复用；并发进程成本、共享 `dshHome` 下的锁与资源上限尚未 live 验证。
9. **凭据传递**：未启用用户配置解析时，SDK 仍按原行为继承父环境（`env` 缺省时，types.ts:42）。启用后，Gateway 只把 allowlist 基础环境与该会话的 `OPENAI_*` / `ANTHROPIC_*` / `ZHIPUAI_*` 注入子进程；对应 dsh profile 必须显式把 provider route 绑定到这些变量，真实三类 provider 尚未 live 验证。
10. **`dshHome` 在 TS 侧可选**（types.ts:32，经 `DSH_HOME` 下发，launch.ts:148）；Python 侧强制要求非空（python/README.md:16）。TS + `@deepseek-ai/dsh` npm 包组合下省略 `dshHome` 是否可正常工作未验证。
11. **`installedDshBin()` 的 `import.meta.resolve('@deepseek-ai/dsh/package.json')`** 依赖消费方 node_modules 里存在该包；发布包 0.1.1-rc.2 的 registry 元数据未列出 `dependencies`（只有 peerDependencies），「装了 client 但没装 `@deepseek-ai/dsh`」时的行为（resolve 失败 → spawn 报错形态）未实测。
12. **会话持久化/续接**：SDK 会话可凭相同 `sessionId` 续接持久化历史（python/sdk/README.md「Reusing both a harness and session id continues the durable conversation」）；当前 Gateway 的运行态记录仍拒绝同 id 重复 `startSession`，且会话终态后关闭其独占 runtime，跨 Gateway 重启的 dsh 历史续接未实测。
