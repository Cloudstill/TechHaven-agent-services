/**
 * dsh（DeepSeek Harness）引擎驱动 —— 经官方 TypeScript SDK（@deepseek-ai/dsh-sdk-client）
 * 以子进程方式驱动真实引擎（stdio JSON-RPC）。
 *
 * 驱动状态：按 dsh v0.1.2-alpha.1 源码实现（GitHub deepseek-ai/deepseek-harness，
 * tag dsh-v0.1.2-alpha.1），**未经 live dsh 端到端验证**。
 * 每个映射分支的 API 出处（文件:行）见注释与 docs/DSH_SDK.md §6 映射表。
 *
 * 验证前置（满足后才能真正跑通）：
 *  1. 安装 dsh 官方 SDK 与同版本 runtime：
 *     `npm i @deepseek-ai/dsh-sdk-client@0.1.1-rc.2 @deepseek-ai/dsh@0.1.1-rc.2`
 *     （SDK 启动时强制 client 与 dsh 同版本，launch.ts:55-66；0.1.2-alpha.1 需从源码构建）；
 *  2. TECHHAVEN_DSH_BIN 指向 dsh 可执行入口（缺省则要求 node_modules 内存在同版本 @deepseek-ai/dsh 包）；
 *  3. LLM API key 可沿用 Gateway 进程环境，或由服务端用户配置解析器通过
 *     EngineRuntimeConfig 注入会话独占的 dsh 子进程（不共享用户凭据）。
 *
 * 本驱动不写入 package.json：SDK 通过动态 import 加载，包缺失 / 导出面不符时抛出
 * 带中文说明的 Error。驱动选择权在启动配置（TECHHAVEN_ENGINE_DRIVER，默认 mock），
 * dsh 失败只影响显式选择者。
 *
 * 已知硬限制（源码结论，非本驱动缺陷）：
 *  - dsh 线协议没有取消方法：cancel() 无法实现（protocol/README.md:115；client/README.md:123）；
 *  - dsh 线协议没有权限应答方法：answerPermission() 无法下发（protocol/src/types.ts:115-119；
 *    protocol/README.md:116；client/README.md:125）。
 *  两者均如实抛错，不做假成功；详见 docs/DSH_SDK.md §5、§8。
 */

import { EventChannel } from "../channel.js";
import { errorMessage, isRecord, nowIso, sha256Hex16 } from "../util.js";
import type { EngineDriver, EngineEvent, EngineRuntimeConfig, EngineSessionHandle } from "../types.js";
import { log } from "../log.js";

/**
 * dsh SDK npm 包名（逐字取自 packages/sdk/client/package.json:2）。
 * 标注 `: string` 刻意放宽字面量类型：避免 TypeScript 在编译期静态解析
 * （本服务不把该包写进 package.json，缺失属预期，缺失时报错在运行时给出）。
 */
const DSH_SDK_SPECIFIER: string = "@deepseek-ai/dsh-sdk-client";

/** dsh 会话日志「已知事件类型」全集（逐字照抄 packages/core/session/src/known-event-types.ts:19-66），
 *  用于区分「已知但无对应事件、忽略」与「未知类型、保守透传为 error 事件」。 */
const KNOWN_DSH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/chunk",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
]);

// ---------------------------------------------------------------------------
// dsh SDK 的结构最小类型：只声明本驱动消费的面（真实形状见 docs/DSH_SDK.md §2/§3）。
// 运行时逐项校验，形状不符即抛中文错误，避免版本漂移导致难查的 TypeError。
// ---------------------------------------------------------------------------

/** 一条 server→client 通知（types.ts:13-18：{ method, params }）。 */
export interface DshHarnessNotification {
  method: string;
  params: Record<string, unknown>;
}

/** 通知订阅（client.ts:76-93；本驱动只消费 next/close）。 */
export interface DshNotificationSubscription {
  next(): Promise<DshHarnessNotification>;
  close(): void;
}

