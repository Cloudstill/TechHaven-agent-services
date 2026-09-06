import test from "node:test";
import assert from "node:assert/strict";
import type { EngineUsage } from "../types.js";
import {
  DshSdkDriver,
  type DshHarness,
  type DshHarnessNotification,
  type DshNotificationSubscription,
  type DshSdkModule,
} from "./dsh.js";

class PendingSubscription implements DshNotificationSubscription {
  private rejectPending?: (cause: Error) => void;
  private closed = false;

  next(): Promise<DshHarnessNotification> {
    if (this.closed) return Promise.reject(new Error("closed"));
    return new Promise((_resolve, reject) => {
      this.rejectPending = reject;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending?.(new Error("closed"));
  }
}

test("每个 dsh 会话获得隔离 runtime，用户密钥不继承 Gateway ambient secrets", async () => {
  const optionsSeen: Record<string, unknown>[] = [];
  const harnesses: Array<{ closed: number }> = [];

  class FakeHarness implements DshHarness {
    private readonly subscription = new PendingSubscription();
    readonly state = { closed: 0 };
    readonly client = {
      prompt: async () => "message-id",
      subscribeSessionTree: () => this.subscription,
    };

    constructor(options: Record<string, unknown>) {
      optionsSeen.push(options);
      harnesses.push(this.state);
    }

    async start(): Promise<void> {}

    async close(): Promise<void> {
      this.state.closed += 1;
      this.subscription.close();
    }
  }

  const sdk: DshSdkModule = { DeepSeekHarness: FakeHarness };
  const previous = process.env.SECRET_THAT_MUST_NOT_LEAK;
  process.env.SECRET_THAT_MUST_NOT_LEAK = "gateway-secret";
  try {
    const driver = new DshSdkDriver({
      profile: "sdk",
      sdkLoader: async () => sdk,
    });
    const first = await driver.startSession({
      sessionId: "session-a",
      orgId: 1,
      prompt: "hello",
      runtimeConfig: {
        provider: "openai",
        model: "gpt-5",
        reasoningEffort: "high",
        maxTokens: 4096,
        env: { OPENAI_API_KEY: "key-a", OPENAI_BASE_URL: "https://provider-a.example/v1" },
      },
    });
    const second = await driver.startSession({
      sessionId: "session-b",
      orgId: 1,
      prompt: "hello again",
      runtimeConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        env: { ANTHROPIC_API_KEY: "key-b", ANTHROPIC_BASE_URL: "https://provider-b.example/v1" },
      },
    });

    assert.equal(optionsSeen.length, 2);
    assert.notEqual(optionsSeen[0], optionsSeen[1]);
    assert.equal(optionsSeen[0].provider, "openai");
    assert.equal(optionsSeen[0].model, "gpt-5");
    assert.equal(optionsSeen[0].reasoningEffort, "high");
    assert.equal(optionsSeen[0].maxTokens, 4096);
    assert.equal((optionsSeen[0].env as NodeJS.ProcessEnv).OPENAI_API_KEY, "key-a");
    assert.equal((optionsSeen[0].env as NodeJS.ProcessEnv).SECRET_THAT_MUST_NOT_LEAK, undefined);
    assert.equal(optionsSeen[1].provider, "anthropic");
    assert.equal((optionsSeen[1].env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY, "key-b");
    assert.equal((optionsSeen[1].env as NodeJS.ProcessEnv).OPENAI_API_KEY, undefined);

    await first.dispose();
    assert.equal(harnesses[0].closed, 1);
    assert.equal(harnesses[1].closed, 0);
    await second.dispose();
    assert.equal(harnesses[1].closed, 1);
    await driver.dispose();
  } finally {
    if (previous === undefined) delete process.env.SECRET_THAT_MUST_NOT_LEAK;
    else process.env.SECRET_THAT_MUST_NOT_LEAK = previous;
  }
});

test("dsh accounts final usage once per call and includes child sessions and disjoint cache tokens", async () => {
  const event = (sessionId: string, type: string, data: object): DshHarnessNotification => ({
    method: "session.event",
    params: { sessionId, event: { type, time: Date.now(), data } },
  });
  const notifications = [
    event("root", "step/start", { turn: 1, step: 1 }),
    event("root", "assistant/chunk", { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 999 } } }),
    event("root", "assistant/message", {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 7, reasoningTokens: 2 },
    }),
    event("child", "assistant/message", { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 5 } }),
    event("root", "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
  class Harness implements DshHarness {
    private pending = new PendingSubscription();
    readonly client = {
      prompt: async () => "message",
      subscribeSessionTree: () => ({
        next: async () => notifications.shift() ?? this.pending.next(),
        close: () => this.pending.close(),
      }),
    };
    async start() {}
    async close() {
      this.pending.close();
    }
  }
  const usage = new Map<string, EngineUsage>();
  const driver = new DshSdkDriver({ sdkLoader: async () => ({ DeepSeekHarness: Harness }) });
  const handle = await driver.startSession({
    sessionId: "root",
    orgId: 1,
    prompt: "test",
    runtimeConfig: {
      provider: "openai",
      model: "test",
      env: {},
      recordUsage: async (sid, key, delta) => {
        assert.equal(sid, "root");
        usage.set(key, delta);
      },
    },
  });
  try {
    for await (const e of handle.events()) if (e.type === "status_change" && e.status === "succeeded") break;
    assert.equal(usage.size, 4);
    assert.deepEqual(usage.get("tokens:root:1:1"), { promptTokens: 15, completionTokens: 7, totalTokens: 22 });
    assert.deepEqual(usage.get("tokens:child:1:1"), { promptTokens: 4, completionTokens: 5, totalTokens: 9 });
    assert.deepEqual(usage.get("request:root:1:1"), { requests: 1 });
  } finally {
    await driver.dispose();
  }
});
