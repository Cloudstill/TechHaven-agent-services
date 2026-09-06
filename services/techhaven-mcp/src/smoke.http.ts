/** 离线 HTTP adapter contract：服务身份、组织参数、幂等键、错误与超时归一化。 */
import { DomainError } from "./techhaven/client.js";
import { HttpTechHavenClient } from "./techhaven/httpClient.js";

let checks = 0;
function check(label: string, condition: unknown): void {
  if (!condition) throw new Error(`✗ ${label}`);
  checks += 1;
  console.log(`✓ ${label}`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function main(): Promise<void> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let status = "todo";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/rd/tasks/detail")) {
      return json({
        errno: 0,
        data: {
          id: 1,
          title: "contract task",
          description: "contract",
          status,
          priority: "medium",
          assignee: "chen",
          creator: "chen",
          create_time: "2026-08-29T00:00:00.000Z",
          update_time: "2026-08-29T00:00:00.000Z",
        },
      });
    }
    if (url.endsWith("/rd/tasks/edit")) {
      status = "doing";
      return json({ errno: 0, data: { ok: true } });
    }
    return json({ errno: 4041, msg: "contract error" });
  };
  const client = new HttpTechHavenClient({
    apiBaseUrl: "https://backend.invalid",
    serviceToken: "service-secret",
    timeoutMs: 500,
    fetchImpl,
  });
  const updated = await client.updateTicketStatus(7, "task", 1, "doing", "contract smoke", {
    idempotencyKey: "proposal-1",
  });
  check("HTTP adapter 映射真实域工单结构", updated.status === "doing");
  check(
    "所有域请求携带独立 service Bearer",
    calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer service-secret"),
  );
  check(
    "写请求携带 proposal 幂等键",
    new Headers(calls.find((call) => call.url.endsWith("/edit"))?.init?.headers).get("idempotency-key") === "proposal-1",
  );
  check(
    "域请求显式携带 org_id",
    calls.filter((call) => call.url.includes("/detail")).every((call) => call.url.includes("org_id=7")),
  );

  const errorClient = new HttpTechHavenClient({
    apiBaseUrl: "https://backend.invalid",
    serviceToken: "service-secret",
    fetchImpl: async () => json({ errno: 4100, msg: "非法迁移" }),
  });
  const domainError = await errorClient.getTicket(1, "task", 1).then(
    () => null,
    (error: unknown) => error,
  );
  check("后端 errno 归一为 DomainError", domainError instanceof DomainError && domainError.code === "BACKEND_ERRNO");

  const timeoutClient = new HttpTechHavenClient({
    apiBaseUrl: "https://backend.invalid",
    serviceToken: "service-secret",
    timeoutMs: 20,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("timeout signal did not abort")), 1_000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  });
  const timeoutError = await timeoutClient.getTicket(1, "task", 1).then(
    () => null,
    (error: unknown) => error,
  );
  check("域 API 超时 fail-closed 并给出稳定错误码", timeoutError instanceof DomainError && timeoutError.code === "UPSTREAM_TIMEOUT");

  console.log(`HTTP CONTRACT SMOKE PASS：${checks} 项`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
