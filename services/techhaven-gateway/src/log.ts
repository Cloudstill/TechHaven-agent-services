/** 仅输出到 stderr —— stdout 预留给未来的协议/管道用途，禁止污染。
 *  ≈ services/techhaven-mcp/src/log.ts 同构孪生（防漂移：改动需同步评审两处） */
export function log(...args: unknown[]): void {
  console.error("[techhaven-gateway]", ...args);
}
