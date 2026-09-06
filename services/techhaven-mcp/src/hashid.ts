import Hashids from "hashids";

/**
 * TechHaven hashId 的服务端镜像（与前端 src/utils/hashId.ts 完全同参）。
 *
 * 防枚举靠的是与前端一致的 scoped 编码；真正的访问控制由 agent token
 * 的组织绑定与 scope 完成（TH-RFC-001 §05.2/§07）。
 */

export type HashIdScope = "article" | "assignment" | "bug" | "organization" | "repo" | "requirement" | "task" | "user";

const BASE_SALT = "kX9mP2vR7wQ4nL8jF5hT3yB6dA1cE0gU";
const MIN_LENGTH = 52;

const legacyHashids = new Hashids(BASE_SALT, MIN_LENGTH);
const scoped = new Map<HashIdScope, Hashids>();

function getHashids(scope?: HashIdScope): Hashids {
  if (!scope) return legacyHashids;
  const cached = scoped.get(scope);
  if (cached) return cached;
  const inst = new Hashids(`${BASE_SALT}:${scope}`, MIN_LENGTH);
  scoped.set(scope, inst);
  return inst;
}

export function encodeId(id: number | string, scope?: HashIdScope): string {
  return getHashids(scope).encode(Number(id));
}

export function decodeId(hash: string, scope?: HashIdScope): number | null {
  const decoded = getHashids(scope).decode(hash);
  if (decoded.length > 0) return Number(decoded[0]);
  if (!scope) return null;
  const legacy = legacyHashids.decode(hash);
  return legacy.length > 0 ? Number(legacy[0]) : null;
}
