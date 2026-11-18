const SHAPE_INFO = {
  workflow: {letter:'A', name:'Workflow', tagline:'Luồng cố định bằng code', description:'Các bước Python chạy theo thứ tự cố định: đọc claim → đọc order → tính quote → gọi host. Ít tự chủ, dễ dự đoán và tiết kiệm model call.', flow:['Claim','Order','Quote','Host']},
  single: {letter:'B', name:'Single agent', tagline:'Một agent trong vòng ReAct', description:'Agent lặp suy nghĩ, chọn tool đọc và quan sát kết quả (tối đa 8 bước). Sau vòng lặp, code mới gửi quote đến host.', flow:['Decide','Read tool','Observe','Host']},
  orchestrator: {letter:'C', name:'Orchestrator', tagline:'Điều phối + investigator', description:'Orchestrator lập kế hoạch rồi gửi handoff đã lọc field cho investigator chỉ đọc. Quyền ghi refund vẫn ở orchestrator qua host.', flow:['Plan','Handoff','Investigate','Host']},
  swarm: {letter:'D', name:'Swarm', tagline:'Nhiều peer trao đổi', description:'Nhiều lượt model trao đổi trước khi điều tra và quyết định. Bản tham chiếu cố ý tin số ngày trong ticket ở seed 55.', flow:['Peers','Handoff','Investigate','Host']}
};
const FLOW_LANES = {
  workflow: [
    ['Claim view','code','Đọc claim qua get_claim_view; thiếu order_id thì trả needs_info.'],
    ['Lookup order','tool','Kiểm order có tồn tại và thuộc đúng principal; sai scope thì escalated.'],
    ['Compute quote','code','Tính entitlement từ order và policy hiện hành; bỏ qua số ngày trong ticket.'],
    ['Host gate','host','Nếu quote dương, issue_refund kiểm approval, trần theo đơn và idempotency.'],
    ['Decision','code','Trả resolved, denied, needs_info hoặc escalated theo kết quả.'],
  ],
  single: [
    ['Claim view','tool','Agent nhận các định danh claim được phép đọc.'],
    ['ReAct loop','model','Model quyết định tool đọc tiếp theo, quan sát kết quả rồi lặp tối đa 8 bước.'],
    ['Read tools','tool','Lần lượt lookup_order, lookup_refund_history và compute_compensation.'],
    ['Host gate','host','Sau vòng lặp, code chuyển full quote vào issue_refund; model không ghi ledger.'],
    ['Decision','code','Code đối chiếu kết quả host để trả trạng thái cuối.'],
  ],
  orchestrator: [
    ['Claim + plan','model','Orchestrator đọc claim đã lọc và dùng một model call để lập kế hoạch.'],
    ['Handoff v1','code','Code tạo gói handoff theo allowlist; không chuyển secret, header hay quyền ghi.'],
    ['Investigator','worker','Investigator chỉ dùng tool đọc để kiểm order, policy và quote.'],
    ['Host gate','host','Orchestrator nhận quote và tự gọi issue_refund qua host.'],
    ['Decision','code','Orchestrator trả quyết định sau khi host duyệt hoặc từ chối.'],
  ],
  swarm: [
    ['Claim + peers','model','Swarm đọc ticket, gọi peer và parse để trao đổi thông tin.'],
    ['Handoff v1','code','Tạo handoff đã lọc và giới hạn investigator ở tool đọc.'],
    ['Investigator','worker','Investigator đọc order, policy và tính quote từ dữ liệu DB.'],
    ['Peer override?','model','Điểm yếu cố ý: với seed chia hết cho 5, số ngày trong ticket có thể ghi đè order.'],
    ['Host gate','host','Swarm đưa quote vào host để kiểm approval và ghi ledger.'],
    ['Decision','code','Trả trạng thái cuối; ở T02/seed 55 có thể lệch đáp án.'],
  ],
};
const ACTOR_NAMES={code:'Code',model:'Model',tool:'Tool đọc',worker:'Investigator',host:'Host gate'};
const statusVi={resolved:'Đã hoàn',denied:'Từ chối',needs_info:'Cần thêm thông tin',escalated:'Chuyển xử lý',failed:'Lỗi'};
const vnd=n=>new Intl.NumberFormat('vi-VN').format(n||0)+' ₫';
const cost=n=>new Intl.NumberFormat('vi-VN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n||0)+' ₫';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let cases=[],selected=null,lastRuns=[],reports=null,activeReport='overview',predictionRevealed=false;
const $=id=>document.getElementById(id);

function renderGuide(){
  $('shapeGuide').innerHTML=Object.entries(SHAPE_INFO).map(([id,s])=>`<article class="shape-card"><span class="number">SHAPE ${s.letter} / ${id.toUpperCase()}</span><h3>${s.name}</h3><div class="tagline">${s.tagline}</div><p>${s.description}</p><div class="mini-flow">${s.flow.map((step,i)=>`${i?'<b>→</b>':''}<span>${step}</span>`).join('')}</div></article>`).join('');
  $('shapeChecks').innerHTML=Object.entries(SHAPE_INFO).map(([id,s])=>`<label class="shape-check"><input type="checkbox" value="${id}" checked>${s.letter} · ${s.name}</label>`).join('');
}
function renderCases(){
  const q=$('caseSearch').value.trim().toLowerCase();
  $('caseList').innerHTML=cases.filter(c=>`${c.id} ${c.title} ${c.claim_id}`.toLowerCase().includes(q)).map(c=>`<button class="case-item ${c.id===selected?.id?'active':''}" type="button" role="option" aria-selected="${c.id===selected?.id}" data-id="${c.id}"><b>${c.id}</b><span>${esc(c.title)}</span></button>`).join('');
  $('caseList').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>selectCase(b.dataset.id)));
}
function selectCase(id){
  selected=cases.find(c=>c.id===id); if(!selected)return;
  renderCases(); $('caseTitle').textContent=selected.title; $('caseSubtitle').textContent=`${selected.claim_id} · ${selected.order_id||'Chưa có mã đơn'}`;
  $('caseCode').textContent=selected.id; $('ticket').textContent=selected.ticket;
  const o=selected.order;
  $('orderFacts').textContent=o?`${o.status} · trễ ${o.delay_days} ngày · ship ${vnd(o.shipping_fee_vnd)} · hỏng xác minh: ${o.damage_verified?'có':'không'}`:selected.order_id?'Order không hiển thị cho principal này':'Chưa có order_id';
  const a=selected.approval;
  $('approvalFacts').textContent=a?`${a.status} · duyệt ${vnd(a.approved_vnd)} · hạn ${a.expires_at}`:'Không có approval';
  $('expectedFacts').textContent='Ẩn đến khi bạn chốt dự đoán.';
  predictionRevealed=false;$('predictionStatus').value='';$('predictionQuote').value='';$('predictionRefund').value='';
  $('revealButton').disabled=false;$('revealButton').textContent='Chốt dự đoán & xem đáp án';
  $('predictionFeedback').hidden=true;$('predictionFeedback').classList.remove('correct');$('calculation').hidden=true;$('runButton').disabled=true;
  $('message').textContent='Dự đoán kết quả rồi chạy demo để xem dữ liệu đi qua từng shape.';$('message').className='message';$('results').innerHTML='';lastRuns=[];
}
function initPrediction(){
  const card=document.querySelector('.config-card');
  const panel=document.createElement('section');panel.className='prediction-panel';
  panel.innerHTML=`<div class="prediction-heading"><span class="field-label">THỬ SUY LUẬN</span><h4>Dự đoán trước khi xem đáp án</h4><p>Dựa vào order và approval, đoán quyết định, quote đầy đủ và số tiền thực ghi.</p></div><div class="prediction-fields"><label>Quyết định<select id="predictionStatus"><option value="">Chọn trạng thái…</option>${Object.entries(statusVi).filter(([key])=>key!=='failed').map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><label>Quote (₫)<input id="predictionQuote" type="number" min="0" step="1000" placeholder="Ví dụ: 35000"></label><label>Refund ghi thật (₫)<input id="predictionRefund" type="number" min="0" step="1000" placeholder="Ví dụ: 20000"></label></div><button id="revealButton" class="reveal-button" type="button">Chốt dự đoán & xem đáp án</button><div id="predictionFeedback" class="prediction-feedback" role="status" aria-live="polite" hidden></div><div id="calculation" class="calculation" hidden></div>`;
  card.querySelector('.fact-grid').after(panel);
  $('revealButton').addEventListener('click',revealPrediction);
}
function calculationHtml(c){
  const x=c.calculation,e=c.expected;
  if(!x)return `<h4>Vì sao dừng ở đây?</h4><p>${c.order_id?'Principal không được xem order này hoặc order không tồn tại; chuyển xử lý, không tính quote.':'Thiếu order_id có cấu trúc; cần hỏi thêm, không lấy mã đơn từ ticket.'}</p>`;
  const parts=x.parts||{},ship=parts['SHIP-LATE-03']||0,damage=parts['DMG-04']||0;
  const orderRoom=Math.max(0,x.quote_vnd-x.prior_refund_vnd);
  const paidRoom=Math.max(0,x.paid_vnd-x.prior_refund_vnd);
  const approvalReasons={missing_approval:'thiếu approval',approval_claim_mismatch:'approval thuộc claim khác',approval_expired:'approval đã hết hạn',non_positive_amount:'hạn mức không dương'};
  const approval=x.approval_ok?`Hợp lệ · giới hạn ${vnd(x.approval_limit_vnd)}`:`Không hợp lệ (${approvalReasons[x.approval_reason]||esc(x.approval_reason)}) · host không ghi refund`;
  const rows=[
    ['Nguồn sự thật',`Order và policy hiện hành tại ${esc(x.as_of)}; ticket không quyết số ngày hay số tiền.`],
    ['Hai quyền lợi',`Giao trễ: ${vnd(ship)} · hỏng xác minh: ${vnd(damage)}. Chọn số lớn hơn, không cộng.`],
    ['Quote đầy đủ',`${vnd(x.quote_vnd)} = max(${vnd(ship)}, ${vnd(damage)})`],
    ['Đã hoàn trên cùng đơn',`${vnd(x.prior_refund_vnd)} · còn theo entitlement: ${vnd(orderRoom)}`],
    ['Approval',approval],
    ['Giới hạn tiền đã trả',`${vnd(x.paid_vnd)} đã trả · còn ${vnd(paidRoom)} sau các refund trước`],
    ['Refund thực ghi',x.quote_vnd===0?'0 ₫ · không có quyền lợi theo policy hiện hành':!x.approval_ok?'0 ₫ · approval không qua cổng host':`${vnd(e.refund_vnd)} = min(${vnd(orderRoom)}, ${vnd(x.approval_limit_vnd)}, ${vnd(paidRoom)})`]
  ];
  return `<h4>Phép tính theo dữ liệu đáng tin</h4><ol>${rows.map(([label,value])=>`<li><b>${label}</b><span>${value}</span></li>`).join('')}</ol><p class="calculation-note">Quote luôn là quyền lợi đầy đủ; host trừ refund cũ và áp các giới hạn khi ghi ledger.</p>`;
}
function revealPrediction(){
  if(predictionRevealed)return;
  const status=$('predictionStatus').value,quote=$('predictionQuote').value,refund=$('predictionRefund').value;
  if(!status||quote===''||refund===''||![quote,refund].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>=0)){$('predictionFeedback').hidden=false;$('predictionFeedback').textContent='Hãy nhập đủ trạng thái, quote và refund là số nguyên không âm.';return}
  const e=selected.expected,correct=status===e.status&&Number(quote)===e.proposal_amount&&Number(refund)===e.refund_vnd;
  predictionRevealed=true;$('expectedFacts').textContent=`${statusVi[e.status]} · quote ${vnd(e.proposal_amount)} · refund ${vnd(e.refund_vnd)}`;
  $('predictionFeedback').hidden=false;$('predictionFeedback').textContent=correct?'✓ Bạn dự đoán đúng cả ba mục.':'Dự đoán chưa khớp hoàn toàn. Xem từng bước tính bên dưới.';
  $('predictionFeedback').classList.toggle('correct',correct);$('calculation').innerHTML=calculationHtml(selected);$('calculation').hidden=false;$('runButton').disabled=false;
  $('revealButton').disabled=true;$('revealButton').textContent='Đã mở đáp án';
}
function story(run){
  const s=run.shape,r=run.result,events=run.trace.map(e=>e.kind);
  if(selected.id==='T02'&&s==='swarm'&&+$('seed').value===55)return 'Swarm tin số ngày trễ trong ticket và ghi đè dữ liệu order. Trace có model_override; kết quả lệch đáp án chuẩn. Đây là điểm yếu cố ý của shape tham chiếu.';
  if(selected.id==='T11')return 'Shape được gọi hai lần trên cùng SQLite store. So sánh hai pha bên dưới: ledger vẫn chỉ có một dòng refund nhờ idempotency key.';
  if(selected.id==='T12')return 'Lần đầu crash ngay sau khi ghi effect, trước checkpoint. Chạy lại cùng store cho thấy ledger và audit không bị nhân đôi.';
  if(s==='workflow')return 'Code đi theo chuỗi bước cố định; quote được tính từ order và policy rồi đưa qua host gate.';
  if(s==='single')return 'Agent chọn các tool đọc trong vòng ReAct; quyết định ghi tiền vẫn qua host sau vòng lặp.';
  if(s==='orchestrator')return 'Orchestrator gửi handoff đã lọc cho investigator. Investigator chỉ đọc; orchestrator gọi host gate.';
  return events.includes('model_override')?'Swarm trao đổi giữa các peer và đã thay số ngày từ ticket.':'Swarm dùng nhiều lượt model và investigator trước khi gọi host gate.';
}
function eventGuide(event){
  const p=event.payload||{};
  switch(event.kind){
    case 'claim':case 'claim_view':return ['Code / Tool đọc','Đọc claim',p.found===false?'Không tìm thấy claim; dừng xử lý.':'Lấy định danh và order_id được phép dùng, chưa quyết định tiền.'];
    case 'lookup_order':return ['Tool đọc','Kiểm đơn hàng',p.visible===false?'Order không hiển thị cho principal; không được dùng dữ liệu của đơn.':'Kiểm đơn tồn tại và thuộc người yêu cầu.'];
    case 'handoff':return ['Code','Giao việc có lọc dữ liệu','Chỉ gửi các field trong allowlist và tool đọc cho investigator; không chuyển quyền ghi tiền.'];
    case 'investigator':return ['Investigator','Điều tra bằng tool đọc','Đối chiếu order với policy và tính quote; investigator không ghi ledger.'];
    case 'react':return ['Model','Kết thúc vòng ReAct',`Agent dừng vì ${esc(p.stopped||'đã có kết quả')}; code xử lý quote và ghi tiền sau vòng lặp.`];
    case 'model_override':return ['Model','Ticket ghi đè order',`Swarm dùng ${esc(p.delay_days)} ngày từ ticket thay cho order. Đây là điểm yếu có chủ ý ở seed 55.`];
    case 'quote':return ['Code / Tool đọc','Tính quote',`Quyền lợi đầy đủ là ${vnd(p.amount_vnd||0)} theo order và policy; chưa phải tiền đã ghi.`];
    case 'issue_refund':case 'write_attempt':return ['Code → Host','Yêu cầu hoàn tiền',`Shape gửi quote ${vnd(p.proposal_amount||0)} đến host; host mới kiểm approval và trần.`];
    case 'host_result':return ['Host','Kết quả cổng ghi',p.ok?'Host chấp nhận yêu cầu và ghi ledger an toàn.':`Host từ chối: ${esc(p.reason||'không đạt điều kiện')}.`];
    case 'decision':return ['Code','Quyết định cuối',`Trả ${esc(statusVi[p.status]||p.status||'trạng thái cuối')}${p.reason?` vì ${esc(p.reason)}`:''}.`];
    case 'crash':return ['Host','Crash injection','Dừng ở điểm thử crash. Lần chạy lại dùng ledger và idempotency để tránh ghi trùng.'];
    case 'error':return ['Code','Lỗi dữ liệu',`Dừng vì ${esc(p.reason||'lỗi')}.`];
    default:return ['Trace',event.kind,'Bước được ghi trong trace; mở JSON bên dưới để xem dữ liệu đã lọc.'];
  }
}
function renderRun(run){
  const r=run.result,a=run.after.ledger,info=SHAPE_INFO[run.shape];
  const phases=run.phases.map(p=>`<div class="phase"><b>${p.name==='crash'?'Pha 1 · crash injection':'Pha 1 · lần gọi đầu'}</b> — ${p.crashed?'Crash đã kích hoạt':p.result?statusVi[p.result.status]:'Crash không kích hoạt'} · ledger ${p.state.ledger.refund_count} dòng, ${vnd(p.state.ledger.refund_vnd)}</div>`).join('');
  const events=run.trace.map((e,i)=>{const [actor,title,description]=eventGuide(e);return `<div class="event"><span class="event-actor">${esc(actor)}</span><b>${i+1}. ${esc(title)}</b><p>${description}</p><details><summary>Xem JSON của bước</summary><pre>${esc(JSON.stringify(e.payload,null,2))}</pre></details></div>`}).join('');
  const audits=run.after.audits.length?run.after.audits.map(x=>`<div class="phase">${esc(x.event_type)} · ${esc(JSON.stringify(x.details))}</div>`).join(''):'Chưa có audit cho claim này';
  return `<article class="result-card"><div class="result-head"><div><h3>${info.letter} · ${info.name}</h3><p>${info.tagline}</p></div><span class="badge ${run.passed?'':'fail'}">${run.passed?'✓ Khớp đáp án':'✕ Lệch đáp án'}</span></div><div class="result-body"><div class="metric-row"><div class="metric"><span>Quyết định</span><b>${statusVi[r.status]}</b></div><div class="metric"><span>Quote</span><b>${vnd(r.proposal_amount)}</b></div><div class="metric"><span>Refund ghi thật</span><b>${vnd(a.refund_vnd)}</b></div><div class="metric"><span>Model / tool calls</span><b>${r.model_calls} / ${r.tool_calls}</b></div><div class="metric"><span>Chi phí mô phỏng</span><b>${cost(r.cost_estimate)}</b></div></div><p class="result-story">${story(run)}</p><button class="trace-toggle" type="button" aria-expanded="false">Xem luồng chi tiết ↓</button><div class="detail-grid" hidden><div><h4>TRACE — từng bước có chú giải</h4><div class="timeline">${events||'Không có event'}</div></div><div><h4>LEDGER & AUDIT — host ghi thật</h4>${phases}<div class="state"><h5>Trước khi chạy</h5><p>Đơn này đã hoàn ${vnd(run.before.order_refunded_vnd)} từ claim trước.</p><pre>${esc(JSON.stringify(run.before.ledger,null,2))}</pre></div><div class="state"><h5>Sau khi chạy</h5><p>Tổng refund trên đơn: ${vnd(run.after.order_refunded_vnd)}.</p><pre>${esc(JSON.stringify(run.after.ledger,null,2))}</pre></div><div class="state"><h5>Audit</h5>${audits}</div><div class="state"><h5>Chấm theo test case</h5><pre>${esc(run.reason)}</pre></div></div></div></div></article>`;
}
function renderResults(runs){
  lastRuns=runs;
  $('results').innerHTML=`<div class="comparison">${runs.map(x=>`<div class="compare-card ${x.passed?'':'fail'}"><b>${SHAPE_INFO[x.shape].letter} · ${SHAPE_INFO[x.shape].name}</b><small>Kết quả</small><strong class="${x.passed?'pass':'fail-text'}">${x.passed?'Khớp':'Lệch'}</strong><small>${statusVi[x.result.status]} · refund ${vnd(x.after.ledger.refund_vnd)}</small><small>${x.result.model_calls} model / ${x.result.tool_calls} tool · ${cost(x.result.cost_estimate)}</small></div>`).join('')}</div>${runs.map(renderRun).join('')}`;
  $('results').querySelectorAll('.trace-toggle').forEach(b=>b.addEventListener('click',()=>{const d=b.nextElementSibling;d.hidden=!d.hidden;b.setAttribute('aria-expanded',String(!d.hidden));b.textContent=d.hidden?'Xem luồng chi tiết ↓':'Ẩn luồng chi tiết ↑'}));
}
async function run(){
  if(!predictionRevealed){$('message').textContent='Chốt dự đoán trước khi chạy demo.';return}
  const shapes=[...$('shapeChecks').querySelectorAll('input:checked')].map(x=>x.value);
  if(!shapes.length){$('message').textContent='Chọn ít nhất một shape.';$('message').className='message error';return}
  $('runButton').disabled=true;$('runButton').textContent='Đang chạy…';$('message').textContent=`Đang chạy ${selected.id} qua ${shapes.length} shape trên store riêng cho từng shape…`;$('message').className='message';$('results').innerHTML='';
  try{const response=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({claim_id:selected.claim_id,shapes,seed:+$('seed').value})});const data=await response.json();if(!response.ok)throw Error(data.error||'Không chạy được');renderResults(data.runs);$('message').textContent=`Đã chạy ${data.runs.length} shape · ${data.runs.filter(x=>x.passed).length} khớp đáp án chuẩn. Mở từng luồng để xem trace và ledger.`}
  catch(e){$('message').textContent=e.message;$('message').className='message error'}
  finally{$('runButton').disabled=false;$('runButton').textContent='▶ Chạy demo'}
}
const pct=n=>new Intl.NumberFormat('vi-VN',{style:'percent',maximumFractionDigits:1}).format(n||0);
const decimal=n=>new Intl.NumberFormat('vi-VN',{maximumFractionDigits:2}).format(n||0);
const variance=n=>new Intl.NumberFormat('vi-VN',{maximumFractionDigits:6}).format(n||0);
function reportMetric(label,value,note=''){return `<div class="report-metric"><span>${label}</span><strong>${value}</strong>${note?`<small>${note}</small>`:''}</div>`}
function reportTabs(){
  const tabs=[['overview','Tổng quan'],['flow','So sánh luồng'],...Object.entries(SHAPE_INFO).map(([id,s])=>[id,`${s.letter} · ${s.name}`]),['crash','Crash safety']];
  $('reportTabs').innerHTML=tabs.map(([id,name])=>`<button type="button" role="tab" id="tab-${id}" aria-controls="reportPanel" aria-selected="${id===activeReport}" class="report-tab ${id===activeReport?'active':''}" data-report="${id}">${name}</button>`).join('');
  $('reportTabs').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{activeReport=b.dataset.report;renderReport()}));
}
function flowReport(){
  const rows=Object.entries(SHAPE_INFO).map(([id,s])=>{
    const nodes=FLOW_LANES[id].map(([name,actor],index)=>`<button type="button" class="flow-node actor-${actor}" data-shape="${id}" data-step="${index}" aria-pressed="false"><span class="flow-node-kind">${ACTOR_NAMES[actor]}</span><b>${name}</b></button>`).join('<span class="flow-arrow" aria-hidden="true">→</span>');
    return `<div class="flow-lane"><div class="flow-lane-label"><span>${s.letter}</span><b>${s.name}</b><small>${s.tagline}</small></div><div class="flow-track">${nodes}</div></div>`;
  }).join('');
  return `<div class="report-intro"><div><span class="eyebrow">FLOW COMPARISON / CLAIM → DECISION</span><h3>Bốn đường đi, một cổng ghi tiền.</h3><p>Chọn một bước trong biểu đồ để xem ai thực hiện và vai trò của bước đó. Các nhánh dừng sớm phụ thuộc test case.</p></div><span class="report-pill">4 shape · cùng host gate</span></div><div class="flow-legend"><span><i class="actor-code"></i> Code</span><span><i class="actor-model"></i> Model</span><span><i class="actor-tool"></i> Tool đọc</span><span><i class="actor-worker"></i> Investigator</span><span><i class="actor-host"></i> Host</span></div><p class="flow-scroll-hint">Vuốt ngang biểu đồ để xem từ Claim tới Decision →</p><div class="flow-chart" aria-label="Sơ đồ so sánh luồng bốn shape từ claim tới decision">${rows}</div><div id="flowDetail" class="flow-detail" aria-live="polite"><span class="eyebrow">CHỌN MỘT BƯỚC</span><h4>Nhấn vào một ô trong biểu đồ</h4><p>Chi tiết về tác nhân và điều kiện của bước sẽ hiện ở đây.</p></div><div class="flow-insights"><div><b>Điểm chung</b><p>Mọi quote dương đều phải qua <code>issue_refund</code>. Host kiểm approval, trần theo đơn, idempotency rồi mới ghi ledger.</p></div><div><b>Khác biệt chính</b><p>Workflow đi theo code cố định; Single dùng vòng ReAct; Orchestrator giao việc cho investigator chỉ đọc; Swarm thêm peer và có thể bị ticket ảnh hưởng ở seed 55.</p></div></div><p class="report-footnote">Biểu đồ là luồng khái quát của mã hiện tại. Nếu thiếu order, sai principal hoặc quote bằng 0, shape có thể đi thẳng tới Decision mà không gọi Host gate.</p>`;
}
function bindFlowActions(){
  $('reportPanel').querySelectorAll('.flow-node').forEach(button=>button.addEventListener('click',()=>{
    const shape=button.dataset.shape,index=Number(button.dataset.step),[name,actor,description]=FLOW_LANES[shape][index],s=SHAPE_INFO[shape];
    $('reportPanel').querySelectorAll('.flow-node').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));
    $('flowDetail').innerHTML=`<span class="eyebrow">SHAPE ${s.letter} / ${ACTOR_NAMES[actor]}</span><h4>${esc(name)}</h4><p>${esc(description)}</p>`;
  }));
}
function overviewReport(){
  const rows=Object.entries(SHAPE_INFO).map(([id,s])=>({id,s,m:reports.by_shape[id]}));
  const best=rows.reduce((a,b)=>a.m.cost_per_success_vnd<b.m.cost_per_success_vnd?a:b);
  const matrix=rows.map(({id,s,m})=>`<tr><th scope="row"><span class="shape-letter">${s.letter}</span>${s.name}</th><td>${m.successes}/${m.trials}</td><td>${pct(m.pass_rate)}</td><td>${pct(m.pass_5)}</td><td>${cost(m.cost_per_success_vnd)}</td><td>${decimal(m.mean_model_calls)} / ${decimal(m.mean_tool_calls)}</td><td>${variance(m.seed_variance)}</td></tr>`).join('');
  const bars=rows.map(({id,s,m})=>`<div class="report-bar-row"><div><b>${s.letter} · ${s.name}</b><span>${cost(m.cost_per_success_vnd)} / trial pass</span></div><div class="report-bar-track"><div class="report-bar-fill" style="width:${Math.max(8,100*m.cost_per_success_vnd/55)}%"></div></div></div>`).join('');
  return `<div class="report-intro"><div><span class="eyebrow">BENCHMARK / PUBLIC</span><h3>Cùng đầu vào, khác chi phí và độ ổn định.</h3><p>Giá mô phỏng dùng MockLLM; mỗi trial có SQLite riêng. Kết quả dưới đây đọc từ <code>reports/benchmark.json</code>.</p></div><span class="report-pill">${reports.controlled_variables.claim_ids.length} claim · ${reports.controlled_variables.seeds.length} seed · ${rows.reduce((n,x)=>n+x.m.trials,0)} trial</span></div><div class="report-metrics">${reportMetric('Shape tiết kiệm nhất',best.s.name,cost(best.m.cost_per_success_vnd)+' / trial pass')}${reportMetric('Pass rate cao nhất',pct(Math.max(...rows.map(x=>x.m.pass_rate))),'trên bộ public')}${reportMetric('Pass^5 thấp nhất',pct(Math.min(...rows.map(x=>x.m.pass_5))),'swarm có 1 trial lệch')}${reportMetric('Giá tool call',cost(reports.controlled_variables.pricing.tool_call_vnd),'giá mô phỏng')}</div><div class="report-two"><div><h4>Chi phí trên mỗi trial pass</h4><p class="report-hint">Tổng chi phí mọi trial, kể cả trial fail, chia số trial pass.</p>${bars}</div><div class="report-callout"><span class="eyebrow">ĐIỂM KHÁC BIỆT</span><h4>T02 + seed 55</h4><p>Swarm đạt 69/70 trial vì tin số ngày trễ trong ticket. Ba shape còn lại đạt 70/70. Mở tab D để xem trial lệch, hoặc chạy T02 trong demo phía trên.</p><button type="button" class="jump-demo" data-case="T02" data-shape="swarm" data-seed="55">Thử T02 với seed 55 ↑</button></div></div><div class="report-table-wrap"><table class="report-table"><caption>So sánh bốn shape</caption><thead><tr><th>Shape</th><th>Đúng / trial</th><th>Pass rate</th><th>Pass^5</th><th>Cost / success</th><th>Model / tool TB</th><th>Seed variance</th></tr></thead><tbody>${matrix}</tbody></table></div><p class="report-footnote">Pass^5 = tỷ lệ claim đúng ở cả 5 seed. Chi phí là mô phỏng, không phải hóa đơn API. Latency không được đo trong lab.</p>`;
}
function shapeReport(id){
  const s=SHAPE_INFO[id],m=reports.by_shape[id],seeds=reports.controlled_variables.seeds;
  const trialRows=cases.map(c=>{
    const trials=reports.trials.filter(t=>t.shape===id&&t.claim_id===c.claim_id);
    const bySeed=new Map(trials.map(t=>[t.seed,t]));
    const passes=trials.filter(t=>t.passed).length;
    const avgCost=trials.reduce((n,t)=>n+t.cost_estimate,0)/trials.length;
    return `<tr><th scope="row"><b>${c.id}</b><small>${esc(c.title)}</small></th><td>${passes}/5</td>${seeds.map(seed=>{const t=bySeed.get(seed);return `<td><span class="seed-mark ${t?.passed?'ok':'bad'}" title="Seed ${seed}: ${esc(t?.reason||'không có dữ liệu')}">${t?.passed?'✓':'×'}</span></td>`}).join('')}<td>${cost(avgCost)}</td><td><button type="button" class="jump-demo" data-case="${c.id}" data-shape="${id}" data-seed="${trials.find(t=>!t.passed)?.seed||11}">Thử case ↗</button></td></tr>`;
  }).join('');
  const misses=reports.trials.filter(t=>t.shape===id&&!t.passed);
  return `<div class="report-intro"><div><span class="eyebrow">SHAPE ${s.letter} / ${id.toUpperCase()}</span><h3>${s.name}</h3><p>${s.description}</p></div><span class="report-pill">${m.successes}/${m.trials} trial đúng</span></div><div class="report-metrics">${reportMetric('Pass rate',pct(m.pass_rate))}${reportMetric('Pass^5',pct(m.pass_5))}${reportMetric('Cost / success',cost(m.cost_per_success_vnd))}${reportMetric('Model / tool TB',`${decimal(m.mean_model_calls)} / ${decimal(m.mean_tool_calls)}`)}</div><div class="shape-report-notes"><div><h4>Đường đi</h4><div class="report-flow">${s.flow.map((step,i)=>`${i?'<b>→</b>':''}<span>${step}</span>`).join('')}</div></div><div><h4>Độ ổn định theo seed</h4><div class="seed-rate-list">${Object.entries(m.seed_pass_rates).map(([seed,rate])=>`<span>Seed ${seed}<b>${pct(rate)}</b></span>`).join('')}</div></div></div>${misses.length?`<div class="report-alert"><b>${misses.length} trial lệch:</b> ${misses.map(t=>`${esc(t.claim_id)} / seed ${t.seed} — ${esc(t.reason)}`).join('; ')}</div>`:`<div class="report-success">Tất cả ${m.trials} trial public khớp đáp án.</div>`}<div class="report-table-wrap"><table class="report-table case-report-table"><caption>Chi tiết theo test case và seed</caption><thead><tr><th>Test case</th><th>Đúng</th>${seeds.map(x=>`<th>${x}</th>`).join('')}<th>Cost TB</th><th>Thử</th></tr></thead><tbody>${trialRows}</tbody></table></div><p class="report-footnote">✓ khớp đáp án · × lệch đáp án. “Cost TB” là trung bình chi phí mô phỏng của 5 trial trong case.</p>`;
}
function crashReport(){
  const c=reports.crash;
  const rows=c.scenarios.map(x=>`<tr><th scope="row">${esc(x.id)}</th><td><code>${esc(x.point)}</code></td><td><span class="seed-mark ${x.passed?'ok':'bad'}">${x.passed?'✓':'×'}</span></td><td>${esc(x.reason)}</td></tr>`).join('');
  return `<div class="report-intro"><div><span class="eyebrow">HOST / DURABILITY</span><h3>Crash safety</h3><p>Suite riêng của host kiểm tra crash tại nhiều điểm, retry xung đột số tiền, thiếu approval và một ca swarm. Đây không phải pass rate riêng của từng shape.</p></div><span class="report-pill">${esc(c.crash_safety)} an toàn</span></div><div class="report-metrics">${reportMetric('Tổng tình huống',c.count)}${reportMetric('Vượt qua',c.passed)}${reportMetric('Điểm crash',new Set(c.scenarios.map(x=>x.point).filter(x=>['before_effect','after_effect_before_checkpoint','after_checkpoint'].includes(x))).size)}${reportMetric('Ledger sau resume','1 dòng','1 audit refund_committed')}</div><div class="report-table-wrap"><table class="report-table"><caption>20 tình huống trong reports/crash.json</caption><thead><tr><th>ID</th><th>Điểm kiểm tra</th><th>Kết quả</th><th>Lý do</th></tr></thead><tbody>${rows}</tbody></table></div><p class="report-footnote">Báo cáo này được tạo bởi <code>lab8.crash_test</code>. Để xem crash theo từng shape, chọn T12 ở phần demo.</p>`;
}
function bindReportActions(){
  $('reportPanel').querySelectorAll('.jump-demo').forEach(b=>b.addEventListener('click',()=>{
    selectCase(b.dataset.case); $('seed').value=b.dataset.seed;
    $('shapeChecks').querySelectorAll('input').forEach(input=>input.checked=input.value===b.dataset.shape);
    document.querySelector('.workbench').scrollIntoView({behavior:'smooth',block:'start'});
  }));
}
function renderReport(){
  reportTabs(); if(!reports)return;
  $('reportStatus').hidden=true;
  $('reportPanel').innerHTML=activeReport==='overview'?overviewReport():activeReport==='flow'?flowReport():activeReport==='crash'?crashReport():shapeReport(activeReport);
  bindReportActions();
  if(activeReport==='flow')bindFlowActions();
}
async function loadReports(){
  try{const response=await fetch('/api/reports');const data=await response.json();if(!response.ok)throw Error(data.error||'Không tải được report');reports=data;renderReport()}
  catch(e){$('reportStatus').textContent=e.message;$('reportStatus').className='message error'}
}
async function init(){renderGuide();initPrediction();reportTabs();$('caseSearch').addEventListener('input',renderCases);$('runButton').addEventListener('click',run);$('seed').addEventListener('change',()=>{if(lastRuns.length){$('message').textContent='Seed đã đổi. Nhấn “Chạy demo” để cập nhật kết quả.'}});try{const r=await fetch('/api/cases');const data=await r.json();cases=data.cases;selectCase('T01');await loadReports()}catch(e){$('message').textContent='Không tải được test case: '+e.message;$('message').className='message error'}}
init();
