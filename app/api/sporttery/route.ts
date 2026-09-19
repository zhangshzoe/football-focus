import {NextResponse} from "next/server";
import {fetchOfficialSporttery} from "../../sporttery-official";

export async function GET(request:Request){
 try{
  const repair=new URL(request.url).searchParams.get("repairMissing")==="1";
  const data=await fetchOfficialSporttery({repair,serverHeaders:true});
  return NextResponse.json(data,{headers:{"Cache-Control":"no-store, max-age=0"}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error?error.message:"官方数据读取失败",source:"中国体育彩票·竞彩网"},{status:502,headers:{"Cache-Control":"no-store, max-age=0"}});
 }
}