/** 底层协议客户端（client.ts:185；本驱动只消费 prompt 与 subscribeSessionTree）。 */
export interface DshRuntimeClient {
  /** client.ts:291-298：排队一条 prompt，立即返回 durable 消息 id。 */
  prompt(sessionId: string, contentBlocks: unknown[]): Promise<string>;
  /** client.ts:370-381：订阅一个会话及其 subagent 血缘后代。 */
  subscribeSessionTree(sessionId: string): DshNotificationSubscription;
}

/** 高层 API（api.ts:22 class DeepSeekHarness）。 */
export interface DshHarness {
  /** api.ts:69-95：懒启动子进程并 memoize initialize 握手。 */
  start(): Promise<void>;
  /** api.ts:55-57：底层客户端 getter。 */
  readonly client: DshRuntimeClient;
  /** api.ts:122-133：幂等终态关停（shutdown → EOF → SIGTERM → SIGKILL）。 */
  close(): Promise<void>;
}

export interface DshSdkModule {
  DeepSeekHarness: new (options: Record<string, unknown>) => DshHarness;
}

type UnknownRecord = Record<string, unknown>;

/** 动态加载 dsh SDK 并校验导出面；缺失 / 不符时抛带中文说明的 Error。 */
async function loadDshSdk(): Promise<DshSdkModule> {
  let imported: unknown;
  try {
    imported = await import(DSH_SDK_SPECIFIER);
  } catch (cause) {
    throw new Error(
      `无法加载 dsh 官方 SDK（${DSH_SDK_SPECIFIER}）：${errorMessage(cause)}。` +
        `安装方式：npm i ${DSH_SDK_SPECIFIER}@0.1.1-rc.2 @deepseek-ai/dsh@0.1.1-rc.2` +
        `（两个包必须同版本，SDK 启动时强制校验；0.1.2-alpha.1 未发布到 npm，需从源码 tag dsh-v0.1.2-alpha.1 构建）。` +
        `驱动选择权在启动配置：TECHHAVEN_ENGINE_DRIVER 默认为 mock，仅显式选择 dsh 的部署受影响。`,
    );
  }
  if (!isRecord(imported) || typeof imported.DeepSeekHarness !== "function") {
    throw new Error(
      `dsh SDK（${DSH_SDK_SPECIFIER}）已安装但导出面不符：缺少 DeepSeekHarness 构造器。` +
        `本驱动按 dsh v0.1.2-alpha.1 源码实现（导出面清单见 docs/DSH_SDK.md §1），` +
        `请确认安装版本 ≥ 0.1.1-rc.2 且未被构建工具裁剪导出。`,
    );
  }
  return imported as unknown as DshSdkModule;
}

/** 校验 DeepSeekHarness 实例的关键成员，防止版本漂移。 */
function assertHarnessShape(candidate: unknown): DshHarness {
  if (!isRecord(candidate)) {
    throw new Error("dsh SDK 的 DeepSeekHarness 实例形状不符：不是对象");
  }
  const client: unknown = candidate.client;
  if (
    typeof candidate.start !== "function" ||
    typeof candidate.close !== "function" ||
    !isRecord(client) ||
    typeof client.prompt !== "function" ||
    typeof client.subscribeSessionTree !== "function"
  ) {
    throw new Error(
      "dsh SDK 实例缺少预期成员（start/close/client/client.prompt/client.subscribeSessionTree）。" +
        "安装的 @deepseek-ai/dsh-sdk-client 版本与本驱动依据的 v0.1.2-alpha.1 源码不符，" +
        "版本对照见 docs/DSH_SDK.md §1/§2。",
    );
  }
  return candidate as unknown as DshHarness;
}

/**
 * EngineEvent 去掉 seq/ts 的载荷：由 ../types.ts 派生（不再手抄 union）——
 * 契约一改这里立即编译报错，emit() 统一补齐 seq/ts。
 */
type EngineEventBody = { [T in EngineEvent as T["type"]]: Omit<T, "seq" | "ts"> }[EngineEvent["type"]];

