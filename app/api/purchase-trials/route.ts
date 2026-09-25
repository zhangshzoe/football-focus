import { env } from "cloudflare:workers";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { PURCHASE_PLAN_DEFINITIONS } from "../../purchase-plan-engine.js";

export const dynamic = "force-dynamic";

type Trial = {
  snapshotId: string;
  date: string;
  generatedAt: string;
  source: string;
  plans: Array<{
    id: string;
    status: string;
    items: Array<{ officialMatchId?: string; odd?: number; picks?: Array<{ odd?: number }> }>;
  }>;
};

const knownPlans = new Set(PURCHASE_PLAN_DEFINITIONS.map((definition) => definition.id));
const localDirectory = join(process.cwd(), "data", "saved-purchase-trials");
const jsonHeaders = { "Cache-Control": "no-store, max-age=0" };
type TrialDatabase = {
  prepare(sql: string): {
    bind(...values: string[]): {
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
};
// The desktop dev server does not apply Sites migrations to its local D1.
// Keep development records in an ignored file; production uses migrated D1.
const database = () =>
  process.env.NODE_ENV === "production" ? (env.DB as TrialDatabase | undefined) : undefined;

function accountId(request: Request) {
  return (
    request.headers.get("oai-authenticated-user-id") ||
    (process.env.NODE_ENV !== "production" ? "local-dev" : "")
  );
}

function validTrial(value: unknown): value is Trial {
  if (!value || typeof value !== "object") return false;
  const trial = value as Trial;
  if (
    !/^manual-trial-[0-9a-f-]{36}$/.test(trial.snapshotId || "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(trial.date || "") ||
    !Number.isFinite(Date.parse(trial.generatedAt || "")) ||
    !Array.isArray(trial.plans) ||
    trial.plans.length > knownPlans.size ||
    !trial.plans.some((plan) => plan.status !== "unavailable" && plan.items?.length)
  )
    return false;
  return trial.plans.every(
    (plan) =>
      knownPlans.has(plan.id) &&
      ["pending", "unavailable"].includes(plan.status) &&
      Array.isArray(plan.items) &&
      plan.items.length <= 8 &&
      plan.items.every(
        (item) =>
          Boolean(item.officialMatchId) &&
          (item.picks || [{ odd: item.odd }]).every(
            (pick) => Number.isFinite(Number(pick.odd)) && Number(pick.odd) > 0,
          ),
      ),
  );
}

async function readLocal(userId: string): Promise<Trial[]> {
  try {
    const files = (await readdir(localDirectory)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(
      files.map(async (name) => {
        try {
          const record = JSON.parse(await readFile(join(localDirectory, name), "utf8"));
          return record.userId === userId ? (record.trial as Trial) : null;
        } catch {
          return null;
        }
      }),
    );
    return records
      .filter((record): record is Trial => Boolean(record))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, 100);
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const userId = accountId(request);
  if (!userId)
    return NextResponse.json(
      { error: "请先登录后查看已保存试算" },
      { status: 401, headers: jsonHeaders },
    );
  try {
    let trials: Trial[];
    const db = database();
    if (db) {
      const rows = await db
        .prepare(
          "SELECT payload_json FROM saved_purchase_trials WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
        )
        .bind(userId)
        .all<{ payload_json: string }>();
      trials = (rows.results || []).map((row) => JSON.parse(row.payload_json) as Trial);
    } else if (process.env.NODE_ENV !== "production") trials = await readLocal(userId);
    else throw new Error("试算存储暂不可用");
    return NextResponse.json({ trials }, { headers: jsonHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取已保存试算失败" },
      { status: 503, headers: jsonHeaders },
    );
  }
}

export async function POST(request: Request) {
  const userId = accountId(request);
  if (!userId)
    return NextResponse.json(
      { error: "请先登录后保存试算" },
      { status: 401, headers: jsonHeaders },
    );
  try {
    const body = await request.text();
    if (body.length > 150_000) throw new Error("试算内容过大");
    const trial: unknown = JSON.parse(body);
    if (!validTrial(trial)) throw new Error("试算内容不完整或已失效");
    const normalized = { ...trial, source: "手动保存的盘口试算（非17:00正式快照）" };
    const db = database();
    if (db) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO saved_purchase_trials (id, user_id, lottery_date, created_at, payload_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          trial.snapshotId,
          userId,
          trial.date,
          new Date().toISOString(),
          JSON.stringify(normalized),
        )
        .run();
    } else if (process.env.NODE_ENV !== "production") {
      await mkdir(localDirectory, { recursive: true });
      try {
        await writeFile(
          join(localDirectory, `${trial.snapshotId}.json`),
          JSON.stringify({ userId, trial: normalized }),
          { flag: "wx" },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else throw new Error("试算存储暂不可用");
    return NextResponse.json({ trial: normalized }, { headers: jsonHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存试算失败" },
      { status: 400, headers: jsonHeaders },
    );
  }
}
