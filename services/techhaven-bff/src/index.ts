import { BffConfigError, loadBffConfig } from "./config.js";
import { SessionVerifier } from "./verify.js";
import { startBffServer } from "./server.js";

function main(): void {
  let config;
  try {
    config = loadBffConfig();
  } catch (err) {
    if (err instanceof BffConfigError) console.error(`配置错误：${err.message}`);
    else console.error("配置载入失败：", err);
    process.exit(1);
  }
  const verifier = SessionVerifier.fromConfig(config);
  startBffServer(config, verifier);
}

main();
