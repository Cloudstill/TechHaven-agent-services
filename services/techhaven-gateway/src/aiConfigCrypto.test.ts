import test from "node:test";
import assert from "node:assert/strict";
import {
  AiConfigCryptoError,
  decryptSecret,
  encryptSecret,
  fingerprintsEqual,
  generateMasterKey,
  loadMasterKeys,
  maskSecret,
  secretFingerprint,
  type MasterKeySet,
} from "./aiConfigCrypto.js";

function keySetOf(current: string, extra: NodeJS.ProcessEnv = {}): MasterKeySet {
  return loadMasterKeys({ TECHHAVEN_AI_CONFIG_MASTER_KEY: current, ...extra });
}

test("密钥加解密往返一致", () => {
  const keys = keySetOf(generateMasterKey());
  const cipher = encryptSecret("sk-live-abcdef123456", keys);
  assert.equal(decryptSecret(cipher, keys), "sk-live-abcdef123456");
});

test("密文不泄露明文，且每次加密结果不同（随机 IV）", () => {
  const keys = keySetOf(generateMasterKey());
  const plain = "sk-live-ultra-secret-value";
  const first = encryptSecret(plain, keys);
  const second = encryptSecret(plain, keys);
  assert.ok(!first.toString("latin1").includes("ultra-secret"));
  assert.ok(!first.equals(second), "相同明文两次加密应产生不同密文");
  assert.equal(decryptSecret(second, keys), plain);
});

test("密文被篡改时解密失败且不泄露原因", () => {
  const keys = keySetOf(generateMasterKey());
  const cipher = encryptSecret("sk-live-abcdef", keys);
  const tampered = Buffer.from(cipher);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptSecret(tampered, keys), (err: unknown) => {
    assert.ok(err instanceof AiConfigCryptoError);
    assert.match(err.message, /校验失败/);
    return true;
  });
});

test("用错主密钥时解密失败", () => {
  const writer = keySetOf(generateMasterKey());
  const reader = keySetOf(generateMasterKey());
  const cipher = encryptSecret("sk-live-abcdef", writer);
  assert.throws(() => decryptSecret(cipher, reader), AiConfigCryptoError);
});

test("主密钥轮换期内旧密文仍可解，缺少旧版本时失败", () => {
  const oldKey = generateMasterKey();
  const newKey = generateMasterKey();

  const writer = keySetOf(oldKey);
  const cipher = encryptSecret("sk-live-legacy", writer);
  assert.equal(cipher.readUInt8(0), 1, "密文头部记录写入时的主密钥版本");

  const rotated = loadMasterKeys({
    TECHHAVEN_AI_CONFIG_MASTER_KEY: newKey,
    TECHHAVEN_AI_CONFIG_MASTER_KEY_VERSION: "2",
    TECHHAVEN_AI_CONFIG_MASTER_KEY_PREVIOUS: oldKey,
  });
  assert.equal(rotated.currentVersion, 2);
  assert.equal(decryptSecret(cipher, rotated), "sk-live-legacy");

  const withoutPrevious = loadMasterKeys({
    TECHHAVEN_AI_CONFIG_MASTER_KEY: newKey,
    TECHHAVEN_AI_CONFIG_MASTER_KEY_VERSION: "2",
  });
  assert.throws(() => decryptSecret(cipher, withoutPrevious), /主密钥版本 1/);
});

test("轮换后新写入使用新版本号", () => {
  const rotated = loadMasterKeys({
    TECHHAVEN_AI_CONFIG_MASTER_KEY: generateMasterKey(),
    TECHHAVEN_AI_CONFIG_MASTER_KEY_VERSION: "7",
  });
  const cipher = encryptSecret("sk-live-new", rotated);
  assert.equal(cipher.readUInt8(0), 7);
});

test("主密钥缺失或长度错误时拒绝启动", () => {
  assert.throws(() => loadMasterKeys({}), /缺少 TECHHAVEN_AI_CONFIG_MASTER_KEY/);
  assert.throws(
    () => keySetOf(Buffer.alloc(16).toString("base64")),
    /必须是 32 字节/,
  );
  assert.throws(() => keySetOf(Buffer.alloc(32).toString("base64")), /不能是全零字节/);
});

test("配置了历史主密钥但版本号为 1 时拒绝启动", () => {
  assert.throws(
    () =>
      loadMasterKeys({
        TECHHAVEN_AI_CONFIG_MASTER_KEY: generateMasterKey(),
        TECHHAVEN_AI_CONFIG_MASTER_KEY_PREVIOUS: generateMasterKey(),
      }),
    /版本号大于 1/,
  );
});

test("截断的密文被拒绝", () => {
  const keys = keySetOf(generateMasterKey());
  const cipher = encryptSecret("sk-live-abcdef", keys);
  assert.throws(() => decryptSecret(cipher.subarray(0, 10), keys), /长度不足/);
});

test("指纹稳定、长度固定、不同密钥不碰撞", () => {
  assert.equal(secretFingerprint("sk-aaa"), secretFingerprint("sk-aaa"));
  assert.notEqual(secretFingerprint("sk-aaa"), secretFingerprint("sk-bbb"));
  assert.equal(secretFingerprint("sk-aaa").length, 16);
  assert.match(secretFingerprint("sk-aaa"), /^[0-9a-f]{16}$/);
});

test("指纹比较是恒定时间的等值判断", () => {
  assert.ok(fingerprintsEqual("abc", "abc"));
  assert.ok(!fingerprintsEqual("abc", "abd"));
  assert.ok(!fingerprintsEqual("abc", "abcd"), "长度不同应返回 false 而不抛错");
});

test("脱敏保留首尾特征，超短密钥全掩码", () => {
  assert.equal(maskSecret("sk-live-abcdef123456"), "sk-***3456");
  assert.equal(maskSecret("short"), "****");
  assert.equal(maskSecret("tiny"), "****");
  assert.ok(!maskSecret("sk-live-abcdef123456").includes("live"), "脱敏串不得包含中段明文");
});
