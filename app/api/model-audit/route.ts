import audit from "../../../data/analysis/prediction-history-audit.json";
import {getPublishedCalibration} from "../../calibration-service";

export const dynamic="force-dynamic";

export async function GET(){
 const calibration=await getPublishedCalibration();
 return Response.json({
  audit,
  calibration,
  safeguards:{
   officialIdentity:"active",
   immutableSnapshots:"active_for_v2",
   marketBaselineComparison:"active",
   intelligenceNumericGate:calibration?.intelligenceWeightMultiplier?"validated":"shadow_only",
   dixonColes:calibration?.global?.lowScoreRho?"validated":"shadow_only",
  },
 },{headers:{"Cache-Control":"no-store, max-age=0"}});
}
