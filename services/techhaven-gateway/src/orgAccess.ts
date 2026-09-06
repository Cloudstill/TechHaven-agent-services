/**
 * 组织授权端口（审查意见 F1）。
 *
 * 背景：POST /v1/sessions 直接接受请求体里的 orgId。BFF 只证明「调用者是谁」
 * （trustedActor → ownerActor），不证明「该用户属于这个组织」。配置资产里的
 * `AiConfigStore.requireOrgMember` 只覆盖「能不能用这份配置」，`AiConfigResolver.resolve`
 * 也只收到 actor、收不到本次会话的 orgId，因此都不能替代这里的业务授权。
 *
 * 端口刻意做窄：只回答「是不是该组织成员」，不复制产品后端的应用授权策略。
 * 未配置授权实现时 Gateway fail-closed（创建会话 503），而不是默认放行。
 */
import type { AiConfigStore } from "./aiConfigStore.js";
import { positiveUserId } from "./aiConfig.js";
import { GatewayError } from "./sessions.js";

export interface OrgAccessPort {
  /**
   * 校验 actor 是否属于 orgId。
   * @throws 不属于时抛带 HTTP 语义的错误（403 无权 / 503 授权服务不可用）
   */
  requireMember(actor: string, orgId: number): Promise<void>;
}

/** 组织授权未配置：fail-closed，绝不放行 */
export class OrgAccessUnavailableError extends GatewayError {
  constructor() {
    super(503, "未配置可信组织授权服务，暂不能创建会话");
    this.name = "OrgAccessUnavailableError";
  }
}

/**
 * 拒绝一切组织访问的空实现。用于「必须显式决定放行策略」的场景，
 * 保证未接线时是安全侧（拒绝）而不是开放侧（放行）。
 */
export class DenyAllOrgAccess implements OrgAccessPort {
  async requireMember(): Promise<void> {
    throw new OrgAccessUnavailableError();
  }
}

/** 以 Agent DB 的 ai_org_memberships 为权威的成员校验（与配置资产同源）。 */
export class AiConfigOrgAccess implements OrgAccessPort {
  constructor(private readonly store: Pick<AiConfigStore, "requireOrgMember">) {}

  async requireMember(actor: string, orgId: number): Promise<void> {
    // positiveUserId 对非 user:<id> 身份抛 401：服务身份本身不能代表某个用户建会话
    const userId = Number(positiveUserId(actor));
    if (!Number.isInteger(orgId) || orgId < 1) throw new GatewayError(400, "字段 orgId 必须是正整数");
    // requireOrgMember 抛 AiConfigStoreError(403)，由 http.ts 统一映射
    await this.store.requireOrgMember(userId, orgId);
  }
}

export const ORG_ACCESS_ALLOW_ALL_ENV = "TECHHAVEN_ORG_ACCESS_ALLOW_ALL";

/**
 * 本地 mock 演示逃生舱：仅当显式设置 TECHHAVEN_ORG_ACCESS_ALLOW_ALL=1 且驱动为 mock 时启用。
 * 不做任何成员校验，启动与每次放行都留告警日志；真实部署不得使用。
 */
export class LocalDemoOrgAccess implements OrgAccessPort {
  constructor(
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  async requireMember(actor: string, orgId: number): Promise<void> {
    this.warn(`本地演示模式：跳过 ${actor} 对组织 ${orgId} 的成员校验（${ORG_ACCESS_ALLOW_ALL_ENV}=1），不得用于真实部署`);
  }
}
