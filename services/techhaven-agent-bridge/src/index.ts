#!/usr/bin/env node
import { loadConfig, ConfigError } from "./config.js";
import { LegacyHttpClient } from "./legacyClient.js";
import { JsonlOperationLedger } from "./ledger.js";
import { BridgeService } from "./bridgeService.js";
import { createBridgeServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ledger = new JsonlOperationLedger(config.ledgerFile);
  const legacy = new LegacyHttpClient(config);
  const service = new BridgeService(legacy, ledger);
  const server = createBridgeServer(config, service);

  server.listen(config.port, "127.0.0.1", () => {
    console.error(
      `[techhaven-agent-bridge] listening=127.0.0.1:${config.port} legacy=${new URL(config.legacyBaseUrl).origin} auth=${config.legacyAuthMode}`,
    );
  });
  server.on("error", (error) => {
    console.error("[techhaven-agent-bridge] HTTP server error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.error(`[techhaven-agent-bridge] ${signal}, shutting down`);
    server.close(() => void ledger.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  if (error instanceof ConfigError) console.error(`[techhaven-agent-bridge] config error: ${error.message}`);
  else console.error("[techhaven-agent-bridge] startup failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
