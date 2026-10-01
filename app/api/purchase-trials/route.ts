import { env } from "cloudflare:workers";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { PURCHASE_PLAN_DEFINITIONS, PURCHASE_PLAN_VERSION } from "../../purchase-plan-engine.js";
import {assessRecommendation,normalizeRecommendationPolicy,selectRecommendationPortfolio,REJECTION_LABELS} from "../../recommendation-policy.js";
import {collectEarlierPurchasePlans} from "../../purchase-batch-policy.js";
import {readServerPurchaseHistory} from "../../server-purchase-history";

export const dynamic = "force-dynamic";

type Trial = {
  riskSelection?:{policy:Parameters<typeof normalizeRecommendationPolicy>[0]};scheduledTime?:string;version?:number;decisionSummary?:{evaluated:boolean;noBet:boolean;coverage?:{missingEligibleCount?:number}};
  snapshotId: string;
  date: string;
  generatedAt: string;
  source: string;
  plans: Array<{
    id: string;
    status: string;
    stake?: number;
    betCount?: number;
    items: Array<{ officialMatchId?: string; salesDate?: string; market?: string; odd?: number; picks?: Array<{ pick?: string; probability?: number; odd?: number }> }>;
  }>;
};

const knownPlans = new Set(PURCHASE_PLAN_DEFINITIONS.map((definition) => definition.id));
type CurrentPlanDefinition = { id:string;matches:number;markets:string[];selections:number;allowedPicks?:string[];
  minLegProbability?:number;mixed?:boolean;requirePositiveMinProfit?:boolean;minProfitMultiplier?:number;
  targetNetProfit?:number;targetProfitTolerance?:number };
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
    (!trial.plans.some((plan) => plan.status !== "unavailable" && plan.items?.length)&&!((trial.version||0)>=15&&trial.decisionSummary?.evaluated&&trial.decisionSummary?.noBet&&trial.plans.length===knownPlans.size))
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
    // Old records stay readable through GET; new writes never select weaker
    // rules by omitting a version, and are not silently upgraded.
    if(trial.version!==PURCHASE_PLAN_VERSION)throw new Error(`仅可保存当前版本 v${PURCHASE_PLAN_VERSION} 的新试算；版本缺失或已过期，请重新试算。历史记录仍可读取。`);
    if(!["17:00","21:00"].includes(trial.scheduledTime||""))throw new Error("试算批次时点缺失或无效，须明确为17:00或21:00；不能省略21点全天额度核验。");
    const policy=normalizeRecommendationPolicy(trial.riskSelection?.policy);
    const eligible=trial.plans.filter(plan=>plan.status!=="unavailable");
    if(new Set(trial.plans.map(plan=>plan.id)).size!==trial.plans.length)throw new Error("试算包含重复类型");
    if(trial.plans.some(plan=>plan.status==="unavailable"&&plan.items.length))throw new Error("不投注类型仍含投注选项，试算内容不一致");
    if(!eligible.length&&!(trial.decisionSummary?.evaluated===true&&trial.decisionSummary.noBet===true&&trial.decisionSummary.coverage?.missingEligibleCount===0&&trial.plans.length===knownPlans.size))throw new Error("不投注试算须完整评估全部类型，且不能缺少可评估比赛或包含未核验选项");
    if(eligible.length&&trial.decisionSummary?.noBet===true)throw new Error("不投注声明与原票不一致");
    for(const plan of eligible){
      if(plan.items.some(item=>Object.hasOwn(item,"scores")))throw new Error("冻结选项须使用picks，不能提供改变收益计算的scores别名。");
      const assessment=assessRecommendation(plan.items,policy);
      if(!assessment.eligible)throw new Error(`试算票 ${plan.id} 未通过当前检查：${REJECTION_LABELS[assessment.reason as keyof typeof REJECTION_LABELS]||"收益、概率压力或玩法无效"}`);
      const money=assessment.economics;
      if(!money||money.status!=="ready"||typeof plan.stake!=="number"||!Number.isFinite(plan.stake)||Math.abs(plan.stake-money.totalStake)>1e-8||plan.betCount!==money.betCount)throw new Error(`试算票 ${plan.id} 的冻结投入或注数与原选项不一致，请重新试算。`);
      const definition=PURCHASE_PLAN_DEFINITIONS.find(item=>item.id===plan.id)! as CurrentPlanDefinition;
      if(plan.items.length!==definition.matches||plan.items.some(item=>!definition.markets.includes(item.market||"")||item.picks?.length!==definition.selections||item.salesDate!==trial.date))throw new Error(`试算票 ${plan.id} 的场数、玩法、选项数或销售日期与当前类型不一致。`);
      const selectedPicks=plan.items.map(item=>item.picks!);
      const allowedPicks=definition.allowedPicks;
      if(allowedPicks&&selectedPicks.some(picks=>picks.some(pick=>!allowedPicks.includes(pick.pick||""))))throw new Error(`试算票 ${plan.id} 的选项不属于当前类型允许的选项。`);
      if(selectedPicks.some(picks=>picks.reduce((sum,pick)=>sum+Number(pick.probability),0)<(Number(definition.minLegProbability)||0)))throw new Error(`试算票 ${plan.id} 的单场选项合计概率低于当前类型门槛。`);
      if(definition.mixed&&new Set(plan.items.map(item=>item.market)).size<2)throw new Error(`试算票 ${plan.id} 的混合类型须至少包含2种玩法。`);
      if(money.minWinningProfit<0)throw new Error(`试算票 ${plan.id} 的最低命中净利不能为负。`);
      if(definition.requirePositiveMinProfit&&money.minWinningProfit<=0)throw new Error(`试算票 ${plan.id} 的最低命中净利须为正。`);
      if(money.minWinningProfit+1e-9<(Number(definition.minProfitMultiplier)||0)*money.totalStake)throw new Error(`试算票 ${plan.id} 的最低命中净利未达到投入倍数门槛。`);
      const target=Number(definition.targetNetProfit),tolerance=Math.max(0,Number(definition.targetProfitTolerance)||0);
      if(Number.isFinite(target)&&(money.minWinningProfit<=0||money.minWinningProfit+tolerance<target))throw new Error(`试算票 ${plan.id} 的最低命中净利未达到目标。`);
    }
    const earlier=trial.scheduledTime==="21:00"?collectEarlierPurchasePlans((await readServerPurchaseHistory()).map(record=>({...record.planSet,snapshotId:record.snapshotId})),trial.date):{status:"verified",plans:[]};
    if(trial.scheduledTime==="21:00"&&earlier.status!=="verified")throw new Error("早批次投入记录缺失或冲突，无法核验全天额度");
    // Validate the exact original tickets, not cheaper candidate alternatives.
    const selection=selectRecommendationPortfolio(eligible.map(plan=>({...plan,candidateAlternatives:[]})),{policy,priorPlans:trial.scheduledTime==="21:00"?earlier.plans:[]});
    if(selection.priorState!=="verified")throw new Error("早批次金额、身份或选项无法核验，未保存试算");
    if(selection.selected!==eligible.length)throw new Error(`试算未通过每日模拟额度与重叠检查：${Object.values(selection.rejected||{}).map(row=>row&&typeof row==="object"&&"reason" in row?String(row.reason):"未知额度限制").join("；")}`);
    const normalized = { ...trial, source: "手动保存的盘口试算（非固定时刻正式快照）" };
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
