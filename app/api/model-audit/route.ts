import audit from "../../../data/analysis/prediction-history-audit.json";
import {getPublishedCalibration,MIN_TEMPERATURE_CALIBRATION_MATCHES} from "../../calibration-service";
import {MODEL_PROMOTION_POLICY} from "../../model-evaluation.js";
import {compatibleCalibration} from "../../prediction-model.js";
import {MODEL_WEIGHTS} from "../../prediction-config";

export const dynamic="force-dynamic";

export async function GET(){
 const candidateCalibration=await getPublishedCalibration();
 const calibration=compatibleCalibration(candidateCalibration)&&Number(candidateCalibration?.calibrationSampleSize)>=MIN_TEMPERATURE_CALIBRATION_MATCHES?candidateCalibration:null;
 return Response.json({
  audit,
  generatedAt:new Date().toISOString(),
  auditMode:"bundled_history_plus_live_browser_evaluation",
  calibration,
  activeIntelligenceWeight:MODEL_WEIGHTS.intelligence,
  promotionPolicy:MODEL_PROMOTION_POLICY,
  safeguards:{
   officialIdentity:"active",
   immutableSnapshots:"active_for_v2",
   marketBaselineComparison:"historical_unpaired_diagnostic_and_frozen_paired_research",
   intelligenceNumericGate:"evidence_only_weight_zero",
   dixonColes:calibration&&Number(calibration.trainingSampleSize)>=20&&calibration.global?.lowScoreRho?"validated":"shadow_only",
   automaticPromotion:"disabled",
   rollbackGuard:"not_automated_manual_review_required",
  },
 },{headers:{"Cache-Control":"no-store, max-age=0"}});
}
