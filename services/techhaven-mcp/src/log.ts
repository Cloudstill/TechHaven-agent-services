/** 仅输出到 stderr —— stdio MCP 传输下 stdout 是协议通道，禁止污染 */
export function log(...args: unknown[]): void {
  console.error("[techhaven-mcp]", ...args);
}
