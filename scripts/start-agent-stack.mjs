import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayRoot = join(repoRoot, "services", "techhaven-gateway");
const gatewayEntry = join(gatewayRoot, "dist", "index.js");
const gatewayTsc = join(gatewayRoot, "node_modules", "typescript", "bin", "tsc");
const frontendRoot = process.env.TECHHAVEN_FRONTEND_ROOT ? resolve(process.env.TECHHAVEN_FRONTEND_ROOT) : null;
const viteEntry = frontendRoot ? join(frontendRoot, "node_modules", "vite", "bin", "vite.js") : null;

async function requireFile(path, installHint) {
  try {
    await access(path);
  } catch {
    throw new Error(`缺少 ${path}\n${installHint}`);
  }
}

function runNode(args, options) {
  return spawn(process.execPath, args, {
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

async function waitForExit(child, label) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else reject(new Error(`${label} 退出：code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

async function waitForGateway(port, child) {
  const deadline = Date.now() + 15_000;
  const url = `http://127.0.0.1:${port}/healthz`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Agent Gateway 提前退出：code=${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Gateway 仍在启动；短暂等待后重试。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Agent Gateway 在 15 秒内未通过健康检查：${url}`);
}

async function main() {
  await requireFile(gatewayTsc, "请先在 services/techhaven-gateway 执行 npm ci");
  if (viteEntry) await requireFile(viteEntry, "请先在前端仓库执行 npm ci");

  console.log("[agent-stack] 构建 Agent Gateway...");
  const build = runNode([gatewayTsc, "-p", "tsconfig.build.json"], { cwd: gatewayRoot });
  await waitForExit(build, "Gateway 构建");
  await requireFile(gatewayEntry, "Gateway 构建未生成 dist/index.js");

  const port = process.env.TECHHAVEN_GATEWAY_PORT?.trim() || "3091";
  const sharedToken =
    process.env.TECHHAVEN_GATEWAY_TOKEN?.trim() ||
    process.env.TECHHAVEN_GATEWAY_PROXY_TOKEN?.trim() ||
    randomBytes(36).toString("base64url");
  const childEnv = {
    ...process.env,
    VITE_AGENT_ENABLED: "true",
    TECHHAVEN_GATEWAY_PORT: port,
    TECHHAVEN_GATEWAY_TOKEN: sharedToken,
    TECHHAVEN_GATEWAY_PROXY_TOKEN: sharedToken,
    TECHHAVEN_GATEWAY_PROXY_ACTOR: process.env.TECHHAVEN_GATEWAY_PROXY_ACTOR?.trim() || "user:1",
  };

  console.log(`[agent-stack] 启动 Agent Gateway：http://127.0.0.1:${port}`);
  const gateway = runNode([gatewayEntry], { cwd: gatewayRoot, env: childEnv });
  const children = new Set([gateway]);
  let stopping = false;

  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null) child.kill(signal);
    }
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    await waitForGateway(port, gateway);
    if (!viteEntry) {
      console.log("[agent-stack] Gateway 已启动；前端可独立启动。Ctrl+C 停止。");
      await waitForExit(gateway, "Agent Gateway");
      return;
    }
    console.log("[agent-stack] Gateway 健康检查通过，启动外部前端 Vite...");
    const vite = runNode([viteEntry], { cwd: frontendRoot, env: childEnv });
    children.add(vite);

    try {
      await Promise.race([waitForExit(gateway, "Agent Gateway"), waitForExit(vite, "Vite")]);
    } catch (error) {
      if (!stopping) throw error;
    }
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(`[agent-stack] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
