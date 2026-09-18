import {NextRequest,NextResponse} from "next/server";
import {getPublishedCalibration,publishCalibration,type CalibrationObservation} from "../../calibration-service";

export const dynamic="force-dynamic";
export async function GET(){return NextResponse.json({profile:await getPublishedCalibration()},{headers:{"Cache-Control":"no-store, max-age=0"}})}
export async function POST(request:NextRequest){
 try{const body=await request.json(),observations=Array.isArray(body?.observations)?body.observations.slice(0,5000) as CalibrationObservation[]:[];const result=await publishCalibration(observations);return NextResponse.json(result,{headers:{"Cache-Control":"no-store, max-age=0"}})}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"校准评估失败"},{status:400})}
}
