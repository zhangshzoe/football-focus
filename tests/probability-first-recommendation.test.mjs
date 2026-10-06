import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRecommendation,selectRecommendationPortfolio} from '../app/recommendation-policy.js';
const leg=(id,p=30)=>({officialMatchId:id,salesDate:'2026-10-06',league:'测试',market:'had',picks:[{pick:'胜',probability:p,odd:3}]});
test('probability-first accepts negative expectation without disguising it as profit',()=>{
  const result=assessRecommendation([leg('a'),leg('b')]);
  assert.equal(result.eligible,true);
  assert.ok(result.economics.expectedProfit<0);
  assert.ok(result.sensitivity.low.expectedProfit<0);
  assert.equal(assessRecommendation([leg('a'),leg('b')],{selectionMode:'robust-ev'}).reason,'non_positive_ev');
});
test('probability priority still respects duplicate, budget and research isolation',()=>{
  const plan=(id,p)=>({id,status:'pending',stake:2,estimatedProbability:p*p/10000,items:[leg('a',p),leg('b',p)]});
  const result=selectRecommendationPortfolio([plan('low',30),plan('high',40)],{policy:{maxTickets:1}});
  assert.equal(result.plans.find(p=>p.id==='high').status,'pending');
  assert.equal(result.plans.find(p=>p.id==='low').status,'unavailable');
  assert.equal(selectRecommendationPortfolio([plan('one',30)],{policy:{dailyBudget:0}}).selected,0);
  assert.equal(assessRecommendation([{...leg('a'),market:'halfFull'}]).reason,'research_only');
  assert.equal(assessRecommendation([{...leg('a'),picks:[{pick:'胜',odd:3}]}]).eligible,false);
});
