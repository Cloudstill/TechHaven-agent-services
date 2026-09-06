import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AI 配置密钥的静态加密存储（AES-256-GCM）。
 *
 * 威胁模型：数据库文件/备份泄露时，攻击者拿不到可用明文。
 * 主密钥不入库，只从环境变量注入（见 .env.example），轮换靠 key_version 逐条重加密。
 *
 * 密文布局（自描述，便于轮换与排障）：
 *   [0]      key_version，1 字节
 *   [1..12]  IV，12 字节（GCM 推荐长度）
 *   [13..28] authTag，16 字节
 *   [29..]   密文
 */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;
const KEY_LENGTH = 32;

const CURRENT_KEY_VERSION = 1;

export class AiConfigCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigCryptoError";
  }
}

export interface MasterKeySet {
  /** 新写入使用的版本号 */
  currentVersion: number;
  /** 版本号 → 32 字节密钥；解密时按密文头部版本号取用 */
  keys: Map<number, Buffer>;
}

/**
 * 从环境变量加载主密钥集合。
 *
 * - TECHHAVEN_AI_CONFIG_MASTER_KEY：当前主密钥（base64，32 字节），必填
 * - TECHHAVEN_AI_CONFIG_MASTER_KEY_PREVIOUS：上一版主密钥，可选；
 *   轮换期内旧密文仍要能解开，重加密完成后即可移除
 */
export function loadMasterKeys(env: NodeJS.ProcessEnv = process.env): MasterKeySet {
  const currentRaw = env.TECHHAVEN_AI_CONFIG_MASTER_KEY?.trim() ?? "";
  if (!currentRaw) {
    throw new AiConfigCryptoError(
      "缺少 TECHHAVEN_AI_CONFIG_MASTER_KEY（AI 配置主密钥，base64 编码的 32 字节）",
    );
  }
  const current = decodeKey(currentRaw, "TECHHAVEN_AI_CONFIG_MASTER_KEY");
  const currentVersion = parseKeyVersion(env.TECHHAVEN_AI_CONFIG_MASTER_KEY_VERSION, CURRENT_KEY_VERSION);

  const keys = new Map<number, Buffer>([[currentVersion, current]]);

  const previousRaw = env.TECHHAVEN_AI_CONFIG_MASTER_KEY_PREVIOUS?.trim() ?? "";
  if (previousRaw) {
    if (currentVersion <= 1) {
      throw new AiConfigCryptoError(
        "TECHHAVEN_AI_CONFIG_MASTER_KEY_PREVIOUS 需要当前版本号大于 1，请先设置 TECHHAVEN_AI_CONFIG_MASTER_KEY_VERSION",
      );
    }
    keys.set(currentVersion - 1, decodeKey(previousRaw, "TECHHAVEN_AI_CONFIG_MASTER_KEY_PREVIOUS"));
  }

  return { currentVersion, keys };
}

function parseKeyVersion(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 255) {
    throw new AiConfigCryptoError(`TECHHAVEN_AI_CONFIG_MASTER_KEY_VERSION 必须是 1~255 的整数，收到：${trimmed}`);
  }
  return parsed;
}

function decodeKey(raw: string, name: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new AiConfigCryptoError(`${name} 不是合法的 base64`);
  }
  if (key.length !== KEY_LENGTH) {
    throw new AiConfigCryptoError(`${name} 解码后必须是 ${KEY_LENGTH} 字节，实际 ${key.length} 字节`);
  }
  // 防止误用弱密钥：base64 合法但内容可疑（如全零）时直接拒绝
  if (key.every((byte) => byte === 0)) {
    throw new AiConfigCryptoError(`${name} 不能是全零字节`);
  }
  return key;
}

/** 生成一个新的主密钥（部署时写入环境变量用） */
export function generateMasterKey(): string {
  return randomBytes(KEY_LENGTH).toString("base64");
}

export function encryptSecret(plain: string, keySet: MasterKeySet): Buffer {
  const key = keySet.keys.get(keySet.currentVersion);
  if (!key) {
    throw new AiConfigCryptoError(`主密钥缺少版本 ${keySet.currentVersion}`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const header = Buffer.alloc(1);
  header.writeUInt8(keySet.currentVersion, 0);
  return Buffer.concat([header, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(blob: Buffer, keySet: MasterKeySet): string {
  if (!Buffer.isBuffer(blob) || blob.length <= HEADER_LENGTH) {
    throw new AiConfigCryptoError("AI 配置密文长度不足，可能已被截断");
  }
  const version = blob.readUInt8(0);
  const key = keySet.keys.get(version);
  if (!key) {
    throw new AiConfigCryptoError(`AI 配置密文使用主密钥版本 ${version}，但当前未配置该版本`);
  }
  const iv = blob.subarray(1, 1 + IV_LENGTH);
  const tag = blob.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const encrypted = blob.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    // 统一措辞：不区分是主密钥不对还是密文被改，避免给攻击者反馈
    throw new AiConfigCryptoError("AI 配置密文校验失败：主密钥不匹配或数据被篡改");
  }
}

/**
 * 密钥指纹：sha256 前 16 位十六进制。
 * 用途：判断两处配置是否同一把钥匙、审计关联；不可逆，泄露无风险。
 */
export function secretFingerprint(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex").slice(0, 16);
}

/** 恒定时间比较，避免通过响应时间侧信道逐字节猜指纹 */
export function fingerprintsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 脱敏显示：保留前 3 位与后 4 位。
 * 过短（≤8）时返回固定长度掩码——不按真实长度补齐星号，
 * 否则掩码本身会泄露密钥长度，构成侧信道。
 */
export function maskSecret(plain: string): string {
  if (plain.length <= 8) return "****";
  return `${plain.slice(0, 3)}***${plain.slice(-4)}`;
}
