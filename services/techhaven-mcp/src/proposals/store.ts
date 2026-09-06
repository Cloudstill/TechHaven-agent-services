import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TicketKind } from "../domain/types.js";
import { log } from "../log.js";

/**
 * 写提案事件存储（staged 写模式，TH-RFC-001 §07「事前守护」）。
 *
 * 设计依据：docs/agent-db 的 agent_write_proposals 表（写操作一律「提案暂存 → 人批 → 应用」，
 * 未批准不落库 = 天然可回滚）。JSONL append-only 事件流是权威存储，原因：
 *   1. mock 域状态在 server 进程内存里，变更必须由 server 进程自己应用，与人工 CLI 之间只能靠文件交接；
 *   2. 审批 CLI（proposalCli.ts）与 server 不共享内存，靠同一份文件交接最简单可靠。
 * P2 起可选 DB 镜像：构造时传入 db sink（见 dbSink.ts → agent_write_proposals 表，
 * proposal_ref 映射提案字符串 ID），JSONL 落盘成功后 fire-and-forget 同步，DB 失败只记 stderr。
 * 字段与本文件 ProposalDetail 一一对应。
 *
 * 并发说明：PoC 为单进程 server + 人工 CLI 偶发竞争，可接受——每次读写都重读整个文件
 * 折叠事件，不做文件锁。竞争最坏情况是同一提案收到重复批注事件；折叠采用「状态单调推进」
 * 规则（见 STATUS_RANK），重复事件不会回退状态，结果仍一致。
 */

/** 提案状态：pending → approved → applying → applied；或 pending → rejected / expired（未决过期 = 默认拒绝） */
/** 提案状态单源：techhaven-contracts（控制面共享契约，见根 contracts/README.md） */
import type { ProposalStatus } from "techhaven-contracts";
export type { ProposalStatus };

/** 单条提案的当前全量快照（created 事件携带，后续事件只改状态不改内容） */
export interface ProposalDetail {
  id: string;
  /** 发起写操作的 agent 会话 ID（对应 agent_write_proposals.session_id） */
  sessionId: string;
  /** 组织 ID（对应 org_id） */
  orgId: number;
  /** 发起工具名（对应 tool_name） */
  tool: string;
  kind: TicketKind;
  /** 工单 hashId（出参/展示用，防枚举；对应 subject_type + 对外编码） */
  subjectHashId: string;
  /** 工单数字 ID（应用变更时内部使用，不外发） */
  subjectId: number;
  /** 发起时的工单状态（对应 change.before） */
  fromStatus: string;
  /** 目标状态（对应 change.after） */
  toStatus: string;
  /** 变更原因（对应 change.reason） */
  reason: string;
  /** 未决过期时间（ISO；对应 expires_at，未决过期 = 默认拒绝，安全侧倾斜） */
  expiresAt: string;
}

export type ProposalEventType = ProposalEvent["event"];

export interface ProposalEvent {
  event: "created" | "approved" | "applying" | "rejected" | "applied" | "expired";
  ts: string;
  /** "agent"（发起）/ "user:cli"（人工批准/拒绝）/ "system"（自动过期/应用/领取） */
  actor: string;
  proposal: ProposalDetail;
  note?: string;
}

/**
 * 查询结果：未知 id 返回 { status: "unknown", detail: null }；
 * 其余状态 detail 必有。用可辨识联合让调用方 switch 时获得窄化。
 */
export type ProposalState = { status: ProposalStatus; detail: ProposalDetail } | { status: "unknown"; detail: null };

export type MaybePromise<T> = T | Promise<T>;

export interface ProposalApplyOutcome {
  status: "applied" | "rejected";
  note?: string;
}

/**
 * proposal 权威存储端口。JSONL 实现保持同步，PostgreSQL 实现使用异步事务；
 * 调用方统一 await，避免把具体持久化机制泄漏到工具和 worker。
 */
