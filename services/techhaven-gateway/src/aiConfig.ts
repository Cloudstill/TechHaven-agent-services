import { serviceProvider as parseServiceProvider, responseType as parseResponseType } from "./aiConfigRules.js";
import { isIP } from "node:net";
import type { EngineRuntimeConfig } from "./types.js";
import { isRecord } from "./util.js";

export type AiProviderType = "openai" | "claude" | "glm";
export type AiServiceProvider = "openai" | "anthropic" | "zhipu" | "custom";
export type AiResponseType = "responses" | "chat_completions" | "messages";

export interface AiConfigResolver {
  /**
   * 按 actor 与**已授权的 orgId** 解析本次运行要用的模型配置。
   * orgId 必传性由调用方保证：会话创建前已经过组织成员校验（见 orgAccess.ts），
   * 这里带上同一个 orgId，配置解析才能按组织范围选配置并校验共享授权。
   */
  resolve(actor: string, orgId?: number): Promise<EngineRuntimeConfig>;
}

export interface HttpAiConfigResolverOptions {
  endpoint: string;
  serviceToken: string;
  timeoutMs: number;
  providerIds?: Partial<Record<AiProviderType, string>>;
  fetchImpl?: typeof fetch;
}

export class AiConfigResolutionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiConfigResolutionError";
  }
}

export const DEFAULT_PROVIDER_IDS: Record<AiProviderType, string> = {
  openai: "openai",
  claude: "anthropic",
  glm: "glm",
};

export const DEFAULT_MODELS: Record<AiProviderType, string> = {
  openai: "gpt-4o",
  claude: "claude-sonnet-4-6",
  glm: "glm-4.7-flash",
};

