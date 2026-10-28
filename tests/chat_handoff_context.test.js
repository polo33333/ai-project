'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalize,withHandoff}=require('../src/backend/services/chat_request_context');
const {createRequestPlan}=require('../src/backend/training/request_planner');
const context='Công việc cũ: vẽ biểu đồ sản lượng điện 12 tháng, xuất file Excel. Nhân viên NV007 đã từng được nhắc đến.';
const legacy=question=>'Ngữ cảnh bàn giao từ hội thoại trước:\n'+context+'\n\nCâu hỏi hiện tại:\n'+question;
test('new handoff stays separate from current lookup requirements',()=> {
  const request=normalize({question:'chi tiết nv nv007',continuationContext:context,history:[]});
  const plan=createRequestPlan({question:request.question});
  assert.equal(request.question,'chi tiết nv nv007'); assert.equal(request.continuationContext,context);
  assert.equal(plan.outputs.data,true); assert.equal(plan.outputs.chart,false); assert.equal(plan.outputs.export,false);
});
test('old clients and persisted history no longer inject summary tasks into the current question',()=> {
  const request=normalize({question:legacy('chi tiết nv nv007'),history:[{role:'user',content:legacy('hi')},{role:'assistant',content:'Hello'}]});
  assert.equal(request.question,'chi tiết nv nv007'); assert.equal(request.message,request.question);
  assert.equal(request.continuationContext,context); assert.equal(request.history[0].content,'hi');
  const plan=createRequestPlan({question:request.question});
  assert.equal(plan.outputs.chart,false); assert.equal(plan.outputs.export,false);
});
test('handoff reaches model as historical context while keeping the latest user question intact',()=> {
  const input=[{role:'system',content:'System'},{role:'user',content:'chi tiết nv nv007'}];
  const output=withHandoff(input,context);
  assert.equal(output.length,3); assert.equal(output[1].role,'assistant');
  assert.ok(output[1].content.includes(context)); assert.deepEqual(output.at(-1),input.at(-1));
  assert.equal(input.length,2); assert.equal(withHandoff(input,''),input);
});
test('a current chart request remains a chart request after legacy normalization',()=> {
  const request=normalize({question:legacy('vẽ biểu đồ doanh thu theo tháng')});
  assert.equal(createRequestPlan({question:request.question}).outputs.chart,true);
});