export interface ProposalRepository {
  create(detail: Omit<ProposalDetail, "id" | "expiresAt">): MaybePromise<ProposalDetail>;
  appendEvent(event: Exclude<ProposalEventType, "created">, id: string, actor: string, note?: string): MaybePromise<void>;
  getState(id: string): MaybePromise<ProposalState>;
  list(): MaybePromise<Array<{ detail: ProposalDetail; status: ProposalStatus }>>;
  /**
   * 仅当提案仍为 approved 时执行回调并原子写入终态。
   * PostgreSQL 实现以 SELECT ... FOR UPDATE 串行化多个 worker；JSONL 仅保证单进程。
   */
  applyApproved(id: string, apply: (detail: ProposalDetail) => Promise<ProposalApplyOutcome>): Promise<boolean>;
}

/**
 * 状态推进优先级：只允许沿优先级单向推进，防止文件被手改/竞争导致状态回退。
 *
 * applying 是「应用阶段的独占领取态」（审查意见 F2）：
 *   approved → applying 由 applyApproved 在发起业务写之前落盘，
 *   之后业务写回调与撤回请求不再竞争同一段状态。applying 之后只允许
 *   applied / rejected（后者仅由系统侧的应用失败补偿写入，人工撤回走 Gateway 409）。
 */
const STATUS_RANK: Record<ProposalStatus, number> = {
  pending: 0,
  approved: 1,
  applying: 2,
  expired: 3,
  rejected: 4,
  applied: 4,
};

/** 非 created 事件 → 折叠后的状态 */
const EVENT_STATUS: Record<Exclude<ProposalEventType, "created">, ProposalStatus> = {
  approved: "approved",
  applying: "applying",
  rejected: "rejected",
  applied: "applied",
  expired: "expired",
};

/** 应用租约：worker 领取后未回填终态超过此时长，允许重新领取（默认 5 分钟） */
export const DEFAULT_APPLY_LEASE_MS = 5 * 60_000;

/** 4 位随机小写字母数字（36^4 ≈ 168 万），叠加毫秒时间戳，PoC 足够去重 */
function randomSuffix(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 4; i += 1) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

/**
 * DB 双写 sink 的最小接口（实现在 dbSink.ts）。内联声明避免本文件静态依赖 pg——
 * store 会被 CLI / 冒烟测试在无 DB 场景静态引用，pg 只允许在 index.ts 惰性加载。
 */
export interface ProposalSinkLike {
  onEvent(event: ProposalEvent): Promise<void>;
}

