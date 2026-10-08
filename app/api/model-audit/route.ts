import audit from "../../../data/analysis/prediction-history-audit.json";
import {getPublishedCalibration} from "../../calibration-service";
import {MODEL_PROMOTION_POLICY} from "../../model-evaluation.js";

export const dynamic="force-dynamic";

export async function GET(){
 const calibration=await getPublishedCalibration();
 return Response.json({
  audit,
  generatedAt:new Date().toISOString(),
  auditMode:"bundled_history_plus_live_browser_evaluation",
  calibration,
  promotionPolicy:MODEL_PROMOTION_POLICY,
  safeguards:{
   officialIdentity:"active",
   immutableSnapshots:"active_for_v2",
   marketBaselineComparison:"active",
   intelligenceNumericGate:calibration?.intelligenceWeightMultiplier?"validated":"shadow_only",
   dixonColes:calibration?.global?.lowScoreRho?"validated":"shadow_only",
   automaticPromotion:"disabled_until_all_gates_pass",
   rollbackGuard:"recent_50_brier_delta_gt_0.01",
  },
 },{headers:{"Cache-Control":"no-store, max-age=0"}});
}
