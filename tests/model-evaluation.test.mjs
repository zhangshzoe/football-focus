import test from "node:test";
import assert from "node:assert/strict";
import {buildModelEvaluation} from "../app/model-evaluation.js";

const points=(home,draw,away)=>[{score:"胜",probability:home},{score:"平",probability:draw},{score:"负",probability:away}];
const row=(index,fullScore,model=points(60,25,15),challenger=points(55,25,20))=>({
 key:`2026-09-${String(index+1).padStart(2,"0")}|${index}`,salesDate:"2026-09-01",kickoffAt:`2026-09-${String(index+1).padStart(2,"0")}T20:00:00+08:00`,capturedAt:`2026-09-${String(index+1).padStart(2,"0")}T19:30:00+08:00`,id:`周一${String(index+1).padStart(3,"0")}`,officialMatchId:String(index+1),league:index%2?"英超":"西甲",home:`主队${index}`,away:`客队${index}`,completeness:10,intelligenceCoverage:index%3?60:0,modelHad:model,challengerHad:challenger,marketHad:points(50,28,22),scoreDistribution:[{score:"1:0",probability:15},{score:"1:1",probability:13},{score:"2:0",probability:11}],totalGoalProbabilities:[{score:"2球",probability:27},{score:"3球",probability:22}],hhadProbabilities:[{score:"让胜",probability:45},{score:"让平",probability:30},{score:"让负",probability:25}],halfFullProbabilities:[{score:"胜胜",probability:30},{score:"平胜",probability:20}],handicap:"-1",fullScore,halfScore:"1:0"
});

test("模型实验报告使用独立比赛并计算正式、挑战、市场三组指标",()=>{
 const report=buildModelEvaluation([row(0,"1:0"),row(1,"0:1"),row(1,"0:1")]);
 assert.equal(report.sampleSize,2);
 assert.equal(report.windows.all.champion.sampleSize,2);
 assert.equal(report.windows.all.challenger.sampleSize,2);
 assert.equal(report.windows.all.market.sampleSize,2);
 assert.ok(report.windows.all.champion.brier>0);
});

test("强方向完全反转归类为过度自信，而不是合理偏差",()=>{
 const report=buildModelEvaluation([row(0,"0:2",points(62,23,15))]);
 assert.equal(report.errors.items[0].code,"overconfidence");
 assert.equal(report.errors.items[0].trainable,true);
});

test("挑战模型样本不足时禁止自动晋级",()=>{
 const report=buildModelEvaluation(Array.from({length:20},(_,index)=>row(index,index%2?"1:0":"0:1")));
 assert.equal(report.promotion.eligible,false);
 assert.equal(report.promotion.gates.find(gate=>gate.key==="sample")?.passed,false);
});