interface DshSessionState {
  recordUsage?: EngineRuntimeConfig["recordUsage"];
  sessionId: string;
  harness: DshHarness;
  subscription: DshNotificationSubscription;
  /** 事件通道：组合共享 EventChannel（回放模式；语义见 src/channel.ts） */
  channel: EventChannel<EngineEvent>;
  seq: number;
  disposed: boolean;
  closePromise?: Promise<void>;
  /** tool/call 的 callId → 工具名：tool_result 侧没有工具名，只能按 callId 关联（llm/llm/src/message.ts:28-31）。 */
  toolNames: Map<string, string>;
  /** 已发过 permission_request 的 approval id（去重）。 */
  permissionSeen: Set<string>;
}

export interface DshSdkDriverOptions {
  /** dsh 可执行入口（TECHHAVEN_DSH_BIN）；缺省由 SDK 解析同版本 @deepseek-ai/dsh 包（launch.ts:133-135）。 */
  dshBin?: string;
  /** dsh profile 名（TECHHAVEN_DSH_PROFILE）；缺省 "sdk"（types.ts:28；launch.ts:132）。 */
  profile?: string;
  /** dsh 主目录（TECHHAVEN_DSH_HOME）；经 DSH_HOME 下发（types.ts:32；launch.ts:140,148）。 */
  dshHome?: string;
  /** 单测注入点；生产缺省动态加载官方 SDK。 */
  sdkLoader?: () => Promise<DshSdkModule>;
}

const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "SHELL",
] as const;

/**
 * 给含用户凭据的 runtime 构造最小环境，避免把 Gateway 其他 ambient secrets 一并继承。
 *
 * 层次（后者覆盖前者）：
 *   1. SAFE_CHILD_ENV_KEYS：操作系统/运行时必需项；
 *   2. runtimeConfig.env：模型供应商凭据（用户配置或进程级凭据）；
 *   3. runtimeConfig.mcpEnv：会话级 MCP 启动上下文（sid / 已授权 org / 专用 MCP 凭据）。
 *
 * 第 3 层是必需的：显式 env 会整体替换父环境（docs/DSH_SDK.md），而随附的
 * dsh MCP 配置从 process.env 读 TECHHAVEN_AGENT_TOKEN / TECHHAVEN_TOKEN_SECRET。
 * 少了它，「启用用户模型配置 + 随附 profile」这条组合路径必然在 MCP 初始化处失败
 * （审查意见 F6）。这里仍然只放行白名单与显式下发的键，不恢复父环境。
 */
function isolatedRuntimeEnv(runtimeConfig: EngineRuntimeConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(runtimeConfig.env)) env[key] = value;
  for (const [key, value] of Object.entries(runtimeConfig.mcpEnv ?? {})) env[key] = value;
  return env;
}

export class DshSdkDriver implements EngineDriver {
  readonly name: string = "dsh";

  private readonly dshBin: string | undefined;
  private readonly profile: string | undefined;
  private readonly dshHome: string | undefined;
  private readonly sdkLoader: () => Promise<DshSdkModule>;
  private sdkPromise: Promise<DshSdkModule> | undefined;
  private readonly sessions = new Map<string, DshSessionState>();
  private disposed = false;

  constructor(options: DshSdkDriverOptions = {}) {
    this.dshBin = options.dshBin?.trim() || undefined;
    this.profile = options.profile?.trim() || undefined;
    this.dshHome = options.dshHome?.trim() || undefined;
    this.sdkLoader = options.sdkLoader ?? loadDshSdk;
  }

