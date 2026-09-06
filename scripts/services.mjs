import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const services = ["techhaven-gateway", "techhaven-bff", "techhaven-agent-bridge", "techhaven-mcp"];
const mode = process.argv[2];
if (!["install", "build", "test", "check"].includes(mode)) throw new Error("Expected install, build, test or check");
for (const service of services) {
  const cwd = resolve(root, "services", service);
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (mode === "test" || mode === "check") {
    console.log(`\n[${service}] compile and run Node-native tests`);
    const output = mkdtempSync(resolve(cwd, ".test-dist-"));
    try {
      run([resolve(cwd, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", output]);
      const tests = readdirSync(output, { recursive: true }).filter((path) => path.endsWith(".test.js")).map((path) => resolve(output, path));
      if (!tests.length) throw new Error(`No compiled tests for ${service}`);
      run(["--test", ...tests]);
      if (mode === "check") {
        run([process.env.npm_execpath, "run", "build"]);
        const smokes = service === "techhaven-bff" ? [] : service === "techhaven-mcp" ? ["smoke.js", "smoke.staged.js", "smoke.http.js"] : ["smoke.js"];
        for (const smoke of smokes) run([resolve(output, smoke)]);
      }
    } finally {
      // output is created by mkdtempSync directly under this exact service directory.
      if (dirname(output) === cwd && output.startsWith(resolve(cwd, ".test-dist-"))) rmSync(output, { recursive: true, force: true });
    }
    continue;
  }
  const tasks = mode === "install" ? [["ci", "--no-audit", "--no-fund"]] : mode === "check"
    ? [["run", "typecheck"], ["test"], ["run", service === "techhaven-bff" ? "build" : "smoke"]]
    : [["run", mode]];
  for (const args of tasks) {
    console.log(`\n[${service}] npm ${args.join(" ")}`);
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: resolve(root, "services", service), stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
