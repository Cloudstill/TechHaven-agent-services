import type { IncomingMessage, ServerResponse } from "node:http";
import type { AiProviderType, AiResponseType, AiServiceProvider } from "./aiConfig.js";
import type { AiConfigStore, AiConfigSummary, CreateConfigInput, UpdateConfigInput } from "./aiConfigStore.js";
import { maskSecret } from "./aiConfigCrypto.js";
import { serviceProvider, responseType } from "./aiConfigRules.js";
import { GatewayError } from "./sessions.js";
import { trustedActor, readJsonBody, jsonObject, requireString, optionalString, sendJson } from "./httpSupport.js";

function userIdOf(req: IncomingMessage): number {
  return Number(trustedActor(req).slice("user:".length));
}

/** 配置响应视图：api_key 永远是脱敏串，明文密钥不经过任何 HTTP 响应 */
function configView(summary: AiConfigSummary): Record<string, unknown> {
  return {
    id: summary.id,
    scope: summary.scope,
    owner_id: summary.ownerId,
    name: summary.name,
    type: summary.providerType,
    provider: summary.serviceProvider,
    response_type: summary.responseType,
    url: summary.endpointUrl,
    api_key: summary.apiKeyMasked,
    model: summary.model ?? "",
    reasoning_effort: summary.reasoningEffort ?? "",
    max_tokens: summary.maxTokens ?? null,
    is_default: summary.isDefault,
    shared: summary.shared,
    status: summary.status,
    last_used_at: summary.lastUsedAt ?? null,
  };
}

/** 校验配置归属：只允许用户操作自己的个人配置 */
async function requireOwnedConfig(store: AiConfigStore, userId: number, id: number): Promise<AiConfigSummary> {
  const owned = (await store.listByOwner("user", userId)).find((c) => c.id === id);
  if (!owned) throw new GatewayError(404, `未找到你的 AI 配置（id=${id}）`);
  return owned;
}

/** 可空正整数字段：undefined/null → null；其余必须是正整数 */
function parseNullablePositiveInt(body: Record<string, unknown>, key: string): number | null {
  const raw = body[key];
  if (raw === undefined || raw === null) return null;
  if (!Number.isInteger(raw) || (raw as number) < 1) {
    throw new GatewayError(400, `字段 ${key} 必须是正整数或 null`);
  }
  return raw as number;
}

function providerFrom(type: AiProviderType, raw: unknown): AiServiceProvider {
  return serviceProvider(raw, type, (message) => new GatewayError(400, message));
}

function responseTypeFrom(type: AiProviderType, raw: unknown): AiResponseType {
  return responseType(raw, type, (message) => new GatewayError(400, message));
}

/** 密钥形态校验：与前端表单及 Gateway 失败关闭规则一致 */
function validateApiKeyShape(raw: string): string {
  if (raw.length > 8192) throw new GatewayError(400, "密钥长度超出合理范围（上限 8192 字符）");
  if (/[*•]/.test(raw)) throw new GatewayError(400, "请填入完整密钥：脱敏串无法用于运行");
  if (!/^[\x21-\x7e]+$/.test(raw)) throw new GatewayError(400, "密钥只能包含可打印 ASCII 字符");
  return raw;
}

function maxTokensFrom(type: AiProviderType, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") {
    if (type === "claude") throw new GatewayError(400, "Claude 配置必须填写 max_tokens");
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000_000) {
    throw new GatewayError(400, "字段 max_tokens 必须是 1~1000000 的整数");
  }
  return parsed;
}

function reasoningEffortFrom(raw: unknown): string | undefined {
  const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  if (value !== undefined && !/^[\x21-\x7e]{1,64}$/.test(value)) {
    throw new GatewayError(400, "字段 reasoning_effort 必须是 1~64 个可见 ASCII 字符");
  }
  return value;
}

/** POST /v1/ai-configs 请求体校验（只允许创建个人配置；组织配置走管理通道） */
function parseCreateConfigBody(body: Record<string, unknown>, userId: number): CreateConfigInput {
  const name = requireString(body, "name").trim();
  if (name.length > 64) throw new GatewayError(400, "字段 name 最长 64 字符");
  const type = body.type;
  if (type !== "openai" && type !== "claude" && type !== "glm") {
    throw new GatewayError(400, '字段 type 必须是 "openai" | "claude" | "glm"');
  }
  const provider = providerFrom(type, body.provider);
  const responseType = responseTypeFrom(type, body.response_type);
  const url = requireString(body, "url").trim();
  const apiKey = validateApiKeyShape(requireString(body, "api_key").trim());
  return {
    scope: "user",
    ownerId: userId,
    name,
    providerType: type,
    serviceProvider: provider,
    responseType,
    endpointUrl: url,
    apiKey,
    model: optionalString(body, "model")?.trim() || undefined,
    reasoningEffort: reasoningEffortFrom(body.reasoning_effort),
    maxTokens: maxTokensFrom(type, body.max_tokens),
    isDefault: body.is_default === true,
    shared: false,
    createdBy: userId,
  };
}

