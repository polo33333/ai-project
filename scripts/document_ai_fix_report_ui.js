module.exports = String.raw`
const FU=D.fixUpdates, fixMap=new Map(FU.cases.map(item=>[item.id,item]));
const fixSection=document.createElement('section');fixSection.className='panel';fixSection.id='fix-updates';
fixSection.innerHTML='<h2>Cập nhật các bản sửa · 15/10/2026</h2><p>'+E(FU.note)+'</p><p><b>3 ca đã sửa và xác minh lại; 1 ca đã sửa lỗi chính, còn tiêu chí chưa hoàn tất.</b> Trạng thái bên dưới là kết quả sau sửa; số liệu baseline tiếp tục được giữ nguyên để đối chiếu.</p><div class="scroll"><table><thead><tr><th>Ca</th><th>Trạng thái sau sửa</th><th>Thay đổi và kết quả</th><th>Giới hạn xác minh</th></tr></thead><tbody>'+FU.cases.map(f=>'<tr><td><a href="#'+f.id+'">'+f.id+'</a></td><td><span class="badge '+(f.status==='VERIFIED'?'PASS':'REVIEW')+'">'+E(f.label)+'</span></td><td>'+E(f.change)+'<p>'+E(f.outcome)+'</p></td><td>'+E(f.scope)+'</td></tr>').join('')+'</tbody></table></div><h3>Các thay đổi dùng chung</h3>'+FU.shared.map(f=>'<p><b>'+E(f.name)+' — '+E(f.status)+'</b><br>'+E(f.detail)+'</p>').join('')+'<details><summary>Bằng chứng chạy lại đầy đủ</summary><pre>'+E(J(FU))+'</pre></details><p class="muted">Đóng gói cập nhật: '+E(dt(Date.parse(FU.updatedAt)))+' (UTC+7). capturedAt là thời điểm file bằng chứng được ghi, không phải thời điểm bắt đầu request.</p>';
$('metrics').after(fixSection);
const baselineHeading=document.createElement('p');baselineHeading.className='muted';baselineHeading.textContent='Các số liệu và đánh giá bên dưới là baseline trước sửa. Trạng thái sau sửa xem ở phần cập nhật và từng ca.';fixSection.after(baselineHeading);
const fixSelect=document.createElement('select');fixSelect.id='fix-status';fixSelect.setAttribute('aria-label','Lọc trạng thái sửa');fixSelect.innerHTML='<option value="">Tất cả trạng thái sửa</option><option value="VERIFIED">Đã sửa và xác minh lại</option><option value="PARTIAL">Đã sửa một phần</option><option value="PENDING">Chưa có bằng chứng chạy lại</option>';$('export').before(fixSelect);
function decorateFixUpdates(){
 let shown=0;
 document.querySelectorAll('article').forEach(article=>{
  const f=fixMap.get(article.id), wanted=fixSelect.value;
  article.hidden=Boolean(wanted&&(wanted==='PENDING'?Boolean(f):f?.status!==wanted));
  if(!article.hidden)shown++;
  if(f&&!article.querySelector('[data-fix-update]')){
   const box=document.createElement('div');box.dataset.fixUpdate='true';box.className='notice';
   box.innerHTML='<b>Trạng thái sau sửa: '+E(f.label)+'</b><p>'+E(f.outcome)+'</p><p class="muted">'+E(f.scope)+'</p><details><summary>Câu trả lời và bằng chứng chạy lại</summary>'+f.evidence.map(ev=>'<h3>'+E(ev.file)+'</h3><p>HTTP '+E(ev.http)+' · Pipeline '+E(ev.result?.completionStatus)+' · Audit '+E(ev.result?.auditId)+'</p><pre>'+E(ev.result?.reply)+'</pre><details><summary>Phản hồi API đầy đủ</summary><pre>'+E(J(ev))+'</pre></details>').join('')+'</details>';
   article.querySelector('.question').after(box);
  }
 });
 $('shown').textContent='Hiển thị '+shown+' / 63 ca · Bộ lọc kết quả dùng nhãn baseline; bộ lọc trạng thái sửa dùng bằng chứng chạy lại.';
}
['search','status','group'].forEach(id=>$(id).addEventListener('input',decorateFixUpdates));fixSelect.addEventListener('input',()=>{render();decorateFixUpdates()});decorateFixUpdates();
`;