  async startSession(opts: {
    sessionId: string;
    orgId: number;
    prompt: string;
    profile?: string;
    runtimeConfig?: EngineRuntimeConfig;
  }): Promise<EngineSessionHandle> {
    if (this.disposed) throw new Error("dsh 驱动已销毁，无法开启新会话");
    if (typeof opts.sessionId !== "string" || opts.sessionId.trim() === "") {
      throw new Error("startSession 需要非空 sessionId");
    }
    if (typeof opts.prompt !== "string" || opts.prompt.trim() === "") {
      throw new Error(`startSession 需要非空 prompt（sessionId=${opts.sessionId}）`);
    }
    if (this.sessions.has(opts.sessionId)) {
      throw new Error(`dsh 会话 id 重复：${opts.sessionId}（dsh 侧同 id 会续接持久化历史，本驱动拒绝同进程内复用）`);
    }
    // orgId：dsh 无组织概念，仅契约透传；配额/审计由 Gateway 层完成。

    const sdk = await (this.sdkPromise ??= this.sdkLoader());
    // dsh 的 provider/model/env 是 initialize/runtime 级配置。每个 TechHaven 会话独占一个
    // runtime，避免不同用户的 API key 或 endpoint 在同一子进程中交叉复用。
    const harness = this.createHarness(sdk, opts.profile, opts.runtimeConfig);
    const requestedProfile = this.profile ?? opts.profile ?? "sdk";

    try {
      // 失败的握手会被 SDK 自愈（清理后换新客户端重试，api.ts:60-95），此处直接透传错误。
      await harness.start();
    } catch (cause) {
      await harness.close().catch(() => undefined);
      throw new Error(
        `dsh runtime 启动 / initialize 握手失败（profile=${requestedProfile}）：${errorMessage(cause)}。` +
          `请检查 dsh 是否安装（TECHHAVEN_DSH_BIN / node_modules 内同版本 @deepseek-ai/dsh）与 LLM API key。`,
      );
    }

    // 先订阅后发 prompt，避免漏事件（对照高层 run() 的顺序，api.ts:183-199）。
    const subscription = harness.client.subscribeSessionTree(opts.sessionId); // client.ts:370-381
    const state: DshSessionState = {
      recordUsage: opts.runtimeConfig?.recordUsage,
      sessionId: opts.sessionId,
      harness,
      subscription,
      channel: new EventChannel<EngineEvent>(),
      seq: 0,
      disposed: false,
      toolNames: new Map<string, string>(),
      permissionSeen: new Set<string>(),
    };
    this.sessions.set(opts.sessionId, state);
    void this.pump(state);

    try {
      // session/prompt（client.ts:291-298）：立即返回入队回执，不等 agent 活动。
      // 服务端实现是 agent.followup（server.ts:190-191）；runtime 在首个 prompt 时懒建会话（server.ts:258-291）。
      await harness.client.prompt(opts.sessionId, [{ type: "text", text: opts.prompt }]);
    } catch (cause) {
      await this.teardownSession(state);
      throw new Error(`dsh 会话 ${opts.sessionId} 的首次 prompt 入队失败：${errorMessage(cause)}`);
    }

    return {
      // 每次调用先回放历史，再接实时（可重复回放）
      events: () => state.channel.iterate({ replay: true }),
      send: async (text: string): Promise<void> => {
        if (state.disposed) throw new Error(`dsh 会话 ${state.sessionId} 已结束，无法继续发送`);
        if (typeof text !== "string" || text.trim() === "") throw new Error("send 需要非空文本");
        // send = 复用 session/prompt：agent 空闲时开新轮（followup），运行中则排队为
        // steering / 后续工作（runtime-types.ts:126-130；落盘事件 agent/inbox/spliced，inbox.ts:186）。
        await harness.client.prompt(state.sessionId, [{ type: "text", text }]);
      },
      answerPermission: async (requestId: string, decision: "approve" | "reject", note?: string): Promise<void> => {
        if (state.disposed) throw new Error(`dsh 会话 ${state.sessionId} 已结束，无法应答权限请求`);
        // dsh v0.1.2-alpha.1 的线协议没有权限应答方法：client→server 仅
        // initialize / session/prompt / shutdown（protocol/src/types.ts:115-119；server.ts:245-256），
        // server→client 请求是「dead capability」（protocol/README.md:116；client/README.md:125）。
        // 应答器只能在 dsh 进程内组合（user-approval/src/types.ts:85-89 的 approval/request waterfall）。
        log(`权限应答无法下发到引擎（SDK 无此通道）：requestId=${requestId} decision=${decision}${note ? ` note=${note}` : ""}`);
        throw new Error(
          `无法将权限决议「${decision}」下发到 dsh 引擎：SDK 线协议没有编程式应答方法` +
            `（出处见 docs/DSH_SDK.md §5）。请在 dsh profile 内配置 approval 策略` +
            `（如 policy: never，user-approval/README.md）或进程内应答器。`,
        );
      },
      cancel: async (): Promise<void> => {
        if (state.disposed) return; // 幂等：已结束的会话无需取消
        // dsh 线协议没有取消方法（protocol/README.md:115「No cancel or session-close methods」；
        // client/README.md:123「No mid-turn cancel」）。进程内 agent.cancel（runtime-types.ts:84-91）不可达。
        throw new Error(
          `dsh 会话 ${state.sessionId} 无法按需取消：SDK 线协议没有 cancel 方法` +
            `（docs/DSH_SDK.md §8#4）；如需立即停止，请调用驱动级 dispose() 关闭整个 runtime。`,
        );
      },
      dispose: async (): Promise<void> => {
        await this.teardownSession(state); // 幂等（内部有 disposed 检查）
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return; // 幂等
    this.disposed = true;
    await Promise.all([...this.sessions.values()].map((state) => this.teardownSession(state)));
  }

  // -------------------------------------------------------------------------

  private createHarness(
    sdk: DshSdkModule,
    sessionProfile: string | undefined,
    runtimeConfig: EngineRuntimeConfig | undefined,
  ): DshHarness {
    const profile = this.profile ?? sessionProfile ?? "sdk";
    const options: UnknownRecord = {
      profile,
      // dshBin 缺省时 SDK 解析同版本 @deepseek-ai/dsh 包（launch.ts:72-77,133-135）。
      ...(this.dshBin === undefined ? {} : { dshBin: this.dshBin }),
      // dshHome 经 DSH_HOME 环境变量下发（launch.ts:140,148）。
      ...(this.dshHome === undefined ? {} : { dshHome: this.dshHome }),
      ...(runtimeConfig === undefined
        ? {}
        : {
            provider: runtimeConfig.provider,
            model: runtimeConfig.model,
            ...(runtimeConfig.reasoningEffort === undefined ? {} : { reasoningEffort: runtimeConfig.reasoningEffort }),
            ...(runtimeConfig.maxTokens === undefined ? {} : { maxTokens: runtimeConfig.maxTokens }),
            env: isolatedRuntimeEnv(runtimeConfig),
          }),
    };
    return assertHarnessShape(new sdk.DeepSeekHarness(options));
  }

  /** 持续消费会话树通知并映射为 EngineEvent；结束（dispose/transport 关闭）时收尾。 */
  private async pump(state: DshSessionState): Promise<void> {
    try {
      for (;;) {
        if (state.disposed) break;
        // runtime 死亡或订阅关闭后 next() reject（client.ts:76-93,128-131,255-258）。
        const notification = await state.subscription.next();
        await this.accountNotification(state, notification);
        this.mapNotification(state, notification);
      }
    } catch (cause) {
      if (!state.disposed) {
        // SDK 异常（TransportClosedError / RequestTimeoutError / SdkProtocolError /
        // JsonRpcResponseError，client.ts:39-66）→ error 事件（docs/DSH_SDK.md §6）。
        this.emit(state, nowIso(), {
          type: "error",
          message: `dsh 事件流中断：${errorMessage(cause)}`,
        });
      }
    } finally {
      await this.teardownSession(state);
    }
  }

  private async teardownSession(state: DshSessionState): Promise<void> {
    if (state.closePromise) return state.closePromise;
    state.disposed = true;
    // 订阅 close：丢弃队列、拒绝 pending waiter（client.ts:128-131）。
    state.subscription.close();
    state.channel.close(); // 迭代器回放完历史后正常结束
    this.sessions.delete(state.sessionId);
    state.closePromise = state.harness.close().catch((cause) => {
      log(`dsh runtime 关停异常（sessionId=${state.sessionId}，已忽略）：${errorMessage(cause)}`);
    });
    return state.closePromise;
  }

  private async accountNotification(state: DshSessionState, notification: DshHarnessNotification): Promise<void> {
    if (!state.recordUsage || notification.method !== "session.event") return;
    const event = notification.params.event;
    if (!isRecord(event) || !isRecord(event.data)) return;
    const data = event.data;
    // Include descendants in billing; their transcript is intentionally not forwarded to the root UI.
    const sourceSid = notification.params.sessionId;
    if (typeof sourceSid !== "string" || !Number.isInteger(data.turn) || !Number.isInteger(data.step)) return;
    const key = `${sourceSid}:${data.turn}:${data.step}`;
    if (event.type === "step/start" || event.type === "assistant/message") {
      await state.recordUsage(state.sessionId, `request:${key}`, { requests: 1 });
    }
    // assistant/message carries final usage for the call. Ignore assistant/chunk usage
    // snapshots to avoid adding cumulative streaming totals multiple times.
    if (event.type !== "assistant/message" || !isRecord(data.usage)) return;
    const usage = data.usage;
    const count = (name: string): number => {
      const value = usage[name] ?? 0;
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid dsh usage: ${name}`);
      return value as number;
    };
    // dsh TokenUsage counts uncached input and cache read/write separately.
    const promptTokens = count("inputTokens") + count("cacheReadTokens") + count("cacheWriteTokens");
    const completionTokens = count("outputTokens");
    await state.recordUsage(state.sessionId, `tokens:${key}`, {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
  }

  private emit(state: DshSessionState, ts: string, body: EngineEventBody): void {
    state.seq += 1;
    // EngineEventBody 由 ../types.ts 派生（见上），补齐 seq/ts 后即收窄为对应事件分支，无需断言
    state.channel.push({ ...body, seq: state.seq, ts });
  }

  // -------------------------------------------------------------------------
  // dsh 通知 → EngineEvent 映射（逐条出处见 docs/DSH_SDK.md §6 映射表）
  // -------------------------------------------------------------------------

  private mapNotification(state: DshSessionState, notification: DshHarnessNotification): void {
    const params = notification.params;
    switch (notification.method) {
      case "session.event": {
        // { sessionId, event: SessionEvent }（protocol/src/types.ts:65-70；server.ts:94-97）
        if (params.sessionId !== state.sessionId) {
          // 后代会话（subagent）事件不映射到本会话流（保守取舍，docs/DSH_SDK.md §8#6）。
          return;
        }
        const event: unknown = params.event;
        if (!isRecord(event) || typeof event.type !== "string") {
          this.emit(state, nowIso(), {
            type: "error",
            message: `session.event 载荷缺少 event 信封：${JSON.stringify(params)}`,
          });
          return;
        }
        // 事件自带时间戳 time（UNIX 毫秒，core/session/src/types.ts:401）。
        const ts = typeof event.time === "number" ? new Date(event.time).toISOString() : nowIso();
        const data = isRecord(event.data) ? event.data : {};
        switch (event.type) {
          case "assistant/chunk": {
            // data = { turn, step, chunk: StreamChunk }（core/session/src/types.ts:251）
            const chunk = isRecord(data.chunk) ? data.chunk : undefined;
            if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
              // text-delta → assistant_chunk（StreamChunk 定义：llm/llm/src/types.ts:366）
              this.emit(state, ts, { type: "assistant_chunk", text: chunk.text });
            }
            // reasoning-delta 等其余 chunk 类型（llm/llm/src/types.ts:365-376）无对应事件，忽略。
            // TODO(unverified): 若需要思维链透传，需扩展契约。
            return;
          }
          case "tool/call": {
            // data = { turn, step, callId, name, arguments }，arguments 为模型产出的原始 JSON 字符串
            // （core/session/src/types.ts:268）
            const callId = typeof data.callId === "string" ? data.callId : "";
            const tool = typeof data.name === "string" && data.name !== "" ? data.name : "unknown";
            if (callId !== "") state.toolNames.set(callId, tool);
            const argsJson = typeof data.arguments === "string" ? data.arguments : "";
            let args: unknown;
            try {
              args = argsJson === "" ? undefined : JSON.parse(argsJson);
            } catch {
              args = undefined; // arguments 本是模型自由产出，解析失败就不携带 args
            }
            this.emit(state, ts, {
              type: "tool_call",
              tool,
              // argsDigest 统一走 util.sha256Hex16（对入参本身取摘要；undefined 归一为 null，与 mcp audit 约定一致）
              argsDigest: sha256Hex16(args),
              ...(args === undefined ? {} : { args }),
            });
            return;
          }
          case "tool/result": {
            // data = { turn, step, message: ToolResultMessage, error?, meta? }
            // （core/session/src/types.ts:280-286）；ToolResultBlock = { type:'tool-result',
            // toolCallId, content, isError? }（llm/llm/src/types.ts:88-93）。
            const message = isRecord(data.message) ? data.message : undefined;
            const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
            const block = content.find(isRecord);
            const callId = block !== undefined && typeof block.toolCallId === "string" ? block.toolCallId : "";
            const tool = state.toolNames.get(callId) ?? "unknown";
            const ok = !(block !== undefined && block.isError === true) && !isRecord(data.error);
            const summary = this.summarizeToolResult(block);
            this.emit(state, ts, {
              type: "tool_result",
              tool,
              ok,
              ...(summary === "" ? {} : { summary }),
            });
            return;
          }
          case "approval/asked": {
            // 审计事件 { id, toolName, callId?, reason? }（user-approval/src/types.ts:44-49）→ permission_request。
            // 注意：SDK 线协议无编程式应答（docs/DSH_SDK.md §5），answerPermission 只能如实拒绝。
            const requestId = typeof data.id === "string" ? data.id : JSON.stringify(data.id ?? null);
            if (state.permissionSeen.has(requestId)) return;
            state.permissionSeen.add(requestId);
            this.emit(state, ts, {
              type: "permission_request",
              requestId,
              tool: typeof data.toolName === "string" && data.toolName !== "" ? data.toolName : "unknown",
              ...(typeof data.reason === "string" && data.reason !== "" ? { reason: data.reason } : {}),
            });
            return;
          }
          case "approval/decided": {
            // 审计事件 { id, outcome }（user-approval/src/types.ts:55-58）：契约无对应事件，忽略。
            // TODO(unverified): 若需要权限决议回执，需扩展契约（permission_resolved 一类）。
            return;
          }
          case "turn/end": {
            // { turn, reason: TurnEndReason }（core/session/src/types.ts:237）；
            // reason.kind ∈ TurnEndReasonMap（:155-174，merge-extensible :153-154,177）。
            const reason = isRecord(data.reason) ? data.reason : undefined;
            const kind = reason !== undefined && typeof reason.kind === "string" ? reason.kind : "";
            switch (kind) {
              case "completed":
                this.emit(state, ts, { type: "status_change", status: "succeeded", detail: "completed" });
                return;
              case "max-tokens":
                this.emit(state, ts, { type: "status_change", status: "succeeded", detail: "max-tokens" });
                return;
              case "aborted": {
                // aborted 带嵌套原因 { kind: 'user'|'parent'|'hook'|'disposed' }（core/session/src/types.ts:143-148）
                const nested = reason !== undefined && isRecord(reason.reason) ? reason.reason : undefined;
                const causeKind = nested !== undefined && typeof nested.kind === "string" ? nested.kind : "unknown";
                this.emit(state, ts, { type: "status_change", status: "cancelled", detail: causeKind });
                return;
              }
              case "error": {
                // reason.error 为结构化 LlmFailure（core/session/src/types.ts:161-166）
                const failure = reason !== undefined && isRecord(reason.error) ? reason.error : undefined;
                const detail = failure !== undefined && typeof failure.message === "string" ? failure.message : "error";
                this.emit(state, ts, { type: "status_change", status: "failed", detail });
                return;
              }
              case "blocked":
              case "interrupted":
                this.emit(state, ts, { type: "status_change", status: "failed", detail: kind });
                return;
              default:
                // 未知 kind（插件可扩展 TurnEndReasonMap）：保守判为 failed 并注明。
                this.emit(state, ts, {
                  type: "status_change",
                  status: "failed",
                  detail: `未识别的 turn 结束原因：${kind === "" ? "(缺失)" : kind}`,
                });
                return;
            }
          }
          case "turn/start":
          case "step/start":
          case "step/end":
          case "user/message":
          case "request/header":
          case "request/context":
          case "agent/inbox/spliced":
            // 无对应 EngineEvent（出处：core/session/src/types.ts:228-324；agent/inbox/spliced 为
            // inbox 落盘事件，core/agent/src/inbox.ts:186）。持续流式会话不需要这些边界标记。
            return;
          default:
            if (KNOWN_DSH_EVENT_TYPES.has(event.type)) {
              // 其余已知类型（todo/write、compaction/* 等）：清单 known-event-types.ts:19-66，忽略。
              return;
            }
            // 未知事件类型：保守透传为 error 事件（docs/DSH_SDK.md §6）。
            this.emit(state, ts, {
              type: "error",
              message: `收到未识别的 dsh 会话事件类型「${event.type}」：${JSON.stringify(data)}`,
            });
            return;
        }
      }
      case "session.status": {
        // { sessionId, status: 'idle' | 'running' }（protocol/src/types.ts:73-78）；
        // 源事件为 agent/status（server.ts:98-100；core/agent/src/runtime-types.ts:185）。
        if (params.sessionId !== state.sessionId) return;
        if (params.status === "running") {
          this.emit(state, nowIso(), { type: "status_change", status: "running" });
        }
        // idle 忽略：TechHaven 终态以根会话 turn/end 为准（保守取舍，docs/DSH_SDK.md §8#5）。
        return;
      }
      case "subagent.finished": {
        // { provider, agentId, parentSessionId, childSessionId, status: 'ok'|'error', stopReason }
        // （protocol/src/types.ts:88-104；server.ts:110-126，仅进程内子代理上报）。
        if (params.parentSessionId !== state.sessionId) return;
        if (params.status === "error") {
          this.emit(state, nowIso(), {
            type: "error",
            message: `dsh 子代理运行失败（provider=${String(params.provider ?? "?")}，stopReason=${JSON.stringify(params.stopReason ?? null)}）`,
          });
        }
        // status === 'ok' 忽略：子代理输出已随 session.event 流可见。
        return;
      }
      case "subagent.started": {
        // { parentSessionId, childSessionId }（protocol/src/types.ts:81-86；server.ts:101-109）。
        // TODO(unverified): 契约无对应事件，忽略；若需子代理进度需扩展契约。
        return;
      }
      default:
        // 未知通知方法：保守透传为 error 事件。
        this.emit(state, nowIso(), {
          type: "error",
          message: `收到未识别的 dsh 通知方法「${notification.method}」：${JSON.stringify(params)}`,
        });
        return;
    }
  }

  /** 从 ToolResultBlock.content 提取文本块拼接摘要（超长截断为本地展示策略，非 dsh 语义）。 */
  private summarizeToolResult(block: UnknownRecord | undefined): string {
    if (block === undefined || !Array.isArray(block.content)) return "";
    const parts: string[] = [];
    for (const entry of block.content) {
      if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string" && entry.text !== "") {
        parts.push(entry.text);
      }
    }
    const joined = parts.join("\n");
    const LIMIT = 500;
    return joined.length > LIMIT ? `${joined.slice(0, LIMIT)}…` : joined;
  }
}
