import { mkdtemp, mkdir, cp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = resolve(process.argv[2] || join(root, "techhaven-agent-release.tgz"));
const work = await mkdtemp(join(tmpdir(), "techhaven-agent-package-"));
const stage = join(work, "release");
try {
  await mkdir(stage);
  for (const name of ["techhaven-gateway", "techhaven-bff", "techhaven-agent-bridge", "techhaven-mcp"]) {
    const source = join(root, "services", name);
    const destination = join(stage, "services", name);
    await access(join(source, "dist", "index.js"));
    await mkdir(destination, { recursive: true });
    await cp(join(source, "dist"), join(destination, "dist"), {
      recursive: true,
      filter: (path) => !/\.test\.(?:js|js\.map|d\.ts)$/.test(path),
    });
    for (const file of ["package.json", "package-lock.json", ".env.example"]) {
      await cp(join(source, file), join(destination, file));
    }
  }
  await cp(join(root, "contracts"), join(stage, "contracts"), { recursive: true });
  await cp(join(root, "docs", "agent-db"), join(stage, "docs", "agent-db"), { recursive: true });
  await mkdir(join(stage, "scripts"));
  for (const name of ["agent-gateway-service.sh", "bff-service.sh", "node-service.sh", "install-agent-gateway-systemd.sh"]) {
    await cp(join(root, "scripts", name), join(stage, "scripts", name));
  }
  await writeFile(join(stage, "release-manifest.json"), JSON.stringify({
    kind: "agent-services-only", builtAt: new Date().toISOString(), contractVersion: "0.1.0",
    frontendIncluded: false, migrationsAutomaticallyApplied: false,
  }, null, 2));
  await mkdir(dirname(archive), { recursive: true });
  const result = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar failed: ${result.status}`);
  console.log(`Agent-only release: ${archive}`);
} finally {
  const child = relative(resolve(tmpdir()), resolve(work));
  if (child && !isAbsolute(child) && !child.startsWith("..") && child.startsWith("techhaven-agent-package-")) {
    await rm(work, { recursive: true, force: true });
  }
}
