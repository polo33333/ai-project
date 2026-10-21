'use strict';
const fs=require('node:fs');
const dir='artifacts/ipms-capability-v2-191026';
const read=n=>JSON.parse(fs.readFileSync(`${dir}/${n}`,'utf8'));
const chats=read('latest-chat-candidates.private.json').slice(0,7).reverse();
const runs=read('latest-chat-workflows.private.json').filter(r=>r.createdAt.startsWith('2026-10-19'));
const oracle=read('latest-chat-oracle.private.json');
const ids=['Q-001','Q-002','Q-003','Q-004','Q-005','Q-005','Q-006'];
const notes=[
 'Đủ 3 mã/tên/trạng thái active, khớp oracle. Có lỗi JOIN ở lần thử đầu nhưng đã tự sửa và trả đúng kết quả cuối.',
 'Truy vấn IsActive = 0 trả rỗng đúng oracle; không bịa khách hàng inactive. Nguồn hiện không có IsActive NULL.',
 'Nhóm 1 có 2 khách, nhóm 64 có 1; tổng 3 đúng. Chưa có mapping tên nhóm được xác minh nên không tự gán tên.',
 'Workflow SUCCEEDED, trả đúng khách hàng, ngày ký và thời hạn của 05/HĐ.LG.2023. Tuy nhiên binding dùng ContractNo LIKE và OR CustomerName, chưa đạt tiêu chí lọc chính xác ContractNo. Dữ liệu snapshot đúng nhưng chưa PASS toàn bộ tiêu chí.',
 'Workflow SUCCEEDED nhưng tìm KA0021 theo số hợp đồng/tên khách hàng và trả 0 dòng; oracle có 4 hợp đồng thuộc CustomerID 4. Không lấy SUCCEEDED làm PASS.',
 'Lần lặp lại vẫn trả 0 hợp đồng trong workflow, trái oracle có 4 hợp đồng của KA0021.',
 'SQL chỉ truy vấn khoảng tương lai và trả rỗng; bỏ yêu cầu tách 3 hợp đồng đã hết hạn. Cận trên dùng 19/11 thay mốc 30 ngày 18/11; không trả EndDate để đối chiếu.'
];
const records=chats.map((a,i)=>{
 const workflow=i>=3&&i<=5?runs.find(r=>new Date(r.createdAt).toISOString().slice(11,19)===[ '12:12:46','12:13:46','12:14:16'][i-3]):null;
 if(i>=3&&i<=5&&!workflow)throw Error('Missing workflow evidence '+a.id);
 return {id:a.id,testcaseId:ids[i],timestamp:a.timestamp,question:a.question,verdict:i<3?'PASS':'FAIL',dataCorrect:i<4,notes:notes[i],reply:a.replyText,sql:a.sqlQuery,workflow:workflow?{id:workflow.id,status:workflow.status,input:workflow.input,result:workflow.result,sql:workflow.definition?.bindings?.contract?.sql}:null,usage:a.requestPayload.tokenUsage};
});
const baseline=read('report.json');
const counts={...baseline.statusCounts};
const latestByCase=Object.fromEntries(records.map(r=>[r.testcaseId,r]));
for(const [id,r]of Object.entries(latestByCase)){const prior=baseline.cases.find(c=>c.id===id).capabilityStatus;if(prior!==r.verdict){counts[prior]--;counts[r.verdict]=(counts[r.verdict]||0)+1;}}
const usage=records.reduce((s,r)=>{for(const key of ['inputTokens','outputTokens','totalTokens','calls'])s[key]=(s[key]||0)+r.usage[key];return s},{});
const result={checkedAt:new Date().toISOString(),window:'19/10/2026 19:10:24–19:14:59 Asia/Saigon',scope:'7 lượt chat mới nhất, cùng một session người dùng thật; Q-005 lặp 2 lần. Không gọi lại AI, không sửa engine. PASS cập nhật là theo lần quan sát mới, không chứng minh đã ổn định ở cả hai chế độ.',records,observedPass:3,observedFail:4,distinctCases:6,updatedCounts:counts,baselineCounts:baseline.statusCounts,usage,oracle,estimatedUSD:{visibleOnly:(usage.inputTokens*.30+usage.outputTokens*2.50)/1e6,includingResidual:(usage.inputTokens*.30+(usage.totalTokens-usage.inputTokens)*2.50)/1e6}};
fs.writeFileSync(`${dir}/latest-seven-review.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({pass:result.observedPass,fail:result.observedFail,updatedCounts:counts,usage,cost:result.estimatedUSD}));
