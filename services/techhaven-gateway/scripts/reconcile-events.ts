/** Compare gateway JSONL spool with PostgreSQL authoritative session/event rows. */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import pg from "pg";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    url: { type: "string" },
    schema: { type: "string" },
  },
});
const file = values.file ?? "./data/gateway.jsonl";
const dbUrl = values.url ?? process.env.TECHHAVEN_GATEWAY_DB_URL ?? process.env.TECHHAVEN_DB_URL ?? "";
const schema = values.schema ?? process.env.TECHHAVEN_GATEWAY_DB_SCHEMA ?? "public";
if (!dbUrl) throw new Error("缺少数据库地址：--url / TECHHAVEN_GATEWAY_DB_URL / TECHHAVEN_DB_URL");
if (!existsSync(file)) throw new Error(`JSONL spool 不存在：${file}`);
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error(`PostgreSQL schema 非法：${schema}`);

interface ExpectedSession {
  status: string;
  seqs: Set<number>;
}

async function main(): Promise<void> {
  const expected = new Map<string, ExpectedSession>();
  let invalidLines = 0;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }) });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      const row = JSON.parse(raw) as Record<string, any>;
      if (typeof row.sid !== "string") {
        invalidLines += 1;
        continue;
      }
      const session = expected.get(row.sid) ?? { status: "queued", seqs: new Set<number>() };
      if (row.kind === "session" && typeof row.patch?.status === "string") session.status = row.patch.status;
      if (row.kind === "event" && Number.isInteger(row.event?.seq)) {
        session.seqs.add(row.event.seq);
        if (row.event.type === "status_change" && typeof row.event.status === "string") session.status = row.event.status;
      }
      expected.set(row.sid, session);
    } catch {
      invalidLines += 1;
    }
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema}`,
  });
  try {
    const sids = [...expected.keys()];
    const sessions = sids.length
      ? await pool.query<{ sid: string; status: string }>(
          `SELECT sid, status::text AS status FROM agent_sessions WHERE sid = ANY($1::text[])`,
          [sids],
        )
      : { rows: [] };
    const events = sids.length
      ? await pool.query<{ sid: string; seq: string }>(
          `SELECT s.sid, e.seq::text AS seq
             FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id
            WHERE s.sid = ANY($1::text[])`,
          [sids],
        )
      : { rows: [] };

    const actualStatus = new Map(sessions.rows.map((row) => [row.sid, row.status]));
    const actualSeqs = new Map<string, Set<number>>();
    for (const row of events.rows) {
      const seqs = actualSeqs.get(row.sid) ?? new Set<number>();
      seqs.add(Number(row.seq));
      actualSeqs.set(row.sid, seqs);
    }

    const missingSessions: string[] = [];
    const statusMismatches: Array<{ sid: string; spool: string; postgres: string }> = [];
    const missingEvents: Array<{ sid: string; seq: number }> = [];
    const extraEvents: Array<{ sid: string; seq: number }> = [];
    for (const [sid, source] of expected) {
      const status = actualStatus.get(sid);
      if (!status) {
        missingSessions.push(sid);
        continue;
      }
      if (status !== source.status) statusMismatches.push({ sid, spool: source.status, postgres: status });
      const actual = actualSeqs.get(sid) ?? new Set<number>();
      for (const seq of source.seqs) if (!actual.has(seq)) missingEvents.push({ sid, seq });
      for (const seq of actual) if (!source.seqs.has(seq)) extraEvents.push({ sid, seq });
    }
    const report = {
      ok:
        invalidLines === 0 &&
        missingSessions.length === 0 &&
        statusMismatches.length === 0 &&
        missingEvents.length === 0 &&
        extraEvents.length === 0,
      spoolSessions: expected.size,
      invalidLines,
      missingSessions,
      statusMismatches,
      missingEvents,
      extraEvents,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