export const PROVIDER_ENV: Record<AiProviderType, { key: string; baseUrl: string }> = {
  openai: { key: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" },
  claude: { key: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" },
  glm: { key: "ZHIPUAI_API_KEY", baseUrl: "ZHIPUAI_BASE_URL" },
};

// ---- 输入边界（防御上游数据异常，而非不信任内部服务）----
/** 密钥长度上限：真实供应商密钥均在数百字符内 */
const MAX_SECRET_LENGTH = 8192;
/** 模型名长度上限 */
const MAX_MODEL_LENGTH = 256;
/** 推理档位长度上限（dsh reasoningEffort 为非空字符串，常见值如 minimal/low/medium/high/max） */
const MAX_REASONING_EFFORT_LENGTH = 64;
/** max_tokens 防御上限：主流模型输出上限远低于此 */
const MAX_TOKENS_LIMIT = 1_000_000;
/** 内部配置服务响应体大小上限 */
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface StoredAiConfig {
  type: AiProviderType;
  provider: AiServiceProvider;
  responseType: AiResponseType;
  url: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export function positiveUserId(actor: string): string {
  const match = /^user:([1-9]\d*)$/.exec(actor);
  if (!match) throw new AiConfigResolutionError(401, "缺少可信用户身份，无法解析 Agent 模型配置");
  return match[1];
}

function providerType(value: unknown): AiProviderType {
  if (value === "openai" || value === "claude" || value === "glm") return value;
  throw new AiConfigResolutionError(502, "用户 AI 配置包含不支持的协议类型");
}

function serviceProvider(value: unknown, type: AiProviderType): AiServiceProvider {
  return parseServiceProvider(value, type, (message) => new AiConfigResolutionError(502, message));
}

function responseType(value: unknown, type: AiProviderType): AiResponseType {
  return parseResponseType(value, type, (message) => new AiConfigResolutionError(502, message));
}

function inferResponseTypeFromUrl(raw: string, type: AiProviderType): AiResponseType {
  if (/\/responses\/?$/i.test(raw)) return responseType("responses", type);
  if (/\/messages\/?$/i.test(raw)) return responseType("messages", type);
  if (/\/chat\/completions\/?$/i.test(raw)) return responseType("chat_completions", type);
  return responseType(undefined, type);
}

function requiredText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AiConfigResolutionError(502, `用户 AI 配置缺少${label}`);
  }
  return value.trim();
}

function usableSecret(value: string): string {
  // 防御上限：真实供应商密钥均在数百字符内。超限说明上游数据异常，
  // 且超长子进程 env 可能在 POSIX execve（ARG_MAX 约 128KB）下直接 spawn 失败。
  if (value.length > MAX_SECRET_LENGTH) {
    throw new AiConfigResolutionError(412, "用户 AI 配置中的密钥长度超出合理范围");
  }
  if (!/^[\x21-\x7e]+$/.test(value) || /[*\u2022]/.test(value)) {
    throw new AiConfigResolutionError(412, "用户 AI 配置中的密钥不可用于运行，请重新保存完整密钥");
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const version = isIP(hostname);
  if (version === 4) return hostname.startsWith("127.");
  return version === 6 && (hostname === "::1" || hostname === "[::1]");
}

/**
 * 用户表单保存的是具体 responses/messages/chat-completions 地址；dsh provider 配置消费 base URL。
 * 这里只删除已知的最终资源段，不猜测其余自定义路径。
 */
export function normalizeProviderBaseUrl(raw: string, type: AiProviderType, apiResponseType?: AiResponseType): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiConfigResolutionError(412, "用户 AI 配置中的接口地址不是合法 URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiConfigResolutionError(412, "用户 AI 配置中的接口地址不能包含认证信息、查询参数或片段");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new AiConfigResolutionError(412, "Agent 模型接口必须使用 HTTPS（本机回环地址除外）");
  }
  const selectedResponseType = responseType(apiResponseType, type);
  const suffix =
    selectedResponseType === "responses"
      ? /\/responses\/?$/
      : selectedResponseType === "messages"
        ? /\/messages\/?$/
        : /\/chat\/completions\/?$/;
  url.pathname = url.pathname.replace(suffix, "").replace(/\/$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function parseStoredConfig(payload: unknown): StoredAiConfig {
  const root = isRecord(payload) ? payload : undefined;
  const raw = root && isRecord(root.data) ? root.data : root;
  if (!raw) throw new AiConfigResolutionError(502, "用户 AI 配置服务返回了无效响应");
  const type = providerType(raw.type);
  const provider = serviceProvider(raw.provider, type);
  const rawUrl = requiredText(raw, "url", "接口地址");
  const apiResponseType = responseType(raw.response_type ?? inferResponseTypeFromUrl(rawUrl, type), type);
  const apiKey = usableSecret(requiredText(raw, "api_key", "完整密钥"));
  const modelValue = raw.model;
  const model = typeof modelValue === "string" && modelValue.trim() !== "" ? modelValue.trim() : DEFAULT_MODELS[type];
  if (model.length > MAX_MODEL_LENGTH) {
    throw new AiConfigResolutionError(502, "用户 AI 配置中的模型名长度超出合理范围");
  }
  const maxTokensValue = raw.max_tokens;
  let maxTokens: number | undefined;
  if (maxTokensValue !== undefined && maxTokensValue !== null) {
    if (!Number.isInteger(maxTokensValue) || (maxTokensValue as number) <= 0) {
      throw new AiConfigResolutionError(502, "用户 AI 配置中的 max_tokens 必须是正整数");
    }
    if ((maxTokensValue as number) > MAX_TOKENS_LIMIT) {
      throw new AiConfigResolutionError(502, "用户 AI 配置中的 max_tokens 超出合理范围");
    }
    maxTokens = maxTokensValue as number;
  }
  const effortValue = raw.reasoning_effort;
  let reasoningEffort: string | undefined;
  if (effortValue !== undefined && effortValue !== null && effortValue !== "") {
    if (typeof effortValue !== "string" || !/^[\x21-\x7e]{1,64}$/.test(effortValue)) {
      throw new AiConfigResolutionError(502, "用户 AI 配置中的推理档位必须是 1~64 个可见 ASCII 字符");
    }
    reasoningEffort = effortValue;
  }
  if (type === "claude" && maxTokens === undefined) {
    throw new AiConfigResolutionError(412, "Claude 配置必须提供 max_tokens");
  }
  return {
    type,
    provider,
    responseType: apiResponseType,
    url: normalizeProviderBaseUrl(rawUrl, type, apiResponseType),
    apiKey,
    model,
    reasoningEffort,
    maxTokens,
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
      throw new AiConfigResolutionError(502, "用户 AI 配置服务响应体超出大小上限");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AiConfigResolutionError(502, "用户 AI 配置服务响应体超出大小上限");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class HttpAiConfigResolver implements AiConfigResolver {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly providerIds: Record<AiProviderType, string>;

  constructor(private readonly options: HttpAiConfigResolverOptions) {
    this.endpoint = new URL(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.providerIds = { ...DEFAULT_PROVIDER_IDS, ...options.providerIds };
  }

  async resolve(actor: string, orgId?: number): Promise<EngineRuntimeConfig> {
    const userId = positiveUserId(actor);
    const url = new URL(this.endpoint);
    url.searchParams.set("user_id", userId);
    // 组织上下文随请求下发：产品后端据此判定该用户在此组织内可用的配置。
    // Gateway 侧已在会话创建前完成成员校验，这里是同一事实的传递，不是新的授权依据。
    if (orgId !== undefined) url.searchParams.set("org_id", String(orgId));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.serviceToken}`,
          "x-techhaven-actor": actor,
          ...(orgId === undefined ? {} : { "x-techhaven-org-id": String(orgId) }),
        },
        signal: controller.signal,
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "AbortError";
      throw new AiConfigResolutionError(503, timedOut ? "用户 AI 配置服务请求超时" : "用户 AI 配置服务不可用");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) throw new AiConfigResolutionError(412, "请先在 Agent 页面完成 API 配置");
    if (response.status === 401 || response.status === 403) {
      throw new AiConfigResolutionError(503, "Gateway 无权读取用户 AI 配置");
    }
    if (!response.ok) throw new AiConfigResolutionError(503, `用户 AI 配置服务返回 HTTP ${response.status}`);
    const rawBody = await readBoundedBody(response);
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AiConfigResolutionError(502, "用户 AI 配置服务返回了非 JSON 响应");
    }
    const config = parseStoredConfig(payload);
    const envNames = PROVIDER_ENV[config.type];
    return {
      provider: this.providerIds[config.type],
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      maxTokens: config.maxTokens,
      env: {
        [envNames.key]: config.apiKey,
        [envNames.baseUrl]: config.url,
      },
    };
  }
}
