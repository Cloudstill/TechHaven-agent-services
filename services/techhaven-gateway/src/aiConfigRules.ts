import type { AiProviderType, AiResponseType, AiServiceProvider } from "./aiConfig.js";

function defaultServiceProvider(type: AiProviderType): AiServiceProvider {
  if (type === "claude") return "anthropic";
  if (type === "glm") return "zhipu";
  return "openai";
}

export function serviceProvider(value: unknown, type: AiProviderType, error: (message: string) => Error): AiServiceProvider {
  const provider = value === undefined || value === null || value === "" ? defaultServiceProvider(type) : value;
  if (provider !== "openai" && provider !== "anthropic" && provider !== "zhipu" && provider !== "custom") {
    throw error("用户 AI 配置包含不支持的服务商");
  }
  const expectedType = provider === "openai" ? "openai" : provider === "anthropic" ? "claude" : provider === "zhipu" ? "glm" : type;
  if (expectedType !== type) {
    throw error("用户 AI 配置中的服务商与协议类型不匹配");
  }
  return provider;
}

export function responseType(value: unknown, type: AiProviderType, error: (message: string) => Error): AiResponseType {
  const fallback: AiResponseType = type === "claude" ? "messages" : "chat_completions";
  const response = value === undefined || value === null || value === "" ? fallback : value;
  const valid =
    (type === "openai" && (response === "responses" || response === "chat_completions")) ||
    (type === "claude" && response === "messages") ||
    (type === "glm" && response === "chat_completions");
  if (!valid) throw error("用户 AI 配置中的接口类型与协议不匹配");
  return response as AiResponseType;
}