export class ProposalStore implements ProposalRepository {
  constructor(
    private file: string,
    private ttlMinutes: number,
    private db?: ProposalSinkLike,
    /** 应用租约：领取后未回填终态超过此时长视为 worker 失联，允许重新领取 */
    private readonly applyLeaseMs: number = DEFAULT_APPLY_LEASE_MS,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** 创建提案：生成 id 与 expiresAt，追加 created 事件（actor "agent"） */
  create(detail: Omit<ProposalDetail, "id" | "expiresAt">): ProposalDetail {
    // 同毫秒 + 同随机后缀的极端情况下去重（重读文件拿已有 id 集合）
    const taken = new Set(this.foldAll().keys());
    let id: string;
    do {
      id = `p_${Date.now().toString(36)}${randomSuffix()}`;
    } while (taken.has(id));

    const full: ProposalDetail = {
      ...detail,
      id,
      expiresAt: new Date(Date.now() + this.ttlMinutes * 60_000).toISOString(),
    };
    this.record({
      event: "created",
      ts: new Date().toISOString(),
      actor: "agent",
      proposal: full,
    });
    return full;
  }

  /**
   * 追加一条批注事件（approved / rejected / applied / expired）。
   * 会先触发过期判定（pending 超时 → 自动补记 expired），因此不能对已过期提案批准；
   * 状态不允许回退（如对 rejected 再 approve）时抛错——调用方（CLI/工具）应先 getState 判断。
   */
  appendEvent(event: Exclude<ProposalEventType, "created">, id: string, actor: string, note?: string): void {
    const state = this.getState(id); // 复用查询：含 pending → expired 的自动过期补记
    if (state.status === "unknown" || state.detail === null) {
      throw new Error(`提案不存在：${id}`);
    }
    const target = EVENT_STATUS[event];
    if (STATUS_RANK[target] <= STATUS_RANK[state.status]) {
      throw new Error(`提案 ${id} 当前状态为 ${state.status}，不允许追加 ${event} 事件`);
    }
    // applying 是应用阶段的独占领取态：人工撤回必须失败（否则会出现「撤回成功但写入已发生」）。
    // 应用失败补偿走 forceEvent（actor "system"），不受此限制。
    if (state.status === "applying" && event === "rejected" && actor !== "system") {
      throw new Error(`提案 ${id} 正在应用（applying），无法撤回；请等待应用结束或联系管理员处理`);
    }
    this.record({
      event,
      ts: new Date().toISOString(),
      actor,
      proposal: state.detail,
      ...(note !== undefined && note !== "" ? { note } : {}),
    });
  }

  /**
   * 查询单个提案：重读文件折叠事件；pending 且已过 expiresAt 时视为 expired，
   * 并补记 expired 事件（actor "system"）留痕。未知 id 返回 unknown。
   */
  getState(id: string): ProposalState {
    const state = this.foldAll().get(id);
    if (!state) {
      return { status: "unknown", detail: null };
    }
    if (state.status === "pending" && Date.now() > Date.parse(state.detail.expiresAt)) {
      // 注意：这里必须直接落盘补记，不能走 appendEvent——它内部会再调 getState，
      // 而此时提案在文件里仍是 pending+超时，会造成无限递归
      try {
        this.record({
          event: "expired",
          ts: new Date().toISOString(),
          actor: "system",
          proposal: state.detail,
          note: "超过未决时限，自动过期（视为拒绝）",
        });
      } catch (e) {
        // 读路径不因留痕失败而中断：状态判定已成立，写入失败只记 stderr
        log("提案过期事件补记失败:", e);
      }
      return { status: "expired", detail: state.detail };
    }
    return state;
  }

  /**
   * 列出全部提案（按文件中出现顺序 = 创建顺序），含过期判定。
   * 纯读不写：这里不补记 expired 事件（留痕统一发生在 getState），展示时同样按已过期呈现。
   */
  list(): Array<{ detail: ProposalDetail; status: ProposalStatus }> {
    const states = this.foldAll();
    const now = Date.now();
    const out: Array<{ detail: ProposalDetail; status: ProposalStatus }> = [];
    for (const state of states.values()) {
      if (state.status === "unknown" || state.detail === null) continue;
      let status: ProposalStatus = state.status;
      if (status === "pending" && now > Date.parse(state.detail.expiresAt)) {
        status = "expired";
      }
      out.push({ detail: state.detail, status });
    }
    return out;
  }

  async applyApproved(id: string, apply: (detail: ProposalDetail) => Promise<ProposalApplyOutcome>): Promise<boolean> {
    const state = this.getState(id);
    if (state.detail === null) return false;
    if (state.status === "applying" && !this.leaseExpired(id)) return false;
    if (state.status !== "approved" && state.status !== "applying") return false;

    // 独占领取：先落 applying 再执行业务写回调。
    // JSONL 单进程内「读状态 → 落 applying」之间没有 await，等价于一次 compare-and-set；
    // 领取之后 Gateway 侧的人工撤回读到 applying 会返回 409，不再出现「撤回成功但已写入」。
    this.claim(id, state.status);
    let outcome: ProposalApplyOutcome;
    try {
      outcome = await apply(state.detail);
    } catch (error) {
      // 业务写异常抛出（而非返回 rejected）：留痕后上抛，避免 applying 永久悬挂，
      // 同时不把「未知写结果」谎报成成功或干净失败。
      this.forceEvent("rejected", id, "system", `应用失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    this.appendEvent(outcome.status, id, "system", outcome.note);
    return true;
  }

  /** 领取（或租约过期后的重新领取）：直接落盘 applying，不经过状态单调性检查 */
  private claim(id: string, current: ProposalStatus): void {
    const state = this.getState(id);
    if (state.detail === null) return;
    this.record({
      event: "applying",
      ts: new Date().toISOString(),
      actor: "system",
      proposal: state.detail,
      note: current === "applying" ? "应用租约过期，重新领取" : "已领取应用，撤回请求将被拒绝",
    });
  }

  /** 租约是否已过期：读取最后一条 applying 事件的时间戳 */
  private leaseExpired(id: string): boolean {
    let claimedAt: number | undefined;
    for (const ev of this.readEvents()) {
      if (ev?.proposal?.id !== id) continue;
      if (ev.event !== "applying") continue;
      const ts = Date.parse(ev.ts);
      if (Number.isFinite(ts)) claimedAt = ts;
    }
    if (claimedAt === undefined) return false; // 无领取时间戳 = 不敢接管，留在安全侧
    return Date.now() - claimedAt > this.applyLeaseMs;
  }

  /** 绕过状态单调性检查直接落盘：只用于应用失败补偿（applying → rejected） */
  private forceEvent(
    event: Exclude<ProposalEventType, "created">,
    id: string,
    actor: string,
    note?: string,
  ): void {
    const state = this.getState(id);
    if (state.detail === null) return;
    this.record({
      event,
      ts: new Date().toISOString(),
      actor,
      proposal: state.detail,
      ...(note !== undefined && note !== "" ? { note } : {}),
    });
  }

  /**
   * 重读文件并按提案 id 折叠全部事件。
   * 折叠规则：created 建档（初始 pending）；后续事件按 STATUS_RANK 单调推进，
   * 不允许回退（approved 之后的 rejected/expired 等乱序事件被忽略）。
   */
  private foldAll(): Map<string, ProposalState> {
    const states = new Map<string, ProposalState>();
    for (const ev of this.readEvents()) {
      // 半截行/手改行防御：没有合法 proposal.id 的事件直接跳过
      if (!ev || typeof ev?.proposal?.id !== "string") continue;

      if (ev.event === "created") {
        states.set(ev.proposal.id, { status: "pending", detail: ev.proposal });
        continue;
      }
      const current = states.get(ev.proposal.id);
      if (!current || current.status === "unknown") continue; // 孤儿事件（created 缺失），跳过
      const target = EVENT_STATUS[ev.event as Exclude<ProposalEventType, "created">];
      if (!target) continue; // 未知事件类型（版本兼容），跳过
      if (STATUS_RANK[target] > STATUS_RANK[current.status]) {
        states.set(ev.proposal.id, { status: target, detail: current.detail });
      }
    }
    return states;
  }

  private readEvents(): ProposalEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        return []; // 文件尚不存在（首个提案创建前）= 无事件
      }
      throw e; // 其他 IO 错误（权限/磁盘）不掩盖，让调用方感知
    }
    const events: ProposalEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as ProposalEvent);
      } catch {
        log("提案存储：跳过无法解析的行", trimmed.slice(0, 80));
      }
    }
    return events;
  }

  private append(event: ProposalEvent): void {
    // 与审计不同：提案写入失败必须向上抛——写入失败意味着提案不存在/批准未留痕，不能假装成功
    appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
  }

  /**
   * 落盘统一入口：先写 JSONL（权威存储，失败向上抛，见 append），
   * 成功后 fire-and-forget 镜像到 DB（可选 sink → agent_write_proposals 表）。
   * DB 失败只记 stderr：镜像不完整时 JSONL 仍可完整回溯，绝不阻塞提案主流程。
   * created / appendEvent / getState 的过期补记三条写路径都收敛到这里。
   */
  private record(event: ProposalEvent): void {
    this.append(event);
    this.db?.onEvent(event).catch((err) => log("DB 提案双写失败:", err));
  }
}