/** PATCH /v1/ai-configs/:id 请求体校验：只认出现的字段，字段值规则与创建一致 */
function parseUpdateConfigBody(body: Record<string, unknown>, current: AiConfigSummary): UpdateConfigInput {
  const patch: UpdateConfigInput = {};
  const apiKey = optionalString(body, "api_key")?.trim();
  if (apiKey) patch.apiKey = validateApiKeyShape(apiKey);
  if (body.name !== undefined) {
    const name = requireString(body, "name").trim();
    if (name.length > 64) throw new GatewayError(400, "字段 name 最长 64 字符");
    patch.name = name;
  }
  if (body.url !== undefined) patch.endpointUrl = requireString(body, "url").trim();
  const typeHint =
    body.type === undefined ? current.providerType : body.type === "claude" || body.type === "glm" ? body.type : "openai";
  if (body.provider !== undefined) patch.serviceProvider = providerFrom(typeHint, body.provider);
  if (body.type !== undefined) {
    if (body.type !== "openai" && body.type !== "claude" && body.type !== "glm") {
      throw new GatewayError(400, '字段 type 必须是 "openai" | "claude" | "glm"');
    }
    patch.providerType = body.type;
  }
  if (body.response_type !== undefined) patch.responseType = responseTypeFrom(typeHint, body.response_type);
  if (body.model !== undefined) patch.model = optionalString(body, "model")?.trim() || null;
  if (body.reasoning_effort !== undefined) patch.reasoningEffort = reasoningEffortFrom(body.reasoning_effort) ?? null;
  if (body.max_tokens !== undefined) patch.maxTokens = maxTokensFrom(typeHint, body.max_tokens) ?? null;
  if (body.is_default !== undefined) patch.isDefault = body.is_default === true;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled" && body.status !== "quota_exceeded") {
      throw new GatewayError(400, '字段 status 必须是 "active" | "disabled" | "quota_exceeded"');
    }
    patch.status = body.status;
  }
  return patch;
}

/** Called only after the parent router has authenticated the internal service token. */
export async function handleAiConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  aiConfigStore?: AiConfigStore,
): Promise<void> {
  const path = url.pathname;
  const method = req.method?.toUpperCase() ?? "GET";
  if (path === "/v1/ai-configs/mode" && method === "GET") {
    trustedActor(req);
    sendJson(res, 200, { storage: aiConfigStore ? "assets" : "legacy" });
    return;
  }
  if (!aiConfigStore) {
    throw new GatewayError(503, "AI 配置资产未启用：需要 TECHHAVEN_GATEWAY_STORE=postgres 并配置主密钥");
  }
  const userId = userIdOf(req);

  if (path === "/v1/ai-configs" && method === "GET") {
    const preference = await aiConfigStore.getPreference(userId);
    const userConfigs = await aiConfigStore.listByOwner("user", userId);
    const orgConfigs = preference.orgId ? (await aiConfigStore.listByOwner("org", preference.orgId)).filter((c) => c.shared) : [];
    sendJson(res, 200, {
      configs: userConfigs.map(configView),
      org_configs: orgConfigs.map(configView),
      preference: preference.activeConfigId ?? null,
    });
    return;
  }

  if (path === "/v1/ai-configs" && method === "POST") {
    const body = jsonObject(await readJsonBody(req));
    const created = await aiConfigStore.create(parseCreateConfigBody(body, userId));
    sendJson(res, 201, configView(created));
    return;
  }

  // 固定子路径必须先于 :id 匹配
  if (path === "/v1/ai-configs/resolve" && method === "GET") {
    const resolved = await aiConfigStore.resolveForRun({
      userId,
      requestedName: url.searchParams.get("name"),
    });
    // 响应里只给脱敏串：明文密钥只允许流向 dsh 子进程环境变量
    const { apiKey, ...meta } = resolved.config;
    sendJson(res, 200, {
      config: configView({ ...meta, apiKeyMasked: maskSecret(apiKey) }),
      source: resolved.source,
      borrowed_from_org: resolved.borrowedFromOrg,
    });
    return;
  }

  if (path === "/v1/ai-configs/preference" && method === "PUT") {
    const body = jsonObject(await readJsonBody(req));
    const configId = parseNullablePositiveInt(body, "config_id");
    const orgId = parseNullablePositiveInt(body, "org_id");
    await aiConfigStore.setPreference(userId, orgId, configId);
    sendJson(res, 200, { ok: true });
    return;
  }

  const configKeyMatch = /^\/v1\/ai-configs\/(\d+)\/key$/.exec(path);
  if (configKeyMatch && method === "PUT") {
    const body = jsonObject(await readJsonBody(req));
    const apiKey = validateApiKeyShape(requireString(body, "api_key").trim());
    const updated = await aiConfigStore.rotateKey(Number(configKeyMatch[1]), "user", userId, apiKey);
    sendJson(res, 200, configView(updated));
    return;
  }

  const configUsageMatch = /^\/v1\/ai-configs\/(\d+)\/usage$/.exec(path);
  if (configUsageMatch && method === "GET") {
    const id = Number(configUsageMatch[1]);
    await requireOwnedConfig(aiConfigStore, userId, id);
    const windows = await aiConfigStore.usageWindows(id);
    const total = await aiConfigStore.usageTotal(id);
    sendJson(res, 200, { daily: windows.daily, monthly: windows.monthly, total });
    return;
  }

  const configMatch = /^\/v1\/ai-configs\/(\d+)$/.exec(path);
  if (configMatch) {
    const id = Number(configMatch[1]);
    if (method === "GET") {
      sendJson(res, 200, configView(await requireOwnedConfig(aiConfigStore, userId, id)));
      return;
    }
    if (method === "PATCH") {
      const body = jsonObject(await readJsonBody(req));
      const current = await requireOwnedConfig(aiConfigStore, userId, id);
      const updated = await aiConfigStore.update(id, "user", userId, parseUpdateConfigBody(body, current));
      sendJson(res, 200, configView(updated));
      return;
    }
    if (method === "DELETE") {
      await aiConfigStore.remove(id, "user", userId);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  throw new GatewayError(405, `${method} 不支持该资源`);
}
