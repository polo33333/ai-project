/* Phase 1 definitions, version management and owner-scoped run controls. */
(() => {
  const state = { packages: [], templates: [], runs: [], settings: {}, admin: false, search: '', domain: '' };
  const views = new Map();
  const h = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const statuses = { CREATED: 'Đã tạo', READY: 'Đang chờ chạy', RUNNING: 'Đang thực hiện', WAITING_INPUT: 'Chờ bổ sung', SUCCEEDED: 'Hoàn thành', FAILED: 'Thất bại', CANCELLED: 'Đã hủy', NEEDS_REVIEW: 'Cần kiểm tra', SELECT_TEMPLATE: 'Chọn quy trình' };
  const done = value => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(value);
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Không thể xử lý yêu cầu.'); return data;
  }
  function notify(message, failed = false) { const box = document.getElementById('wp-message'); if (box) { box.textContent = message; box.style.color = failed ? '#b91c1c' : ''; } else if (typeof showToast === 'function') showToast(message, failed ? 'error' : 'success'); }
  function button(text, action) { const element = document.createElement('button'); element.type = 'button'; element.className = 'btn-secondary-sm'; element.textContent = text; element.onclick = async () => { element.disabled = true; try { await action(); } catch (failure) { notify(failure.message, true); } finally { element.disabled = false; } }; return element; }
  const nodeIcons = { transform: 'fa-wand-magic-sparkles', condition: 'fa-code-branch', assert: 'fa-shield-halved', collect: 'fa-list-check', delay: 'fa-clock', sql: 'fa-database', source: 'fa-layer-group', export: 'fa-file-export' };
  function icon(className) { const element = document.createElement('i'); element.className = `fa-solid ${className}`; element.setAttribute('aria-hidden', 'true'); return element; }
  function confirmDelete(message) {
    return new Promise(resolve => {
      const previousFocus = document.activeElement, backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop workflow-modal wp-confirm-backdrop show';
      const dialog = document.createElement('div'); dialog.className = 'workflow-dialog wp-confirm-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      const titleId = `confirm-${crypto.randomUUID()}`, textId = `${titleId}-text`; dialog.setAttribute('aria-labelledby', titleId); dialog.setAttribute('aria-describedby', textId);
      const visual = document.createElement('span'); visual.className = 'wp-confirm-icon'; visual.appendChild(icon('fa-trash-can'));
      const title = document.createElement('h3'); title.id = titleId; title.textContent = 'Xác nhận xóa';
      const text = document.createElement('p'); text.id = textId; text.textContent = message;
      const footer = document.createElement('footer');
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary-sm'; cancel.textContent = 'Hủy';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'wp-confirm-delete'; remove.textContent = 'Xóa'; footer.append(cancel, remove);
      function close(confirmed) { document.removeEventListener('keydown', keydown, true); backdrop.remove(); if (previousFocus?.isConnected) previousFocus.focus(); resolve(confirmed); }
      function keydown(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); } else if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === cancel ? remove : cancel).focus(); } }
      cancel.onclick = () => close(false); remove.onclick = () => close(true); backdrop.onclick = event => { if (event.target === backdrop) close(false); };
      dialog.append(visual, title, text, footer); backdrop.appendChild(dialog); document.body.appendChild(backdrop); document.addEventListener('keydown', keydown, true); cancel.focus();
    });
  }
  function decorateCard(card, template) {
    const type = template.workflow?.steps.some(step => step.type === 'export') ? 'export' : template.workflow?.steps.some(step => step.type === 'sql') ? 'sql' : Object.values(template.inputs || {}).some(slot => slot.schema?.format === 'date') ? 'delay' : 'transform';
    const head = document.createElement('div'); head.className = `wp-template-head wp-tone-${type}`;
    const badge = document.createElement('span'); badge.className = 'wp-template-icon'; badge.appendChild(icon(nodeIcons[type])); head.append(badge, card.querySelector('h3')); card.prepend(head); card.classList.add('wp-template-card');
  }
  function emptyState(container, symbol, title, description) {
    const box = document.createElement('div'); box.className = 'wp-empty-state';
    const visual = document.createElement('span'); visual.className = 'wp-empty-icon'; visual.appendChild(icon(symbol));
    const text = document.createElement('div'), heading = document.createElement('strong'), detail = document.createElement('p'); heading.textContent = title; detail.textContent = description; text.append(heading, detail); box.append(visual, text); container.appendChild(box);
  }
  function domainBadge(domain) { const badge = document.createElement('span'); badge.className = 'wp-domain-badge'; badge.appendChild(icon('fa-folder-open')); badge.appendChild(document.createTextNode(`Lĩnh vực: ${domain || 'Chưa phân loại'}`)); return badge; }
  function cardMetadata(card, domain, tags, available) {
    const metadata=document.createElement('div'); metadata.className='wp-card-metadata'; metadata.appendChild(domainBadge(domain));
    const status=document.createElement('span'); status.className='wp-card-status'+(available?' ready':''); status.append(icon(available?'fa-circle-check':'fa-clock'),document.createTextNode(available?'Sẵn sàng trong chat':'Chưa sẵn sàng')); metadata.appendChild(status); card.appendChild(metadata);
    const values=[...new Set((tags||[]).filter(Boolean))];
    if(values.length) { const list=document.createElement('div'); list.className='wp-card-tags'; list.setAttribute('aria-label','Từ khóa mẫu'); values.forEach(tag=>{const chip=document.createElement('span'); chip.append(icon('fa-hashtag'),document.createTextNode(tag));list.appendChild(chip);});card.appendChild(list); }
  }
  function modal(title) {
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop workflow-modal show';
    backdrop.innerHTML = `<div class="workflow-dialog workflow-editor-dialog"><header><strong>${h(title)}</strong><button type="button" aria-label="Đóng">×</button></header><div class="workflow-editor-body"></div><footer></footer></div>`;
    backdrop.querySelector('header button').onclick = () => backdrop.remove(); backdrop.onclick = event => { if (event.target === backdrop) backdrop.remove(); }; document.body.appendChild(backdrop);
    return { backdrop, body: backdrop.querySelector('.workflow-editor-body'), footer: backdrop.querySelector('footer') };
  }
  function typeBadge(label) {
    const badge=document.createElement('span'); badge.className='wp-field-type';
    const symbols={SQL:'fa-database',JSON:'fa-code',API:'fa-globe',File:'fa-file-lines','Bước trước':'fa-arrow-turn-down',Nhóm:'fa-layer-group','Danh sách':'fa-list','Văn bản':'fa-font',Số:'fa-hashtag','Có / Không':'fa-toggle-on',Trống:'fa-minus'};
    badge.dataset.kind=label; if(symbols[label]) badge.appendChild(icon(symbols[label])); badge.appendChild(document.createTextNode(label)); return badge;
  }
  let codeFieldId=0;
  function codeField(input,language) {
    input.id ||= `wp-code-input-${++codeFieldId}`;input.parentElement.setAttribute('for',input.id);
    const shell=document.createElement('div');shell.className='wp-code-editor';shell.dataset.language=language;input.parentElement.insertBefore(shell,input);
    const toolbar=document.createElement('div');toolbar.className='wp-code-toolbar';toolbar.append(typeBadge(language.toUpperCase()));
    if(language==='json'){const format=button('Định dạng',()=>{try{input.value=JSON.stringify(JSON.parse(input.value),null,2);input.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){notify('JSON chưa hợp lệ, hãy kiểm tra nội dung trước khi định dạng.',true);}});format.setAttribute('aria-label','Định dạng JSON');toolbar.appendChild(format);}
    const surface=document.createElement('div');surface.className='wp-code-surface';const preview=document.createElement('pre');preview.setAttribute('aria-hidden','true');preview.className='wp-code-highlight';
    shell.append(toolbar,surface);surface.append(preview,input);input.classList.add('wp-code-input');input.spellcheck=false;input.setAttribute('autocapitalize','off');
    function highlight(line) {
      const tokens=language==='sql'?/--.*$|'(?:''|[^'])*'|\[[^\]]*\]|\b(?:SELECT|TOP|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|IS|IN|LIKE|ORDER|BY|GROUP|HAVING|ASC|DESC|DISTINCT|CASE|WHEN|THEN|ELSE|END|WITH|UNION|ALL|OFFSET|FETCH|EXISTS|COUNT|SUM|AVG|MIN|MAX|CONCAT|REPLACE|CAST|CONVERT)\b|@[\w]+|\b\d+(?:\.\d+)?\b/gi: /"(?:\\.|[^"\\])*"(?:\s*(?=:))?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
      let html='',cursor=0;for(const match of line.matchAll(tokens)){html+=h(line.slice(cursor,match.index));const token=match[0];const kind=language==='sql'?(token.startsWith('--')?'comment':token.startsWith("'")?'string':token.startsWith('[')?'identifier':token.startsWith('@')?'parameter':/^\d/.test(token)?'number':'keyword'):(token.startsWith('"')?line.slice(match.index+token.length).trimStart().startsWith(':')?'key':'string':/^[-\d]/.test(token)?'number':'keyword');html+=`<span class="wp-code-${kind}">${h(token)}</span>`;cursor=match.index+token.length;}return html+h(line.slice(cursor));
    }
    const render=()=>{preview.innerHTML=input.value.split('\n').map((line,index)=>`<span class="wp-code-line" data-line="${index+1}">${highlight(line)||' '}</span>`).join('');preview.scrollTop=input.scrollTop;preview.scrollLeft=input.scrollLeft;};
    input.addEventListener('input',render);input.addEventListener('scroll',()=>{preview.scrollTop=input.scrollTop;preview.scrollLeft=input.scrollLeft;});
    input.addEventListener('keydown',event=>{if(event.key==='Tab' && !event.shiftKey){event.preventDefault();input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}});
    input._renderCode=render;render();
  }
  function field(container, label, value, { multiline = false, type = 'text', code = '' } = {}) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const input = document.createElement(multiline ? 'textarea' : 'input'); if (multiline) { input.className = 'wp-textarea'; input.rows = 3; } else input.type = type;
    input.setAttribute('aria-label', label);
    input.value = value ?? ''; wrapper.appendChild(input); container.appendChild(wrapper); if(code)codeField(input,code);return input;
  }
  const captions = { mapping: 'Trường kết quả', schema: 'Kiểu dữ liệu và giới hạn', properties: 'Các trường dữ liệu', required: 'Trường bắt buộc', presentation: 'Cách hiển thị', labels: 'Nhãn hiển thị', input: 'Đầu vào thử nghiệm', expected: 'Kết quả mong đợi', stepResults: 'Dữ liệu giả lập từng bước', type: 'Kiểu dữ liệu', format: 'Định dạng', enum: 'Giá trị được phép', items: 'Cấu trúc mỗi phần tử', minimum: 'Giá trị nhỏ nhất', maximum: 'Giá trị lớn nhất', minLength: 'Độ dài tối thiểu', maxLength: 'Độ dài tối đa', additionalProperties: 'Cho phép trường khác', emptyText: 'Thông báo khi trống', sourceId: 'Nguồn dữ liệu', sql: 'Câu truy vấn', parameters: 'Tham số', tables: 'Bảng được phép', binding: 'Nguồn truy vấn', filename: 'Tên file', rows: 'Dữ liệu xuất', milliseconds: 'Thời gian chờ (ms)' };
  function resultMappingEditor(container, mappings) {
    const group = document.createElement('section'); group.className = 'wp-mapping-list'; container.appendChild(group);
    const help = document.createElement('p'); help.className = 'wp-section-help'; help.textContent = 'Mỗi thẻ là một cột kết quả. Cột nguồn và quan hệ liên kết với cấu trúc bảng; tên hiển thị được kiểm tra theo mapping đang active khi chạy.'; group.appendChild(help);
    const list = document.createElement('div'); group.appendChild(list); const rows = [];
    function add(original) {
      const card = document.createElement('article'); card.className = 'wp-mapping-card'; list.appendChild(card);
      const header = document.createElement('div'); header.className = 'wp-mapping-heading'; const title = document.createElement('strong'); header.append(icon('fa-table-columns'), title); card.appendChild(header);
      const row = { original }; rows.push(row);
      const remove = button('', () => { rows.splice(rows.indexOf(row), 1); card.remove(); }); remove.className = 'wp-field-remove'; remove.setAttribute('aria-label', 'Xóa cột kết quả'); remove.appendChild(icon('fa-trash-can')); header.appendChild(remove);
      const grid = document.createElement('div'); grid.className = 'wp-form-grid'; card.appendChild(grid);
      const key = field(grid, 'Cột trong kết quả SQL', original.key), label = field(grid, 'Tên hiển thị', original.label);
      key.placeholder = 'Tên cột hoặc bí danh trong SELECT'; label.placeholder = 'Tên người dùng nhìn thấy';
      const source = document.createElement('p'); source.className = 'wp-mapping-source'; card.appendChild(source);
      const technical = document.createElement('details'); technical.className = 'wp-advanced'; technical.innerHTML = '<summary>Liên kết với cấu trúc bảng</summary>'; card.appendChild(technical);
      const note = document.createElement('p'); note.className = 'wp-section-help'; note.textContent = 'Các mã này dùng để đối chiếu với bảng và quan hệ đã định nghĩa. Đổi liên kết cần đồng bộ câu SQL tương ứng.'; technical.appendChild(note);
      const table = field(technical, 'ID bảng nguồn', original.tableId), column = field(technical, 'Cột nguồn trong bảng', original.columnName), relation = field(technical, 'ID quan hệ (để trống nếu lấy trực tiếp)', original.relationId);
      function describe() { title.textContent = label.value || key.value || 'Cột kết quả mới'; source.textContent = `Bảng nguồn: ${table.value ? table.value.split('::').slice(-2).join('.') : 'Chưa liên kết'} · Cột: ${column.value || 'Chưa chọn'} · ${relation.value ? 'Lấy tên qua quan hệ' : 'Lấy giá trị trực tiếp'}`; }
      [key, label, table, column, relation].forEach(input => input.addEventListener('input', describe)); describe();
      row.read = () => {
        const result = { ...original };
        for (const [name, input] of [['key', key], ['label', label], ['tableId', table], ['columnName', column], ['relationId', relation]]) {
          if (input.value !== String(original[name] ?? '')) result[name] = name === 'relationId' && !input.value.trim() ? null : input.value;
        }
        return result;
      };
    }
    mappings.forEach(add); const addButton = button('Thêm cột liên kết', () => add({ key: '', label: '', tableId: '', columnName: '', relationId: null })); addButton.prepend(icon('fa-plus')); group.appendChild(addButton);
    return () => rows.map(row => row.read());
  }
  function chooseFieldType(onChoose, sqlOnly = false) {
    const dialog = modal(sqlOnly ? 'Thêm nguồn truy vấn' : 'Bạn muốn thêm loại dữ liệu nào?');
    const choices = sqlOnly ? [
      ['sql', 'Truy vấn SQL', 'Tạo sẵn ô câu truy vấn, nguồn kết nối, bảng và tham số.'],
      ['api', 'API', 'HTTP/HTTPS, phương thức, xác thực, header, body và dữ liệu từ bước trước.'],
      ['file', 'File trong Thư viện', 'Đọc nội dung tài liệu hoặc bảng dữ liệu CSV, Excel, JSON.'],
      ['previous', 'Kết quả bước trước', 'Dùng lại toàn bộ kết quả hoặc một phần dữ liệu của bước đã chạy.']
    ] : [
      ['string', 'Văn bản', 'Tên, mô tả hoặc một giá trị dạng chữ.'],
      ['number', 'Số', 'Số lượng hoặc giá trị tính toán.'],
      ['boolean', 'Có / Không', 'Một lựa chọn bật hoặc tắt.'],
      ['object', 'Nhóm trường', 'Gom nhiều thông tin liên quan vào cùng nhóm.'],
      ['array', 'Danh sách', 'Nhiều mục có cùng cấu trúc.']
    ];
    const list = document.createElement('div'); list.className = 'wp-type-options'; dialog.body.appendChild(list);
    choices.forEach(([type, title, hint]) => {
      const option = button('', () => { dialog.backdrop.remove(); onChoose(type); }); option.className = 'wp-type-option';
      const heading = document.createElement('strong'); heading.textContent = title; const detail = document.createElement('span'); detail.textContent = hint;
      const visual=document.createElement('span'); visual.className='wp-type-choice-icon'; visual.appendChild(icon({sql:'fa-database',api:'fa-globe',file:'fa-file-lines',previous:'fa-arrow-turn-down',string:'fa-font',number:'fa-hashtag',boolean:'fa-toggle-on',object:'fa-layer-group',array:'fa-list'}[type]));
      const copy=document.createElement('span'); copy.className='wp-type-choice-copy'; copy.append(heading,detail); option.append(visual,copy,icon('fa-chevron-right')); list.appendChild(option);
    });
    dialog.footer.appendChild(button('Hủy', () => dialog.backdrop.remove())); list.querySelector('button')?.focus();
  }
  function referenceInput(container, label, value, context = {}) {
    const input = field(container,label,value);
    const picker = document.createElement('select'); picker.className = 'wp-reference-picker'; picker.setAttribute('aria-label', `Lấy dữ liệu cho ${label}`); picker.appendChild(new Option('Lấy từ đầu vào hoặc bước trước…',''));
    const template = context.template;
    for (const [key, slot] of Object.entries(template?.inputs || {})) picker.appendChild(new Option(`Đầu vào · ${slot.label || key}`, `{{input.${key}}}`));
    const consumer = template?.workflow.steps.findIndex(step => step.config?.bindingRef === context.bindingKey) ?? -1;
    const previous = consumer < 0 ? template?.workflow.steps || [] : template.workflow.steps.slice(0,consumer);
    previous.forEach(step => {
      const paths = new Set(['']);
      if (['sql','source'].includes(step.type)) { paths.add('.rows'); paths.add('.rowCount'); if(step.type === 'source') paths.add('.data');
        const binding = template.bindings?.[step.config.bindingRef]; (binding?.resultMapping || []).forEach(column => paths.add(`.rows.0.${column.key}`));
      }
      Object.keys(step.config?.mapping || {}).forEach(key => paths.add(`.${key}`));
      paths.forEach(suffix => picker.appendChild(new Option(`${step.name || step.id} · ${suffix ? suffix.slice(1) : 'Toàn bộ kết quả'}`, `{{steps.${step.id}${suffix}}}`)));
    });
    picker.onchange = () => { if (picker.value) { input.value = picker.value; input.dispatchEvent(new Event('input', { bubbles:true })); } };
    input.parentElement.appendChild(picker); return input;
  }
  function multipartEditor(container, initial, context) {
    const list=document.createElement('div');list.className='wp-multipart-list';container.appendChild(list);const rows=[];
    let documentsRequest;
    function add(name,value) {
      const card=document.createElement('article');card.className='wp-mapping-card';list.appendChild(card);const grid=document.createElement('div');grid.className='wp-form-grid';card.appendChild(grid);
      const key=field(grid,'Tên trường gửi lên',name),wrapper=document.createElement('label');wrapper.textContent='Loại nội dung';const type=document.createElement('select');type.setAttribute('aria-label','Loại nội dung');type.append(new Option('Văn bản / dữ liệu','text'),new Option('File trong Thư viện','file'));type.value=value && typeof value==='object' && value.documentId?'file':'text';wrapper.appendChild(type);grid.appendChild(wrapper);
      const host=document.createElement('div');card.appendChild(host);let read,active=type.value;const cache={[active]:value};
      function render(){host.replaceChildren();const current=cache[active];if(active==='file'){
        const id=referenceInput(host,'File cần gửi (mã hoặc tham chiếu)',current?.documentId,context);const label=document.createElement('label');label.textContent='Chọn tài liệu';const select=document.createElement('select');select.setAttribute('aria-label','Chọn tài liệu');select.appendChild(new Option('Chọn file trong Thư viện…',''));label.appendChild(select);host.appendChild(label);
        documentsRequest ||= api('/api/library');documentsRequest.then(documents=>{if(!select.isConnected)return;documents.forEach(document=>select.appendChild(new Option(document.title || document.name || document.id,document.id)));select.value=id.value;}).catch(failure=>notify(failure.message,true));select.onchange=()=>{id.value=select.value;};
        read=()=>({...current,documentId:id.value});
      }else{const input=referenceInput(host,'Giá trị trường',current && typeof current==='object'?'':current,context);read=()=>input.value;}}
      render();type.onchange=()=>{cache[active]=read();active=type.value;render();};const row={read:()=>[key.value.trim(),read()]};rows.push(row);card.appendChild(button('Xóa mục',()=>{rows.splice(rows.indexOf(row),1);card.remove();}));
    }
    Object.entries(initial).forEach(([name,value])=>add(name,value));container.appendChild(button('Thêm',()=>add('', '')));
    return ()=>{const result=Object.create(null);rows.forEach(row=>{const [key,value]=row.read();if(!key || ['__proto__','constructor','prototype'].includes(key) || Object.hasOwn(result,key))throw new Error('Tên trường multipart phải khác nhau và không được trống.');result[key]=value;});return result;};
  }
  function sourceEditor(container, value, context) {
    const card = document.createElement('section'); card.className = 'wp-source-form'; container.appendChild(card);
    const heading = document.createElement('h4'); heading.textContent = { api:'API',file:'File trong Thư viện',previous:'Kết quả bước trước' }[value.type]; card.appendChild(heading);
    const readers = {};
    if(value.type === 'api') {
      const selectField=(host,label,options,current)=>{const wrapper=document.createElement('label');wrapper.textContent=label;const select=document.createElement('select');select.setAttribute('aria-label',label);options.forEach(([key,name])=>select.appendChild(new Option(name,key)));select.value=current;wrapper.appendChild(select);host.appendChild(wrapper);return select;};
      const method=selectField(card,'Phương thức',['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(name=>[name,name]),value.method || 'GET');readers.method=()=>method.value;
      const url=field(card,'Địa chỉ API HTTP/HTTPS',value.url); url.placeholder='https://…/resource/{{steps.lookup.rows.0.ID}}'; readers.url=()=>url.value;
      const authType=selectField(card,'Xác thực',[['none','Không xác thực'],['bearer','Bearer token'],['basic','Basic Auth'],['apiKey','API key']],value.auth?.type || 'none');
      const requestRow=document.createElement('div');requestRow.className='wp-api-request-row';card.insertBefore(requestRow,method.parentElement);
      method.parentElement.classList.add('wp-api-method');url.parentElement.classList.add('wp-api-url');authType.parentElement.classList.add('wp-api-auth-type');
      requestRow.append(method.parentElement,url.parentElement,authType.parentElement);
      const authHost=document.createElement('div');authHost.className='wp-api-auth';card.appendChild(authHost);const authCache={[authType.value]:value.auth || {type:'none'}};let activeAuth=authType.value,readAuth;
      function renderAuth(){authHost.replaceChildren();authHost.hidden=activeAuth==='none';const auth=authCache[activeAuth] || {type:activeAuth},fields={};
        const add=(key,label,current)=>{const input=field(authHost,label,current);fields[key]=()=>input.value;};
        if(activeAuth==='bearer'){add('tokenEnv','Biến môi trường chứa token',auth.tokenEnv);const token=referenceInput(authHost,'Hoặc lấy token từ bước trước',auth.token,context);fields.token=()=>token.value;}
        if(activeAuth==='basic'){const username=referenceInput(authHost,'Tên đăng nhập',auth.username,context);fields.username=()=>username.value;add('passwordEnv','Biến môi trường chứa mật khẩu',auth.passwordEnv);}
        if(activeAuth==='apiKey'){add('name','Tên header / tham số API key',auth.name);add('valueEnv','Biến môi trường chứa API key',auth.valueEnv);const location=selectField(authHost,'Gửi API key ở',[['header','Header'],['query','Query string']],auth.location || 'header');fields.location=()=>location.value;}
        readAuth=()=>{const result={...auth,type:activeAuth};Object.entries(fields).forEach(([key,read])=>{const next=read();if(next)result[key]=next;else delete result[key];});return result;};
      }
      renderAuth();authType.onchange=()=>{authCache[activeAuth]=readAuth();activeAuth=authType.value;renderAuth();};readers.auth=()=>readAuth();
      readers.headers=structuredField(card,'Header gửi tới API',value.headers || {},'', '',{...context,referencesAll:true});
      const dataPath=field(card,'Đường dẫn dữ liệu trong JSON (để trống lấy toàn bộ)',value.dataPath); dataPath.placeholder='Ví dụ: data.items'; readers.dataPath=()=>dataPath.value;
      readers.query=structuredField(card,'Tham số gửi tới API',value.query || {},'', '', { ...context,referencesAll:true });
      const bodyFormat=selectField(card,'Dữ liệu gửi (body)',[['none','Không gửi body'],['json','JSON'],['text','Văn bản'],['form','Form URL encoded'],['multipart','Multipart / gửi file'],['binary','Nội dung file (binary)']],value.bodyFormat || (value.body===undefined?'none':'json'));
      const bodyHost=document.createElement('div');card.appendChild(bodyHost);const bodyCache={[bodyFormat.value]:value.body};let activeBody=bodyFormat.value,readBody=()=>undefined;
      function renderBody(){bodyHost.replaceChildren();const current=bodyCache[activeBody];
        if(activeBody==='none'){readBody=()=>undefined;return;}
        if(activeBody==='binary'){const input=referenceInput(bodyHost,'Mã file trong Thư viện',typeof current==='object'?current?.documentId:current,context);readBody=()=>input.value;return;}
        const full=referenceInput(bodyHost,'Lấy toàn bộ body từ bước trước (tùy chọn)',typeof current==='string' && /^\{\{/.test(current)?current:'',context);
        const editor=document.createElement('div');bodyHost.appendChild(editor);
        const initial=activeBody==='text'?(typeof current==='string' && !/^\{\{/.test(current)?current:''):current && typeof current==='object'?current:{};
        const read=activeBody==='multipart'?multipartEditor(editor,initial,context):activeBody==='json'?structuredField(editor,'Body JSON',initial,'','',{...context,referencesAll:true}):valueEditor(editor,initial,'Nội dung body','',{...context,referencesAll:true});
        if(activeBody==='json')editor.firstElementChild.open=true;
        readBody=()=>full.value || read();
      }
      renderBody();bodyFormat.onchange=()=>{try{bodyCache[activeBody]=readBody();activeBody=bodyFormat.value;renderBody();}catch(failure){bodyFormat.value=activeBody;notify(failure.message,true);}};
      method.onchange=()=>{if(['GET','HEAD'].includes(method.value)){bodyFormat.value='none';bodyFormat.onchange();}};
      readers.bodyFormat=()=>bodyFormat.value;readers.body=()=>readBody();
      const response=selectField(card,'Kiểu phản hồi',[['json','JSON'],['text','Văn bản'],['binary','File tải xuống'],['auto','Tự nhận diện']],value.responseFormat || 'json');readers.responseFormat=()=>response.value;
      const advanced=document.createElement('details');advanced.className='wp-advanced';advanced.innerHTML='<summary>Thời gian chờ và redirect</summary>';card.appendChild(advanced);
      const timeout=field(advanced,'Thời gian chờ (ms)',value.timeoutMs || 30000,{type:'number'}),redirects=field(advanced,'Số lần redirect tối đa (cùng origin)',value.maxRedirects || 0,{type:'number'});timeout.min=1000;timeout.max=60000;redirects.min=0;redirects.max=5;
      readers.timeoutMs=()=>Number(timeout.value);readers.maxRedirects=()=>Number(redirects.value);
    }
    if(value.type === 'file') {
      const wrapper=document.createElement('label'); wrapper.textContent='Chọn file'; const picker=document.createElement('select'); picker.appendChild(new Option('Chọn tài liệu trong Thư viện…',''));
      picker.appendChild(new Option(value.documentId || 'Chưa chọn',value.documentId || '')); picker.value=value.documentId || ''; wrapper.appendChild(picker); card.appendChild(wrapper);
      api('/api/library').then(documents=>{ if(!picker.isConnected)return; documents.forEach(document=>{if(![...picker.options].some(option=>option.value===document.id))picker.appendChild(new Option(document.title || document.name || document.id,document.id));}); }).catch(failure=>notify(failure.message,true));
      const id=referenceInput(card,'Mã file hoặc tham chiếu từ bước trước',value.documentId,context); picker.onchange=()=>{id.value=picker.value;}; readers.documentId=()=>id.value;
      const formatLabel=document.createElement('label'); formatLabel.textContent='Định dạng dữ liệu'; const format=document.createElement('select');
      [['auto','Tự nhận diện'],['text','Nội dung văn bản'],['json','JSON'],['csv','Bảng CSV'],['xlsx','Bảng Excel']].forEach(([key,name])=>format.appendChild(new Option(name,key)));format.value=value.format || 'auto';formatLabel.appendChild(format);card.appendChild(formatLabel);readers.format=()=>format.value;
      const sheet=field(card,'Tên sheet Excel (để trống dùng sheet đầu)',value.sheet); readers.sheet=()=>sheet.value;
    }
    if(value.type === 'previous') { const input=referenceInput(card,'Dữ liệu cần kế thừa',value.reference,context); input.placeholder='Chọn kết quả bước đã chạy ở danh sách bên dưới'; readers.reference=()=>input.value; }
    return () => { const result={...value}; Object.entries(readers).forEach(([key,read])=>{const next=read(); if(JSON.stringify(next)!==JSON.stringify(value[key] ?? ''))result[key]=next;});return result; };
  }
  function sqlParametersEditor(container, parameters, context) {
    const section=document.createElement('section');section.className='wp-source-parameters';container.appendChild(section);
    const heading=document.createElement('h4');heading.textContent='Tham số SQL';section.appendChild(heading);
    const hint=document.createElement('p');hint.className='wp-section-help';hint.textContent='Mỗi tham số @name lấy giá trị từ đầu vào, kết quả bước trước hoặc giá trị cố định. Câu SQL phải khai báo cùng tên tham số.';section.appendChild(hint);
    const list=document.createElement('div');section.appendChild(list);const rows=[];
    function add(name,original) {
      const card=document.createElement('article');card.className='wp-mapping-card';list.appendChild(card);const grid=document.createElement('div');grid.className='wp-form-grid';card.appendChild(grid);
      const key=field(grid,'Tên tham số (không có @)',name);const typeLabel=document.createElement('label');typeLabel.textContent='Kiểu dữ liệu';const type=document.createElement('select');[['string','Văn bản'],['integer','Số nguyên'],['number','Số'],['boolean','Có / Không'],['date','Ngày']].forEach(([value,label])=>type.appendChild(new Option(label,value)));type.value=original.type || 'string';typeLabel.appendChild(type);grid.appendChild(typeLabel);
      const initial=Object.hasOwn(original,'slot')?`{{input.${original.slot}}}`:original.value ?? '';
      const input=referenceInput(card,'Giá trị tham số',initial,context);const row={};rows.push(row);
      row.read=()=>{const result={...original,type:type.value};if(input.value!==String(initial)){
        delete result.slot;delete result.value;const slot=input.value.match(/^\{\{input\.([\w.-]+)\}\}$/);
        if(slot)result.slot=slot[1];else result.value=/\{\{/.test(input.value)||type.value==='string'||type.value==='date'?input.value:type.value==='boolean'?input.value==='true':input.value.trim()?Number(input.value):null;
      }return [key.value.trim(),result];};
      const remove=button('Xóa tham số',()=>{rows.splice(rows.indexOf(row),1);card.remove();});card.appendChild(remove);
    }
    Object.entries(parameters).forEach(([name,mapping])=>add(name,mapping));section.appendChild(button('Thêm tham số',()=>{const slot=Object.keys(context.template?.inputs || {})[0];add('',slot?{slot,type:context.template.inputs[slot].schema.format==='date'?'date':context.template.inputs[slot].schema.type}:{value:'',type:'string'});}));
    return ()=>{const result=Object.create(null);rows.forEach(row=>{const [key,mapping]=row.read();if(!key || ['__proto__','constructor','prototype'].includes(key) || Object.hasOwn(result,key))throw new Error('Tên tham số phải khác nhau và không được trống.');result[key]=mapping;});return result;};
  }
  function valueEditor(container, value, label = 'Giá trị', propertyKey = '', context = {}) {
    if(value && typeof value === 'object' && ['api','file','previous'].includes(value.type)) return sourceEditor(container,value,context);
    if(propertyKey === 'parameters' && value && typeof value === 'object' && !Array.isArray(value)) return sqlParametersEditor(container,value,context);
    if (propertyKey === 'resultMapping' && Array.isArray(value) && value.every(item => item && typeof item === 'object' && !Array.isArray(item))) return resultMappingEditor(container, value);
    if (value !== null && typeof value === 'object') {
      const group = document.createElement('fieldset'); group.className = 'wp-value-group';
      const legend = document.createElement('legend'); legend.textContent = label; group.appendChild(legend); container.appendChild(group);
      const list = document.createElement('div'); group.appendChild(list); const rows = [], array = Array.isArray(value);
      const technical = !array && typeof value.sql === 'string' ? document.createElement('details') : null;
      if (technical) { technical.className = 'wp-advanced wp-query-advanced'; technical.innerHTML = '<summary>Cấu hình truy vấn nâng cao</summary><p class="wp-section-help">Nguồn kết nối, bảng được phép, tham số và mapping của truy vấn. Các thiết lập này vẫn được giữ khi lưu mẫu.</p>'; }
      function add(key, child) {
        const row = document.createElement('div'); row.className = 'wp-value-row' + (child !== null && typeof child === 'object' ? ' wp-complex-row' : '') + (array ? ' wp-array-row' : '') + (key === 'sql' ? ' wp-sql-row' : '');
        const keyInput = array ? null : field(row, 'Tên trường', key);
        const fieldType=propertyKey==='bindings'?(child?.type || (typeof child?.sql==='string'?'sql':'object')):key==='sql' && typeof child==='string'?'sql':child===null?'null':Array.isArray(child)?'array':typeof child;
        const typeNames={sql:'SQL',api:'API',file:'File',previous:'Bước trước',object:'Nhóm',array:'Danh sách',string:'Văn bản',number:'Số',boolean:'Có / Không',null:'Trống'};
        const badge=typeBadge(typeNames[fieldType] || fieldType);row.classList.add('wp-typed-row');
        if(keyInput) { const label=keyInput.parentElement; const heading=document.createElement('span'); heading.className='wp-field-heading'; heading.append(label.firstChild,badge); label.prepend(heading); }
        else row.appendChild(badge);
        if (key === 'resultMapping' && keyInput) keyInput.parentElement.hidden = true;
        if (technical && key === 'sql' && keyInput) keyInput.parentElement.hidden = true;
        const content = document.createElement('div'); row.appendChild(content);
        const childContext = propertyKey === 'bindings' ? {...context,bindingKey:key} : context;
        const read = valueEditor(content, child, propertyKey==='bindings'?`Cấu hình ${typeNames[fieldType] || fieldType}`:array ? `Mục ${rows.length + 1}` : captions[key] || 'Giá trị', array ? '' : key, childContext);
        const item = { keyInput, read }; rows.push(item);
        const remove = button('', () => { rows.splice(rows.indexOf(item), 1); row.remove(); if(propertyKey==='bindings' && context.template?.bindings)delete context.template.bindings[keyInput.value]; }); remove.className = 'wp-field-remove'; remove.appendChild(icon('fa-trash-can')); remove.title = array ? 'Xóa mục' : 'Xóa trường'; remove.setAttribute('aria-label', array ? 'Xóa mục' : `Xóa trường ${key}`); row.appendChild(remove); (technical && key !== 'sql' ? technical : list).appendChild(row);
        if(propertyKey==='bindings' && keyInput) {
          row.classList.add('wp-source-card');
          keyInput.parentElement.querySelector('.wp-field-heading').appendChild(remove);
        }
        if (technical && key === 'sql') remove.hidden = true;
      }
      Object.entries(value).forEach(([key, child]) => add(key, child));
      if (technical) group.appendChild(technical);
      const tools = document.createElement('div'); tools.className = 'wp-inline-actions';
      const addButton = button('Thêm', () => chooseFieldType(kind => {
        if (['sql','api','file','previous'].includes(kind)) {
          let number = 1; while (rows.some(row => row.keyInput?.value.trim() === `query_${number}`)) number++;
          const sources = [...new Set(Object.values(value).map(binding => binding?.dbSourceId).filter(Boolean))];
          const defaults = { sql:{ sql:'',dbSourceId:sources.length===1?sources[0]:'',tables:[],parameters:{},resultMapping:[] },api:{type:'api',url:'',method:'GET',query:{},dataPath:''},file:{type:'file',documentId:'',format:'auto',sheet:''},previous:{type:'previous',reference:''} };
          add(`query_${number}`,defaults[kind]);
          if(context.template) { context.template.bindings ||= {}; context.template.bindings[`query_${number}`]=defaults[kind]; }
        } else add(array ? String(rows.length) : '', ({ string: '', number: 0, boolean: false, object: {}, array: [] })[kind]);
        list.lastElementChild?.querySelector('input,textarea,select')?.focus();
      }, propertyKey === 'bindings'));
      addButton.prepend(icon('fa-plus')); addButton.setAttribute('aria-label', propertyKey === 'bindings' ? 'Thêm nguồn truy vấn' : `Thêm vào ${label}`); tools.appendChild(addButton); (technical || group).appendChild(tools);
      return () => {
        if (array) return rows.map(item => item.read());
        const result = Object.create(null);
        for (const item of rows) { const key = item.keyInput.value.trim(); if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(result, key)) throw new Error('Tên trường phải khác nhau và không được để trống.'); result[key] = item.read(); }
        return result;
      };
    }
    if (typeof value === 'boolean') { const input = field(container, label, '', { type: 'checkbox' }); input.checked = value; return () => input.checked; }
    if (value === null) { const hint = document.createElement('p'); hint.textContent = `${label}: không có giá trị`; container.appendChild(hint); return () => null; }
    const sql = propertyKey === 'sql' && typeof value === 'string';
    const input = typeof value === 'string' && (context.referencesAll || propertyKey === 'value') ? referenceInput(container,label,value,context) : field(container, label, value, { type: typeof value === 'number' ? 'number' : 'text', multiline: typeof value === 'string' && (sql || value.includes('\n')) });
    if (sql) { input.classList.add('wp-sql-editor'); input.rows = 10; codeField(input,'sql'); }
    if (typeof value === 'number') input.step = 'any';
    return () => { if (typeof value !== 'number') return input.value; if (!input.value.trim() || !Number.isFinite(Number(input.value))) throw new Error(`${label}: hãy nhập số hợp lệ.`); return Number(input.value); };
  }
  function structuredField(container, label, value, hint = '', propertyKey = '', context = {}) {
    const section = document.createElement('details'); section.className = 'wp-editor-section';
    const summary = document.createElement('summary'); summary.textContent = label; section.appendChild(summary); container.appendChild(section);
    if (hint) { const text = document.createElement('p'); text.textContent = hint; section.appendChild(text); }
    const content = document.createElement('div'); section.appendChild(content); let read = valueEditor(content, value, label, propertyKey,context);
    const advanced = document.createElement('details'); advanced.className = 'wp-advanced'; const title = document.createElement('summary'); title.textContent = 'Nâng cao: chỉnh JSON'; advanced.appendChild(title); section.appendChild(advanced);
    const raw = field(advanced, 'JSON dành cho quản trị kỹ thuật', '', { multiline: true,code:'json' }); raw.classList.add('workflow-json-editor','short'); let dirty = false;
    raw.oninput = () => { dirty = true; try { const parsed = JSON.parse(raw.value); content.replaceChildren(); read = valueEditor(content, parsed, label, propertyKey,context); dirty = false; } catch (_) { /* Show parse error on save without losing the last valid form. */ } };
    advanced.ontoggle = () => { if (advanced.open && !dirty) {raw.value = JSON.stringify(read(), null, 2);raw._renderCode?.();} };
    return () => dirty ? JSON.parse(raw.value) : read();
  }
  function slotsEditor(container, initial) {
    const section = document.createElement('section'); section.className = 'wp-slot-section'; section.innerHTML = '<h4>Thông tin cần thu thập</h4><p>Thêm ô nhập và câu hỏi để người dùng bổ sung khi chạy quy trình.</p>'; container.appendChild(section);
    const list = document.createElement('div'); section.appendChild(list); const rows = [];
    function add(key, slot) {
      const card = document.createElement('fieldset'); card.className = 'wp-slot-card wp-business-field'; const legend = document.createElement('legend'); legend.append(icon('fa-keyboard'), document.createTextNode(' ' + (slot.label || 'Ô nhập mới'))); card.appendChild(legend); list.appendChild(card);
      const grid = document.createElement('div'); grid.className = 'wp-form-grid'; card.appendChild(grid);
      const id = field(grid, 'Mã trường', key), label = field(grid, 'Tên hiển thị', slot.label || key);
      const ask = field(card, 'Câu hỏi khi thiếu thông tin', slot.ask || '');
      const typeWrap = document.createElement('label'); typeWrap.textContent = 'Kiểu ô nhập'; const type = document.createElement('select');
      [['string', 'Văn bản'], ['date', 'Ngày tháng'], ['integer', 'Số nguyên'], ['number', 'Số thập phân'], ['boolean', 'Có / Không'], ['object', 'Nhóm thông tin'], ['array', 'Danh sách']].forEach(([key, text]) => type.appendChild(new Option(text, key)));
      type.value = slot.schema.format === 'date' ? 'date' : slot.schema.type; typeWrap.appendChild(type); grid.appendChild(typeWrap);
      const required = field(grid, 'Bắt buộc nhập', '', { type: 'checkbox' }); required.checked = slot.required === true;
      const choices = field(card, 'Các lựa chọn cho người dùng (mỗi dòng một giá trị)', (slot.schema.enum || []).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value)).join('\n'), { multiline: true });
      const limits = document.createElement('div'); limits.className = 'wp-form-grid'; card.appendChild(limits);
      const minimum = field(limits, 'Giá trị tối thiểu', slot.schema.minimum ?? '', { type: 'number' }), maximum = field(limits, 'Giá trị tối đa', slot.schema.maximum ?? '', { type: 'number' }); minimum.step = maximum.step = 'any';
      const minLength = field(limits, 'Số ký tự tối thiểu', slot.schema.minLength ?? '', { type: 'number' }), maxLength = field(limits, 'Số ký tự tối đa', slot.schema.maxLength ?? '', { type: 'number' });
      const useDefault = field(card, 'Dùng giá trị mặc định khi người dùng chưa cung cấp', '', { type: 'checkbox' }); useDefault.checked = Object.hasOwn(slot, 'default');
      const defaultHost = document.createElement('div'); card.appendChild(defaultHost); const defaultRead = valueEditor(defaultHost, slot.default ?? '', 'Giá trị mặc định'); defaultHost.hidden = !useDefault.checked; useDefault.onchange = () => { defaultHost.hidden = !useDefault.checked; };
      const restSchema = { ...slot.schema }; for (const key of ['type', 'format', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength']) delete restSchema[key];
      const more = structuredField(card, 'Cấu trúc nhóm và giới hạn khác (nâng cao)', restSchema);
      const extras = { ...slot }; for (const key of ['label', 'ask', 'schema', 'required', 'default']) delete extras[key];
      const readExtras = structuredField(card, 'Điều kiện bổ sung (nâng cao)', extras);
      const item = { read: () => {
        const schema = { ...more(), type: type.value === 'date' ? 'string' : type.value }; if (type.value === 'date') schema.format = 'date'; else if (slot.schema.format && slot.schema.format !== 'date') schema.format = slot.schema.format;
        for (const [key, input] of [['minimum', minimum], ['maximum', maximum], ['minLength', minLength], ['maxLength', maxLength]]) if (input.value !== '') schema[key] = Number(input.value);
        const originalChoices = (slot.schema.enum || []).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value)).join('\n');
        if (choices.value === originalChoices && slot.schema.enum) schema.enum = structuredClone(slot.schema.enum);
        else if (choices.value.trim()) schema.enum = choices.value.split('\n').map(value => value.trim()).filter(Boolean).map(value => { if (['integer', 'number'].includes(schema.type)) { if (!Number.isFinite(Number(value))) throw new Error('Lựa chọn phải là số hợp lệ.'); return Number(value); } if (schema.type === 'boolean') { if (!['true', 'false'].includes(value)) throw new Error('Lựa chọn Có/Không dùng true hoặc false.'); return value === 'true'; } return value; });
        const result = { ...readExtras(), label: label.value, ask: ask.value, required: required.checked, schema };
        if (useDefault.checked) { const value = defaultRead(); result.default = ['number', 'integer'].includes(schema.type) && typeof value === 'string' ? Number(value) : schema.type === 'boolean' && typeof value === 'string' ? value === 'true' : value; }
        return [id.value.trim(), result];
      } }; rows.push(item);
      card.appendChild(button('Xóa ô nhập', () => { rows.splice(rows.indexOf(item), 1); card.remove(); }));
    }
    Object.entries(initial).forEach(([key, slot]) => add(key, slot)); section.appendChild(button('Thêm ô nhập', () => add('', { label: '', schema: { type: 'string' }, required: true })));
    return () => { const result = Object.create(null); for (const item of rows) { const [key, slot] = item.read(); if (!key || Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Mã ô nhập không được trống hoặc trùng nhau.'); result[key] = slot; } return result; };
  }
  async function refresh() {
    const panel=document.getElementById('workflow-plugin-panel'), message=document.getElementById('wp-message');
    panel?.setAttribute('aria-busy','true');
    if(message) { message.style.color=''; message.innerHTML='<span class="tab-data-spinner" aria-hidden="true"></span><span>Đang tải mẫu nghiệp vụ…</span>'; }
    try {
    const accountRequest = api('/api/auth/me');
    const packagesRequest = accountRequest.then(account => account.account?.role === 'admin' ? api('/api/workflow-plugins') : { packages: [] });
    const [account, catalog, runs, packages] = await Promise.all([accountRequest, api('/api/question-templates'), api('/api/automation-runs?summary=1'), packagesRequest]);
    state.admin = account.account?.role === 'admin'; state.templates = catalog.templates; state.runs = runs.runs; state.settings = catalog.settings;
    state.packages = packages.packages;
    render();
    if(message) message.replaceChildren();
    } catch(failure) { notify(failure.message,true); throw failure; }
    finally { panel?.removeAttribute('aria-busy'); }
  }
  function render() {
    const toolbar = document.getElementById('wp-toolbar'); if (!toolbar) return;
    toolbar.replaceChildren(); const heading = document.querySelector('#workflow-plugin-panel > .module-section-heading'); heading.querySelector('.wp-status')?.remove(); const status = document.createElement('span'); status.className = 'wp-status' + (state.settings.enabled ? ' enabled' : ''); status.textContent = state.settings.enabled ? 'Đang hoạt động' : 'Chưa bật'; heading.appendChild(status);
    const refreshButton = button('Làm mới', refresh); refreshButton.classList.add('wp-refresh'); refreshButton.prepend(icon('fa-rotate')); toolbar.appendChild(refreshButton);
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Tìm mẫu nghiệp vụ…'; search.value = state.search; search.setAttribute('aria-label', 'Tìm template và gói nghiệp vụ'); search.className = 'wp-search'; const searchBox = document.createElement('label'); searchBox.className = 'wp-search-box'; searchBox.append(icon('fa-magnifying-glass'), search); toolbar.appendChild(searchBox);
    const domains = document.createElement('select'); domains.setAttribute('aria-label', 'Lọc lĩnh vực');
    const draftDomains = state.admin ? state.packages.flatMap(record => record.draft.templates.map(template => template.domain || record.draft.manifest.domain || '')) : [];
    for (const domain of ['', ...new Set([...state.templates.map(template => template.domain), ...draftDomains].filter(Boolean))]) { const option = document.createElement('option'); option.value = domain; option.textContent = domain || 'Tất cả lĩnh vực'; domains.appendChild(option); }
    domains.value = state.domain; const domainBox = document.createElement('div'); domainBox.className = 'wp-domain-filter'; domainBox.append(icon('fa-layer-group'), domains); toolbar.appendChild(domainBox);
    const matches = definition => (!state.domain || definition.domain === state.domain) && `${definition.name} ${definition.description || ''} ${(definition.tags || []).join(' ')}`.toLocaleLowerCase().includes(state.search.toLocaleLowerCase());
    search.oninput = () => { state.search = search.value; render(); const input = document.querySelector('#wp-toolbar input'); input.focus(); input.setSelectionRange(state.search.length, state.search.length); }; domains.onchange = () => { state.domain = domains.value; render(); };
    if (state.admin) {
      if (!state.settings.enabled && !state.settings.disabledByEnvironment) toolbar.appendChild(button('Bật workflow/plugin', async () => { await api('/api/workflow-plugins/settings', 'PUT', { enabled: true, revision: state.settings.revision }); await refresh(); }));
      const importButton = button('Import gói', () => importDialog()); importButton.prepend(icon('fa-arrow-up-from-bracket')); toolbar.appendChild(importButton);
      const createButton = button('Tạo mẫu', () => editDialog({ draft: blankBundle(), revision: null })); createButton.className = 'btn-primary wp-create-template'; createButton.prepend(icon('fa-plus')); toolbar.appendChild(createButton);
    }
    const packages = document.getElementById('wp-packages'); packages.replaceChildren();
    document.getElementById('wp-drafts-section').hidden = false;
    document.querySelector('#wp-drafts-section h3').textContent = state.admin ? 'Thiết kế nghiệp vụ' : 'Mẫu nghiệp vụ';
    document.querySelector('#wp-drafts-section .wp-section-heading p').textContent = state.admin ? 'Soạn kịch bản và chạy thử trước khi đưa vào hội thoại.' : 'Chọn mẫu hoặc hỏi trợ lý về nghiệp vụ để bắt đầu.';
    for (const record of state.packages) for (const [templateIndex, definition] of record.draft.templates.entries()) {
      const domain = definition.domain || record.draft.manifest.domain || '';
      if (!matches({ ...record.draft.manifest, ...definition, domain })) continue;
      const card = document.createElement('article'); card.className = 'workflow-manager-card';
      card.dataset.templateId = definition.id;
      card.innerHTML = `<h3>${h(definition.name)}</h3><p>${h(definition.description)}</p><small>${h(record.draft.manifest.name)} · Draft v${record.draft.manifest.version} · ${record.published ? `Published v${record.published.manifest.version}` : 'Chưa publish'}</small><p>${definition.workflow.steps.length} bước · ${Object.keys(definition.inputs).length} ô nhập · ${record.lastTest ? (record.lastTest.passed ? 'Kiểm thử đạt' : 'Kiểm thử chưa đạt') : 'Chưa chạy kiểm thử'}</p>`;
      decorateCard(card, definition);
      const available = state.templates.find(template => template.id === `${record.id}/${definition.id}`);
      cardMetadata(card,domain,[...(record.draft.manifest.tags||[]),...(definition.tags||[])],Boolean(available));
      const actions = document.createElement('div'); actions.className = 'workflow-card-actions';
      actions.appendChild(button('Sửa template', () => editDialog(record, templateIndex)));
      if (available) actions.appendChild(chatButton(available));
      if (available) actions.appendChild(button('Thử kịch bản', async () => { const { execution } = await api('/api/automation-runs', 'POST', { templateId: available.id, inputs: {}, conversationId: `manual-${crypto.randomUUID()}`, requestId: crypto.randomUUID() }); showRun(execution); await refresh(); }));
      const deleteTemplate = button('Xóa mẫu', async () => { if (!await confirmDelete(`Xóa mẫu “${definition.name}”? Mẫu sẽ không còn được chọn cho tác vụ mới.`)) return; await api(`/api/question-templates/${encodeURIComponent(`${record.id}/${definition.id}`)}`, 'DELETE', { revision: record.revision }); await refresh(); }); deleteTemplate.classList.add('wp-danger-action'); actions.appendChild(deleteTemplate);
      for (const [label, operation] of [['Validate', 'validate'], ['Chạy fixture', 'test'], ['Publish', 'publish']]) actions.appendChild(button(label, async () => { const report = await api(`/api/workflow-plugins/${encodeURIComponent(record.id)}/${operation}`, 'POST', { revision: record.revision }); if (report.results) { const dialog = modal('Kết quả kiểm thử'); const pre = document.createElement('pre'); pre.textContent = JSON.stringify(report, null, 2); dialog.body.appendChild(pre); } await refresh(); }));
      actions.appendChild(button(record.enabled ? 'Vô hiệu hóa' : 'Kích hoạt', async () => { await api(`/api/workflow-plugins/${encodeURIComponent(record.id)}/enabled`, 'POST', { enabled: !record.enabled, revision: record.revision }); await refresh(); }));
      actions.appendChild(button('Export', () => { const blob = new Blob([JSON.stringify(record.published || record.draft, null, 2)], { type: 'application/json' }); const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `${record.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 1000); }));
      if (record.published) {
        actions.appendChild(button('Tùy chỉnh scope', () => overlayDialog(record)));
        actions.appendChild(button('Rollback', () => rollbackDialog(record)));
      }
      const more = document.createElement('details'); more.className = 'wp-more-menu';
      const trigger = document.createElement('summary'); trigger.setAttribute('role', 'button'); trigger.setAttribute('aria-label', 'Thêm thao tác'); trigger.setAttribute('aria-expanded', 'false'); trigger.appendChild(icon('fa-ellipsis')); more.appendChild(trigger);
      const menu = document.createElement('div'); menu.className = 'wp-more-items'; more.appendChild(menu);
      const icons = { 'Sửa template': 'fa-pen', 'Chạy fixture': 'fa-flask', Publish: 'fa-cloud-arrow-up', Validate: 'fa-check-double', Export: 'fa-download', 'Vô hiệu hóa': 'fa-pause', 'Kích hoạt': 'fa-play', 'Xóa mẫu': 'fa-trash-can', 'Tùy chỉnh scope': 'fa-sliders', Rollback: 'fa-clock-rotate-left' };
      for (const action of [...actions.children]) {
        const label = action.textContent; action.prepend(icon(icons[label] || 'fa-gear'));
        if (!['Sửa template', 'Chạy fixture', 'Publish', 'Dùng trong chat'].includes(label)) menu.appendChild(action);
      }
      menu.addEventListener('click', event => { if (event.target.closest('button')) more.open = false; });
      more.addEventListener('toggle', () => { trigger.setAttribute('aria-expanded', String(more.open)); if (more.open) document.querySelectorAll('.wp-more-menu[open]').forEach(item => { if (item !== more) item.open = false; }); });
      more.addEventListener('keydown', event => { if (event.key === 'Escape') { more.open = false; trigger.focus(); } });
      actions.appendChild(more);
      card.appendChild(actions); packages.appendChild(card);
    }
    const templates = packages;
    for (const template of state.admin ? [] : state.templates.filter(matches)) {
      const card = document.createElement('article'); card.className = 'workflow-manager-card'; card.innerHTML = `<h3>${h(template.name)}</h3><p>${h(template.description)}</p><small>v${template.packageVersion}${template.overlayVersion ? ` · Tùy chỉnh v${template.overlayVersion}` : ''}</small>`;
      decorateCard(card, template);
      cardMetadata(card,template.domain,template.tags,true);
      const examples = document.createElement('p'); examples.className = 'wp-example'; examples.textContent = template.examples?.[0] ? `Cách hỏi: “${template.examples[0]}”` : 'Hỏi trợ lý về nghiệp vụ này để bắt đầu.'; card.appendChild(examples);
      card.appendChild(chatButton(template));
      if (state.admin) card.appendChild(button('Thử kịch bản', async () => { const { execution } = await api('/api/automation-runs', 'POST', { templateId: template.id, inputs: {}, conversationId: `manual-${crypto.randomUUID()}`, requestId: crypto.randomUUID() }); showRun(execution); await refresh(); })); templates.appendChild(card);
    }
    if (!packages.children.length && state.admin) emptyState(packages, 'fa-pen-ruler', 'Chưa có mẫu đang thiết kế', state.search || state.domain ? 'Thử đổi từ khóa hoặc lĩnh vực để tìm mẫu.' : 'Chọn Tạo template để định nghĩa nghiệp vụ, hoặc Nạp 5 mẫu để bắt đầu từ ví dụ.');
    if (!templates.children.length && !state.admin) emptyState(templates, 'fa-comment-dots', 'Chưa có mẫu sẵn sàng', state.search || state.domain ? 'Không có mẫu phù hợp với bộ lọc hiện tại.' : 'Mẫu sẽ xuất hiện tại đây sau khi quản trị viên kiểm thử và phát hành.');
    const runs = document.getElementById('wp-runs'); runs.replaceChildren();
    for (const execution of state.runs) { const row = button(`${execution.name} · ${statuses[execution.status]} · ${new Date(execution.updatedAt).toLocaleString('vi-VN')}`, () => showRun(execution)); row.classList.add('workflow-run-row'); runs.appendChild(row); }
    if (!state.runs.length) emptyState(runs, 'fa-clock-rotate-left', 'Chưa có lần thực hiện nào', 'Khi bạn hỏi một nghiệp vụ trong chat, tiến trình và kết quả sẽ được lưu tại đây.');
  }
  document.addEventListener('click', event => { document.querySelectorAll('.wp-more-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }); });
  function chatButton(template) { return button('Dùng trong chat', async () => { await window.switchMainTab('page_chat'); const input = document.getElementById('page-chat-user-input'); if (input) { input.value = template.examples?.[0] || template.name; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); } }); }
  function blankTemplate() {
    return { id: '', name: 'Nghiệp vụ mới', description: '', examples: [], inputs: {}, allowedCapabilities: ['data.transform'], workflow: { steps: [{ id: 'prepare', name: 'Chuẩn bị kết quả', type: 'transform', config: { mapping: {} } }] }, output: { mapping: {}, schema: { type: 'object', properties: {}, additionalProperties: true } }, fixtures: [{ input: {}, expected: {} }] };
  }
  function blankBundle() { return { manifest: { id: '', name: 'Nghiệp vụ mới', version: 1, engineContractVersion: 1 }, templates: [blankTemplate()] }; }
  function outputForm(container, initial) {
    if (initial.schema.type !== 'object' || Array.isArray(initial.mapping) || typeof initial.mapping !== 'object') return structuredField(container, 'Kết quả trả về trong chat', initial);
    const section = document.createElement('details'); section.className = 'wp-editor-section wp-output-section';
    section.innerHTML = '<summary><i class="fa-solid fa-table-list" aria-hidden="true"></i> Kết quả trả về trong chat</summary><p class="wp-section-help">Mỗi dòng là một cột trong câu trả lời. Đặt tên dễ hiểu và chọn giá trị lấy từ bước xử lý.</p>'; container.appendChild(section);
    const list = document.createElement('div'); section.appendChild(list); const rows = [];
    function add(key, schema, mapped) {
      const card = document.createElement('div'); card.className = 'wp-output-column'; list.appendChild(card);
      const heading = document.createElement('div'); heading.className = 'wp-output-column-heading'; heading.appendChild(icon('fa-table-columns')); const caption = document.createElement('strong'); caption.textContent = initial.presentation?.labels?.[key] || key || 'Cột mới'; heading.appendChild(caption); card.appendChild(heading);
      const grid = document.createElement('div'); grid.className = 'wp-form-grid'; card.appendChild(grid);
      const code = field(grid, 'Mã cột', key), label = field(grid, 'Tên hiển thị', initial.presentation?.labels?.[key] || key);
      label.oninput = () => { caption.textContent = label.value || code.value || 'Cột mới'; };
      const wrap = document.createElement('label'); wrap.textContent = 'Kiểu dữ liệu'; const type = document.createElement('select'); type.setAttribute('aria-label', 'Kiểu dữ liệu cột');
      [['string', 'Văn bản'], ['date', 'Ngày tháng'], ['integer', 'Số nguyên'], ['number', 'Số thập phân'], ['boolean', 'Có / Không'], ['object', 'Nhóm thông tin'], ['array', 'Danh sách']].forEach(([key, text]) => type.appendChild(new Option(text, key))); type.value = schema?.format === 'date' ? 'date' : schema?.type || 'string'; wrap.appendChild(type); grid.appendChild(wrap);
      const required = field(grid, 'Bắt buộc có trong kết quả', '', { type: 'checkbox' }); required.checked = (initial.schema.required || []).includes(key);
      const mappedRead = valueEditor(card, mapped === undefined ? '' : mapped, 'Giá trị lấy từ kịch bản');
      const hint = document.createElement('p'); hint.className = 'wp-field-hint'; hint.textContent = 'Ví dụ: {{steps.prepare.code}} lấy mã từ bước prepare.'; card.appendChild(hint);
      const extraSchema = { ...(schema || {}) }; delete extraSchema.type; delete extraSchema.format;
      const constraints = structuredField(card, 'Giới hạn dữ liệu (nâng cao)', extraSchema);
      const row = { read: () => { const resultSchema = { ...constraints(), type: type.value === 'date' ? 'string' : type.value }; if (type.value === 'date') resultSchema.format = 'date'; else if (schema?.format && schema.format !== 'date') resultSchema.format = schema.format; return { key: code.value.trim(), label: label.value, schema: resultSchema, mapped: mappedRead(), required: required.checked }; } }; rows.push(row);
      const remove = button('', () => { rows.splice(rows.indexOf(row), 1); card.remove(); }); remove.className = 'wp-field-remove'; remove.setAttribute('aria-label', 'Xóa cột kết quả'); remove.appendChild(icon('fa-trash-can')); heading.appendChild(remove);
    }
    const keys = [...new Set([...Object.keys(initial.schema.properties || {}), ...Object.keys(initial.mapping)])]; keys.forEach(key => add(key, initial.schema.properties?.[key], initial.mapping[key]));
    const addButton = button('Thêm cột kết quả', () => add('', { type: 'string' }, '')); addButton.prepend(icon('fa-plus')); section.appendChild(addButton);
    return () => {
      const result = structuredClone(initial); result.mapping = {}; result.schema.properties = {}; const required = [];
      for (const row of rows) { const item = row.read(); if (!item.key || Object.hasOwn(result.mapping, item.key) || ['__proto__', 'constructor', 'prototype'].includes(item.key)) throw new Error('Mã cột kết quả phải khác nhau và không được trống.'); result.mapping[item.key] = item.mapped; result.schema.properties[item.key] = item.schema; if (item.required) required.push(item.key); if (item.label !== (initial.presentation?.labels?.[item.key] || item.key)) { result.presentation ||= {}; result.presentation.labels ||= {}; result.presentation.labels[item.key] = item.label; } }
      if (initial.schema.required || required.length) result.schema.required = required;
      return result;
    };
  }
  function nodeForm(container, type, config, template, onSourceSelected, onAddSource) {
    const value = structuredClone(config), readers = {};
    const text = (key, label, fallback = '') => { const input = field(container, label, value[key] ?? fallback); readers[key] = () => input.value; };
    const choose = (key, label, options, fallback) => {
      const wrap = document.createElement('label'); wrap.textContent = label; const select = document.createElement('select'); select.setAttribute('aria-label',label); options.forEach(([key, name]) => select.appendChild(new Option(name, key))); select.value = value[key] ?? fallback; wrap.appendChild(select); container.appendChild(wrap); readers[key] = () => select.value;
    };
    if (type === 'transform') readers.mapping = valueEditor(container, value.mapping || {}, 'Trường dữ liệu cần tạo');
    if (['condition', 'assert'].includes(type)) {
      choose('operator', 'Phép so sánh', [['equals', 'Bằng'], ['notEquals', 'Khác'], ['greaterThan', 'Lớn hơn'], ['lessThan', 'Nhỏ hơn'], ['exists', 'Có giá trị'], ['contains', 'Chứa'], ['in', 'Thuộc danh sách']], 'equals');
      readers.left = valueEditor(container, value.left ?? '', 'Vế trái (giữ kiểu dữ liệu)');
      readers.right = valueEditor(container, value.right ?? '', 'Giá trị so sánh');
      if (type === 'assert') text('message', 'Thông báo khi không đạt', 'Dữ liệu chưa hợp lệ.');
    }
    if (type === 'delay') { const input = field(container, 'Thời gian chờ (mili giây)', value.delayMs ?? 1000, { type: 'number' }); input.min = 0; input.max = 60000; readers.delayMs = () => Number(input.value); }
    if (['sql','source'].includes(type)) {
      const options=Object.entries(template.bindings || {}).map(([key,binding])=>[key,`${key} · ${binding.type || 'sql'}`]);
      choose('bindingRef','Nguồn dữ liệu sử dụng',options,value.bindingRef || options[0]?.[0] || '');
      const select=container.lastElementChild.querySelector('select');
      const hint=document.createElement('p'); hint.className='wp-section-help'; container.appendChild(hint);
      const update=()=>{const previous=select.value;select.replaceChildren();Object.entries(template.bindings || {}).forEach(([key,binding])=>select.appendChild(new Option(`${key} · ${binding.type || 'sql'}`,key)));if([...select.options].some(option=>option.value===previous))select.value=previous;
        if(!select.options.length) select.appendChild(new Option('Chưa có nguồn dữ liệu',''));
        hint.textContent='Danh sách lấy từ tab Nguồn dữ liệu. Thêm nguồn SQL, API, file hoặc kết quả bước trước tại tab đó để có thêm lựa chọn.';
      };
      update();
      select.onchange=()=>onSourceSelected?.(select.value,template.bindings?.[select.value]?.type || 'sql');
      select.addEventListener('focus',update); select.addEventListener('pointerdown',update);
      if(onAddSource) { const add=button('Thêm nguồn dữ liệu',onAddSource); add.prepend(icon('fa-plus')); container.appendChild(add); }
    }
    if (type === 'collect') {
      const picked = [];
      for (const [key, slot] of Object.entries(template.inputs)) { const input = field(container, slot.label || key, '', { type: 'checkbox' }); input.checked = (value.slots || []).includes(key); picked.push([key, input]); }
      readers.slots = () => picked.filter(([, input]) => input.checked).map(([key]) => key);
      if (!picked.length) { const hint = document.createElement('p'); hint.textContent = 'Định nghĩa ô nhập ở phần nhận diện nghiệp vụ trước khi chọn thông tin cần thu thập.'; container.appendChild(hint); }
    }
    if (type === 'export') { readers.data = valueEditor(container, value.data ?? '', 'Dữ liệu xuất'); text('filename', 'Tên file', 'Bao_cao'); choose('format', 'Định dạng file', [['csv', 'CSV'], ['xlsx', 'Excel']], 'csv'); }
    for (const key of Object.keys(readers)) delete value[key];
    const extras = structuredField(container, 'Cấu hình bổ sung (nâng cao)', value);
    return () => ({ ...extras(), ...Object.fromEntries(Object.entries(readers).map(([key, read]) => [key, read()])) });
  }
  function fixturesForm(container, initial, getInputs, getOutput) {
    const section = document.createElement('details'); section.className = 'wp-editor-section wp-fixtures-section';
    section.innerHTML = '<summary><i class="fa-solid fa-flask" aria-hidden="true"></i> Các trường hợp chạy thử</summary><p class="wp-section-help">Nhập dữ liệu thử và kết quả bạn mong đợi. Hệ thống sẽ chạy kịch bản và so sánh hai kết quả trước khi phát hành.</p>'; container.appendChild(section);
    const list = document.createElement('div'); section.appendChild(list); const cases = [];
    function valuesForm(host, current, definitions, labels) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return valueEditor(host, current, 'Kết quả mong đợi');
      const readers = [];
      for (const key of new Set([...Object.keys(definitions), ...Object.keys(current)])) {
        const schema = definitions[key]?.schema || definitions[key] || { type: 'string' }, label = labels[key] || key;
        const row = document.createElement('div'); row.className = 'wp-test-value'; host.appendChild(row);
        const include = field(row, label, '', { type: 'checkbox' }); include.checked = Object.hasOwn(current, key); include.title='Bật để đưa trường này vào trường hợp chạy thử'; include.parentElement.classList.add('wp-test-field-heading'); include.parentElement.prepend(include);
        const content = document.createElement('div'); row.appendChild(content);
        const initial=Object.hasOwn(current,key)?current[key]:schema.type==='boolean'?false:['integer','number'].includes(schema.type)?0:schema.type==='object'?{}:schema.type==='array'?[]:'';
        const complex=initial!==null && typeof initial==='object'; let editor=content;
        if(complex) {
          row.classList.add('wp-test-complex');
          const details=document.createElement('details'); details.className='wp-test-data-details';
          const summary=document.createElement('summary'); summary.textContent=Array.isArray(initial)?`${initial.length} mục · Xem và chỉnh dữ liệu`:`${Object.keys(initial).length} trường · Xem và chỉnh dữ liệu`; details.appendChild(summary); content.appendChild(details); editor=details;
        }
        const read = valueEditor(editor, initial, label);
        if(!complex) { const valueLabel=editor.querySelector(':scope > label'); if(valueLabel?.firstChild?.nodeType===Node.TEXT_NODE) valueLabel.firstChild.remove(); }
        content.hidden = !include.checked; include.onchange = () => { content.hidden = !include.checked; }; readers.push([key, include, read]);
      }
      if (!readers.length) { const hint = document.createElement('p'); hint.textContent = 'Không có trường dữ liệu trong trường hợp này.'; host.appendChild(hint); }
      return () => Object.fromEntries(readers.filter(([, include]) => include.checked).map(([key, , read]) => [key, read()]));
    }
    function add(fixture) {
      const card = document.createElement('article'); card.className = 'wp-fixture-card'; list.appendChild(card);
      const title = document.createElement('div'); title.className = 'wp-output-column-heading'; title.appendChild(icon('fa-vial-circle-check')); card.appendChild(title);
      const caseName = field(title, 'Tên trường hợp', fixture.name || `Trường hợp ${cases.length + 1}`);
      const grid = document.createElement('div'); grid.className = 'wp-fixture-grid'; card.appendChild(grid);
      const inputHost = document.createElement('section'), expectedHost = document.createElement('section'); inputHost.innerHTML = '<h4><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i> Dữ liệu đầu vào</h4>'; expectedHost.innerHTML = '<h4><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Kết quả mong đợi</h4>'; grid.append(inputHost, expectedHost);
      const expectedHint=document.createElement('p'); expectedHint.className='wp-section-help'; expectedHint.textContent='Chỉ chọn các trường cần so sánh khi chạy thử.'; expectedHost.appendChild(expectedHint);
      const inputs = getInputs(), output = getOutput();
      const readInput = valuesForm(inputHost, fixture.input, inputs, Object.fromEntries(Object.entries(inputs).map(([key, slot]) => [key, slot.label || key])));
      const readExpected = output.schema.type === 'object' ? valuesForm(expectedHost, fixture.expected, output.schema.properties || {}, output.presentation?.labels || {}) : valueEditor(expectedHost, fixture.expected, 'Kết quả mong đợi');
      const extras = { ...fixture }; delete extras.input; delete extras.expected; delete extras.name;
      const readExtras = structuredField(card, 'Dữ liệu giả lập từng bước và tùy chọn khác (nâng cao)', extras);
      const row = { read: () => { const result = { ...readExtras(), input: readInput(), expected: readExpected() }; if (fixture.name !== undefined || caseName.value !== `Trường hợp ${cases.indexOf(row) + 1}`) result.name = caseName.value; return result; } }; cases.push(row);
      const remove = button('', () => { cases.splice(cases.indexOf(row), 1); card.remove(); }); remove.className = 'wp-field-remove'; remove.setAttribute('aria-label', 'Xóa trường hợp chạy thử'); remove.appendChild(icon('fa-trash-can')); title.appendChild(remove);
    }
    initial.forEach(add);
    let definitions = JSON.stringify([getInputs(), getOutput()]);
    section.addEventListener('toggle', () => { if (!section.open) return; try { const current = JSON.stringify([getInputs(), getOutput()]); if (current === definitions) return; const fixtures = cases.map(row => row.read()); list.replaceChildren(); cases.length = 0; fixtures.forEach(add); definitions = current; } catch (failure) { notify(failure.message, true); } });
    const create = button('Thêm trường hợp chạy thử', () => add({ input: {}, expected: getOutput().schema.type === 'object' ? {} : '' })); create.prepend(icon('fa-plus')); section.appendChild(create);
    return () => cases.map(row => row.read());
  }
  function importExamples(bundle, prefix = 'phase1_example') {
    const dialog = modal('Nạp các mẫu minh họa riêng biệt');
    const note = document.createElement('p'); note.textContent = 'Mỗi mẫu được lưu riêng để chỉnh sửa, kiểm thử và phát hành độc lập.'; dialog.body.appendChild(note);
    bundle.templates.forEach(template => { const row = document.createElement('article'); row.className = 'wp-example'; row.textContent = `${template.name} · ${template.workflow.steps.length} bước`; dialog.body.appendChild(row); });
    const errors = document.createElement('p'); errors.setAttribute('role', 'alert'); dialog.body.appendChild(errors);
    dialog.footer.appendChild(button('Import draft', async () => {
      try {
        for (const template of bundle.templates) {
          const id = `${prefix}_${template.id}`, previous = state.packages.find(item => item.id === id);
          if (previous) continue;
          const single = { manifest: { ...bundle.manifest, id, name: template.name }, templates: [structuredClone(template)] };
          if (bundle.legacySkills) single.legacySkills = bundle.legacySkills.filter(skill => skill.id === template.legacySkillRef?.id);
          await api('/api/workflow-plugins', 'POST', { bundle: single, revision: null });
        }
        dialog.backdrop.remove(); await refresh();
      } catch (failure) { errors.textContent = failure.message; await refresh(); }
    }));
  }
  function importDialog(bundle) {
    const dialog = modal('Import gói nghiệp vụ');
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; dialog.body.appendChild(file);
    const advanced = document.createElement('details'); advanced.className = 'wp-advanced'; advanced.innerHTML = '<summary>Nâng cao: xem hoặc sửa nội dung gói</summary>'; dialog.body.appendChild(advanced);
    const editor = field(advanced, 'Definition JSON', JSON.stringify(bundle || { manifest: { id: 'my_package', name: 'Gói mới', version: 1, engineContractVersion: 1 }, templates: [] }, null, 2), { multiline: true });
    const summary = document.createElement('p'); dialog.body.insertBefore(summary, advanced); const describe = () => { try { const data = JSON.parse(editor.value); summary.textContent = `${data.manifest.name} · ${data.templates.length} mẫu quy trình`; } catch (_) { summary.textContent = 'File chưa có cấu trúc gói hợp lệ.'; } }; describe(); file.onchange = async () => { if (file.files[0]) { editor.value = await file.files[0].text(); describe(); } };
    const errors = document.createElement('p'); errors.setAttribute('role', 'alert'); dialog.body.appendChild(errors);
    dialog.footer.appendChild(button('Import draft', async () => { try { const parsed = JSON.parse(editor.value); const previous = state.packages.find(item => item.id === parsed.manifest.id); await api('/api/workflow-plugins', 'POST', { bundle: parsed, revision: previous?.revision ?? null }); dialog.backdrop.remove(); await refresh(); } catch (failure) { errors.textContent = failure.message; } }));
  }
  let configTabsId = 0;
  function configTabs(container, activeIndex, onSelect) {
    const sections = [...container.children].filter(child => child.tagName === 'DETAILS');
    const labels = ['Nhận diện & đầu vào', 'Nguồn dữ liệu', 'Kịch bản các bước', 'Kết quả', 'Chạy thử'];
    const tabList = document.createElement('div'); tabList.className = 'wp-config-tabs'; tabList.setAttribute('role', 'tablist'); tabList.setAttribute('aria-label', 'Cấu hình chung của mẫu');
    container.insertBefore(tabList, sections[0]);
    const prefix = `wp-config-${++configTabsId}`;
    const tabs = [], panels = [];
    sections.forEach((section, index) => {
      const panel = document.createElement('section'); panel.className = section.className + ' wp-config-tab-panel'; panel.id = `${prefix}-panel-${index}`;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `${prefix}-tab-${index}`);
      const summary = section.querySelector(':scope > summary');
      const heading = document.createElement('div'); heading.className = 'wp-config-panel-heading';
      heading.append(...summary.childNodes); heading.querySelector(':scope > i:last-child')?.remove();
      summary.remove(); panel.append(heading, ...section.childNodes); section.replaceWith(panel); panels.push(panel);
      const tab = button(labels[index], () => activate(index)); tab.id = `${prefix}-tab-${index}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
      const symbol = heading.querySelector('.wp-config-icon i'); if (symbol) tab.prepend(symbol.cloneNode(true));
      tabList.appendChild(tab); tabs.push(tab);
      tab.addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null;
        if (next !== null) { event.preventDefault(); activate(next); tabs[next].focus(); }
      });
    });
    function activate(index) {
      tabs.forEach((tab, position) => { tab.setAttribute('aria-selected', String(position === index)); tab.tabIndex = position === index ? 0 : -1; panels[position].hidden = position !== index; });
      onSelect(index);
    }
    activate(activeIndex);
  }
  function editDialog(record, initialIndex = 0) {
    const dialog = modal('Thiết lập mẫu nghiệp vụ'); dialog.backdrop.classList.add('wp-business-editor'); const bundle = structuredClone(record.draft);
    const packageSection = document.createElement('details'); packageSection.className = 'wp-editor-section'; packageSection.open = !record.id; packageSection.innerHTML = '<summary>Thông tin lưu trữ và phân loại mẫu</summary>'; dialog.body.appendChild(packageSection);
    const packageFields = document.createElement('div'); packageFields.className = 'wp-form-grid wp-package-fields'; packageSection.appendChild(packageFields);
    const packageId = field(packageFields, 'ID gói', bundle.manifest.id); packageId.readOnly = Boolean(record.id);
    const packageName = field(packageFields, 'Tên gói', bundle.manifest.name);
    const domain = field(packageFields, 'Lĩnh vực', bundle.manifest.domain || '');
    const tags = field(packageFields, 'Từ khóa (phân cách bằng dấu phẩy)', (bundle.manifest.tags || []).join(', '));
    packageId.placeholder = 'Mã định danh duy nhất'; packageName.placeholder = 'Tên gói nghiệp vụ'; domain.placeholder = 'Ví dụ: Nhân sự, Kế toán'; tags.placeholder = 'Nhập các từ khóa để tìm mẫu';
    const selectLabel = document.createElement('label'); selectLabel.textContent = 'Chọn mẫu cần chỉnh sửa';
    const select = document.createElement('select');
    function updateOptions(index) { select.replaceChildren(); bundle.templates.forEach((template, position) => select.appendChild(new Option(template.name, String(position)))); select.value = String(index); }
    updateOptions(initialIndex); selectLabel.appendChild(select);
    const selectorBar = document.createElement('div'); selectorBar.className = 'wp-selector-bar'; selectorBar.appendChild(selectLabel); packageSection.insertBefore(selectorBar, packageFields);
    selectorBar.appendChild(button('Định nghĩa mẫu mới', () => { saveCurrent(); bundle.templates.push(blankTemplate()); previous = String(bundle.templates.length - 1); updateOptions(previous); renderTemplate(); }));
    const fields = document.createElement('div'); dialog.body.appendChild(fields); let saveCurrent, activeConfigTab = 0;
    function renderTemplate() {
      fields.replaceChildren(); fields.className = 'wp-builder-grid'; const template = bundle.templates[Number(select.value)];
      const main = document.createElement('div'); main.className = 'wp-builder-main'; fields.appendChild(main);
      const shared = document.createElement('section'); shared.className = 'wp-shared-config';
      shared.innerHTML = '<div class="wp-scope-heading"><i class="fa-solid fa-sliders" aria-hidden="true"></i><div><h4>Cấu hình chung của mẫu</h4><p>Áp dụng cho toàn bộ nghiệp vụ, không phụ thuộc node đang chọn.</p></div><span>Toàn bộ mẫu</span></div>';
      const recognition = document.createElement('details'); recognition.className = 'wp-editor-section wp-recognition-section'; recognition.open = !template.id;
      const recognitionTitle = document.createElement('summary'); recognitionTitle.append(icon('fa-bullseye'), document.createTextNode(' Nhận diện nghiệp vụ và thông tin cần hỏi')); recognition.appendChild(recognitionTitle); main.appendChild(recognition);
      const about = document.createElement('div'); about.className = 'wp-recognition-about'; about.innerHTML = '<h4>Nghiệp vụ này xử lý việc gì?</h4><p class="wp-section-help">Tên và mô tả giúp trợ lý chọn đúng kịch bản từ câu hỏi của người dùng.</p>'; recognition.appendChild(about);
      const templateId = field(about, 'Mã mẫu nghiệp vụ', template.id); templateId.readOnly = Boolean(record.id && record.draft.templates.some(item => item.id === template.id));
      const name = field(about, 'Tên template', template.name), description = field(about, 'Mô tả', template.description);
      name.oninput = () => { select.options[Number(select.value)].textContent = name.value || 'Mẫu chưa đặt tên'; };
      const enabledLabel = document.createElement('label'); enabledLabel.textContent = 'Cho phép dùng template'; const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = template.enabled !== false; enabledLabel.appendChild(enabled); recognition.appendChild(enabledLabel);
      const matching = document.createElement('div'); matching.className = 'wp-recognition-about'; matching.innerHTML = '<h4>Khi nào cần chạy kịch bản?</h4><p class="wp-section-help">Thêm các cách hỏi thường gặp và hướng dẫn trợ lý xử lý nghiệp vụ.</p>'; recognition.appendChild(matching);
      const examples = field(matching, 'Cách hỏi mẫu — mỗi dòng một câu', template.examples.join('\n'), { multiline: true }); examples.placeholder = 'Ví dụ: Tra cứu thông tin khách hàng\nTìm khách hàng theo mã';
      const instructions = field(matching, 'Hướng dẫn xử lý nghiệp vụ', template.instructions || '', { multiline: true });
      const slots = slotsEditor(recognition, template.inputs);
      const scriptHeader = document.createElement('div'); scriptHeader.className = 'wp-script-header'; main.appendChild(scriptHeader);
      const heading = document.createElement('h4'); heading.textContent = 'Kịch bản các bước'; scriptHeader.appendChild(heading);
      const hint = document.createElement('p'); hint.textContent = 'Chọn bước để chỉnh sửa bên dưới. Các bước chạy theo thứ tự từ trái sang phải.'; main.appendChild(hint);
      const workspace = document.createElement('div'); workspace.className = 'wp-script-workspace'; main.appendChild(workspace);
      const pipeline = document.createElement('div'); pipeline.className = 'wp-script-pipeline'; pipeline.setAttribute('aria-label', 'Các bước trong kịch bản'); workspace.appendChild(pipeline);
      shared.append(recognition);
      const steps = document.createElement('aside'); steps.className = 'wp-step-inspector'; steps.innerHTML = '<div class="wp-inspector-heading"><strong>Cấu hình node đang chọn</strong><p>Chỉ áp dụng cho bước được chọn trên sơ đồ.</p></div>'; fields.appendChild(steps); const stepEditors = [], stepPanels = [], stepButtons = [];
      for (const [index, step] of template.workflow.steps.entries()) {
        const wrapper = document.createElement('fieldset'); wrapper.hidden = index !== 0; stepPanels.push(wrapper); const legend = document.createElement('legend'); legend.textContent = `Bước ${index + 1}`; wrapper.appendChild(legend);
        const stepButton = button(`${index + 1}. ${step.name || step.id}`, () => { stepPanels.forEach((panel, selected) => { panel.hidden = selected !== index; }); stepButtons.forEach((item, selected) => { item.classList.toggle('selected', selected === index); item.setAttribute('aria-pressed', String(selected === index)); }); });
        const shell = document.createElement('div'); shell.className = 'wp-node-shell'; pipeline.appendChild(shell);
        stepButton.className = 'wp-phase-card wp-node-select' + (index === 0 ? ' selected' : ''); stepButton.setAttribute('aria-pressed', String(index === 0)); shell.appendChild(stepButton); stepButtons.push(stepButton);
        const title = document.createElement('span'); title.className = 'wp-node-title'; title.textContent = stepButton.textContent; stepButton.replaceChildren(icon(nodeIcons[step.type]), title);
        const remove = button('', async () => { if (!await confirmDelete(`Xóa bước “${stepName.value || step.id}” khỏi kịch bản?`)) return; saveCurrent(); template.workflow.steps.splice(index, 1); renderTemplate(); });
        remove.className = 'wp-node-remove'; remove.title = 'Xóa bước'; remove.setAttribute('aria-label', `Xóa bước ${step.name || step.id}`); remove.appendChild(icon('fa-xmark')); shell.appendChild(remove);
        const badge = document.createElement('small'); badge.textContent = step.type; stepButton.appendChild(badge);
        const stepName = field(wrapper, 'Tên bước', step.name || step.id), stepId = field(wrapper, 'ID bước', step.id);
        const typeLabel = document.createElement('label'); typeLabel.textContent = 'Thao tác của bước';
        const type = document.createElement('select'); type.setAttribute('aria-label', 'Thao tác của bước'); Object.entries({ transform: 'Chuẩn hóa dữ liệu', condition: 'Kiểm tra điều kiện', assert: 'Xác thực dữ liệu', collect: 'Thu thập thông tin', delay: 'Chờ', sql: 'Truy vấn SQL', source: 'Đọc nguồn SQL / API / file / bước trước', export: 'Xuất file' }).forEach(([value, text]) => type.appendChild(new Option(text, value))); type.value = step.type; typeLabel.appendChild(type); wrapper.appendChild(typeLabel);
        const configHost = document.createElement('div'); wrapper.appendChild(configHost);
        const savedConfigs = { [step.type]: structuredClone(step.config || {}) }; let activeType = step.type;
        const sourceSelected = (bindingRef, sourceType) => {
          if(activeType !== 'sql' || sourceType === 'sql') return;
          savedConfigs.source = { ...(savedConfigs.source || {}), bindingRef };
          type.value = 'source'; type.onchange();
        };
        const addSource = () => chooseFieldType(kind => {
          try {
            saveCurrent();
            const sources=[...new Set(Object.values(template.bindings || {}).map(binding=>binding.dbSourceId).filter(Boolean))];
            const defaults={sql:{sql:'',dbSourceId:sources.length===1?sources[0]:'',tables:[],parameters:{},resultMapping:[]},api:{type:'api',url:'',method:'GET',query:{},dataPath:''},file:{type:'file',documentId:'',format:'auto',sheet:''},previous:{type:'previous',reference:''}};
            template.bindings ||= {}; let number=1; while(Object.hasOwn(template.bindings,`query_${number}`)) number++;
            const key=`query_${number}`; template.bindings[key]=defaults[kind];
            const selected=template.workflow.steps[index]; selected.type=kind==='sql'?'sql':'source'; selected.config={bindingRef:key};
            activeConfigTab=1; renderTemplate();
            fields.querySelectorAll('.wp-node-select')[index]?.click();
            fields.querySelector('.wp-bindings-section')?.scrollIntoView({block:'nearest'});
          } catch(failure) { notify(failure.message,true); }
        },true);
        let config = nodeForm(configHost, activeType, savedConfigs[activeType], template, sourceSelected, addSource);
        type.onchange = () => { try { savedConfigs[activeType] = config(); activeType = type.value; configHost.replaceChildren(); config = nodeForm(configHost, activeType, savedConfigs[activeType] || {}, template, sourceSelected, addSource); badge.textContent = activeType; } catch (failure) { type.value = activeType; notify(failure.message, true); } };
        stepName.oninput = () => { title.textContent = `${index + 1}. ${stepName.value}`; remove.setAttribute('aria-label', `Xóa bước ${stepName.value || step.id}`); };
        const conditionEnabled = field(wrapper, 'Chỉ chạy khi thỏa điều kiện', '', { type: 'checkbox' }); conditionEnabled.checked = Boolean(step.when);
        const when = structuredField(wrapper, 'Điều kiện chạy', step.when || { left: '', operator: 'equals', right: '' });
        steps.appendChild(wrapper); stepEditors.push(() => ({ ...step, id: stepId.value.trim(), name: stepName.value, type: type.value, config: config(), when: conditionEnabled.checked ? when() : undefined }));
      }
      if (!template.workflow.steps.length) { const empty = document.createElement('p'); empty.className = 'wp-empty-script'; empty.textContent = 'Chưa có bước. Thêm ít nhất một bước để lưu kịch bản.'; pipeline.appendChild(empty); }
      const addStep = button('Thêm bước', () => { saveCurrent(); let number = template.workflow.steps.length + 1; while (template.workflow.steps.some(step => step.id === `step_${number}`)) number++; template.workflow.steps.push({ id: `step_${number}`, name: 'Bước mới', type: 'transform', config: { mapping: {} } }); renderTemplate(); [...fields.querySelectorAll('.wp-node-select')].at(-1).click(); }); addStep.prepend(icon('fa-plus')); scriptHeader.appendChild(addStep);
      fields.appendChild(shared);
      const bindings = structuredField(shared, 'Nguồn dữ liệu và truy vấn', template.bindings || {}, '', 'bindings',{template});
      const script = document.createElement('details'); script.className='wp-editor-section wp-script-section';
      const scriptSummary=document.createElement('summary'); scriptSummary.textContent='Kịch bản các bước'; script.append(scriptSummary,main,steps); shared.appendChild(script);
      const output = outputForm(shared, template.output);
      const fixtures = fixturesForm(shared, template.fixtures, slots, output);
      const sectionDesign = [
        ['fa-folder-open', 'Thông tin lưu trữ và phân loại mẫu', 'Tên gói, lĩnh vực và từ khóa giúp quản lý, tìm kiếm mẫu.'],
        ['fa-bullseye', 'Nhận diện nghiệp vụ và thông tin cần hỏi', 'Định nghĩa khi nào chạy mẫu và thông tin cần người dùng cung cấp.'],
        ['fa-database', 'Nguồn dữ liệu và truy vấn', 'Thiết lập nguồn kết nối, bảng được phép và tham số truy vấn.'],
        ['fa-diagram-project', 'Kịch bản các bước', 'Sắp xếp thứ tự thực hiện và cấu hình từng bước sử dụng nguồn dữ liệu.'],
        ['fa-table-list', 'Kết quả trả về trong chat', 'Chọn dữ liệu trả về, kiểu dữ liệu và nhãn hiển thị.'],
        ['fa-flask', 'Các trường hợp chạy thử', 'Kiểm tra kịch bản bằng dữ liệu đầu vào và kết quả mong đợi.']
      ];
      [packageSection, ...[...shared.children].filter(child => child.tagName === 'DETAILS')].forEach((section, index) => {
        const [symbol, title, hint] = sectionDesign[index]; section.classList.add('wp-config-section');
        const summary = section.querySelector(':scope > summary'); summary.replaceChildren();
        const visual = document.createElement('span'); visual.className = 'wp-config-icon'; visual.appendChild(icon(symbol));
        const copy = document.createElement('span'); copy.className = 'wp-config-copy'; const heading = document.createElement('strong'); heading.textContent = title; const description = document.createElement('small'); description.textContent = hint; copy.append(heading, description);
        summary.append(visual, copy, icon('fa-chevron-down'));
        if (index === 2) section.classList.add('wp-bindings-section');
      });
      configTabs(shared, activeConfigTab, index => { activeConfigTab = index; });
      saveCurrent = () => { Object.assign(template, { id: templateId.value.trim(), name: name.value, description: description.value, enabled: enabled.checked, examples: examples.value.split('\n').map(value => value.trim()).filter(Boolean), instructions: instructions.value, inputs: slots(), bindings: bindings(), output: output(), fixtures: fixtures(), workflow: { steps: stepEditors.map(read => read()) } }); template.allowedCapabilities = [...new Set(template.workflow.steps.map(step => ({ transform: 'data.transform', condition: 'data.condition', assert: 'data.validate', collect: 'input.collect', delay: 'runtime.delay', sql: 'sql.read', source: 'data.read', export: 'artifact.export' }[step.type])))]; };
    }
    let previous = String(initialIndex); select.onchange = () => { const next = select.value; select.value = previous; try { saveCurrent(); previous = next; updateOptions(next); renderTemplate(); } catch (failure) { notify(failure.message, true); } }; renderTemplate();
    const errors = document.createElement('p'); errors.setAttribute('role', 'alert'); dialog.body.appendChild(errors);
    dialog.footer.appendChild(button('Lưu draft mới', async () => { try { saveCurrent(); bundle.manifest.id = packageId.value.trim(); bundle.manifest.name = packageName.value; bundle.manifest.domain = domain.value; bundle.manifest.tags = tags.value.split(',').map(value => value.trim()).filter(Boolean); if (record.published) bundle.manifest.version = Math.max(bundle.manifest.version, ...(record.versions || []).map(version => version.manifest.version + 1)); await api('/api/workflow-plugins', 'POST', { bundle, revision: record.revision }); dialog.backdrop.remove(); await refresh(); } catch (failure) { errors.textContent = failure.message; } }));
  }
  function overlayDialog(record) {
    const dialog = modal('Tùy chỉnh theo scope'); dialog.backdrop.classList.add('wp-scope-editor'); const scope = field(dialog.body, 'Scope tài khoản (account:<ID>) hoặc tenant đã xác thực', '');
    const definition = structuredField(dialog.body, 'Nội dung tùy chỉnh', record.published);
    dialog.footer.appendChild(button('Kiểm thử và publish tùy chỉnh', async () => { await api(`/api/workflow-plugins/${encodeURIComponent(record.id)}/overlay`, 'POST', { scopeId: scope.value, bundle: definition(), revision: record.revision }); dialog.backdrop.remove(); await refresh(); }));
  }
  function rollbackDialog(record) {
    const dialog = modal('Khôi phục version published'); const select = document.createElement('select');
    (record.versions || []).forEach(bundle => { const option = document.createElement('option'); option.value = bundle.manifest.version; option.textContent = `Version ${bundle.manifest.version}`; select.appendChild(option); }); dialog.body.appendChild(select);
    dialog.footer.appendChild(button('Khôi phục', async () => { await api(`/api/workflow-plugins/${encodeURIComponent(record.id)}/rollback`, 'POST', { version: Number(select.value), revision: record.revision }); dialog.backdrop.remove(); await refresh(); }));
  }
  function showRun(execution) { const dialog = modal(execution.name); const node = document.createElement('div'); dialog.body.appendChild(node); mount(node, execution); }
  function schemaInput(container, schema, label, required = true) {
    if (schema.enum || schema.type === 'boolean') {
      const wrapper = document.createElement('label'); wrapper.textContent = label;
      const input = document.createElement('select'), values = schema.enum || [true, false];
      input.appendChild(new Option('Chọn…', ''));
      values.forEach((value, index) => input.appendChild(new Option(typeof value === 'boolean' ? (value ? 'Có' : 'Không') : typeof value === 'object' ? `Lựa chọn ${index + 1}` : String(value), String(index))));
      input.required = required; wrapper.appendChild(input); container.appendChild(wrapper);
      return () => input.value === '' ? undefined : values[Number(input.value)];
    }
    if (schema.type === 'object') {
      const group = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = label; group.appendChild(legend); container.appendChild(group);
      if (!Object.keys(schema.properties || {}).length) return valueEditor(group, {}, 'Thông tin');
      const readers = Object.entries(schema.properties).map(([key, child]) => [key, schemaInput(group, child, child.title || key, (schema.required || []).includes(key))]);
      return () => Object.fromEntries(readers.map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined));
    }
    if (schema.type === 'array') {
      const group = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = label; group.appendChild(legend); container.appendChild(group);
      const rows = [], list = document.createElement('div'); group.appendChild(list);
      function add() {
        const row = document.createElement('div'); row.className = 'wp-array-item'; list.appendChild(row);
        const item = { read: schemaInput(row, schema.items || { type: 'string' }, `Mục ${rows.length + 1}`) }; rows.push(item);
        row.appendChild(button('Xóa mục', () => { rows.splice(rows.indexOf(item), 1); row.remove(); }));
      }
      for (let index = 0; index < (schema.minItems || (required ? 1 : 0)); index++) add();
      group.appendChild(button('Thêm mục', () => { if (schema.maxItems === undefined || rows.length < schema.maxItems) add(); }));
      return () => { if (rows.length < (schema.minItems || 0)) throw new Error(`${label}: chưa đủ số mục.`); return rows.map(item => item.read()); };
    }
    const input = field(container, label, '', { type: schema.format === 'date' ? 'date' : schema.format === 'date-time' ? 'datetime-local' : ['number', 'integer'].includes(schema.type) ? 'number' : 'text' });
    input.required = required;
    for (const [key, attr] of [['minimum', 'min'], ['maximum', 'max'], ['minLength', 'minLength'], ['maxLength', 'maxLength']]) if (schema[key] !== undefined) input[attr] = schema[key];
    if (schema.type === 'number') input.step = 'any';
    return () => input.value === '' ? undefined : ['number', 'integer'].includes(schema.type) ? Number(input.value) : schema.format === 'date-time' ? new Date(input.value).toISOString() : input.value;
  }
  function resultText(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Có' : 'Không';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
      return new Intl.DateTimeFormat('vi-VN', { timeZone: 'UTC' }).format(new Date(value));
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  function renderResult(value, presentation = {}, prefix = '') {
    const label = key => presentation.labels?.[prefix ? `${prefix}.${key}` : key] || key;
    if (Array.isArray(value) && value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
      const wrapper = document.createElement('div'); wrapper.className = 'workflow-result-table';
      if (!value.length) { wrapper.textContent = presentation.emptyText || 'Không có dữ liệu.'; return wrapper; }
      const keys = presentation.columns?.[prefix] ?? [...new Set(value.flatMap(row => Object.keys(row)))];
      if (!keys.length) { wrapper.textContent = 'Không có cột được bật hiển thị trong cấu trúc bảng.'; return wrapper; }
      const table = document.createElement('table'), header = document.createElement('tr');
      keys.forEach(key => { const cell = document.createElement('th'); cell.textContent = label(key); header.appendChild(cell); });
      const head = document.createElement('thead'); head.appendChild(header); table.appendChild(head);
      const body = document.createElement('tbody');
      value.forEach(row => { const line = document.createElement('tr'); keys.forEach(key => { const cell = document.createElement('td'); cell.textContent = resultText(row[key]); line.appendChild(cell); }); body.appendChild(line); });
      table.appendChild(body); wrapper.appendChild(table); return wrapper;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const tables = Object.entries(value).filter(([, child]) => Array.isArray(child) && child.every(row => row && typeof row === 'object' && !Array.isArray(row)));
      if (tables.length) {
        const section = document.createElement('div'); section.className = 'wp-result-content';
        const summary = document.createElement('div'); summary.className = 'wp-result-summary';
        for (const [key, child] of Object.entries(value)) {
          if (tables.some(([tableKey]) => tableKey === key) || (key === 'empty' && typeof child === 'boolean')) continue;
          const badge = document.createElement('span'); badge.textContent = `${label(key)}: ${resultText(child)}`; summary.appendChild(badge);
        }
        if (summary.childElementCount) section.appendChild(summary);
        for (const [key, child] of tables) {
          const heading = document.createElement('h4'); heading.textContent = label(key); section.append(heading, renderResult(child, presentation, prefix ? `${prefix}.${key}` : key));
        }
        return section;
      }
      const list = document.createElement('dl');
      for (const [key, child] of Object.entries(value)) { const term = document.createElement('dt'); term.textContent = label(key); const detail = document.createElement('dd'); detail.appendChild(renderResult(child, presentation, prefix ? `${prefix}.${key}` : key)); list.append(term, detail); }
      return list;
    }
    const text = document.createElement('span'); text.textContent = Array.isArray(value) ? value.map(resultText).join(', ') : resultText(value); return text;
  }
  function mount(node, execution) { node.dataset.automationRun = execution.id || ''; views.set(node, execution); renderExecution(node, execution); node.dispatchEvent(new CustomEvent('workflow-execution-updated', { bubbles: true, detail: { execution } })); }
  function renderExecution(node, execution) {
    node.replaceChildren(); node.classList.add('workflow-execution-panel');
    const processing = ['READY', 'RUNNING', 'QUEUED'].includes(execution.status);
    node.setAttribute('aria-busy', String(processing));
    if (execution.status === 'SELECT_TEMPLATE') {
      for (const candidate of execution.candidates || []) node.appendChild(button(candidate.name, async () => { const data = await api('/api/automation-runs', 'POST', { templateId: candidate.id, conversationId: execution.conversationId, inputs: {}, requestId: crypto.randomUUID() }); mount(node, data.execution); })); return;
    }
    const title = document.createElement('strong'); title.textContent = `${execution.name} · ${statuses[execution.status] || execution.status}`; node.appendChild(title);
    const actions = document.createElement('div'); actions.className = 'wp-execution-actions';
    if (processing) { const loading = document.createElement('div'); loading.className = 'wp-execution-loading'; loading.setAttribute('role', 'status'); loading.innerHTML = '<span class="wp-loading-spinner" aria-hidden="true"></span><span>Đang xử lý yêu cầu…</span>'; node.appendChild(loading); }
    if (execution.steps?.length) { const list = document.createElement('ol'); for (const step of execution.steps) { const item = document.createElement('li'); item.textContent = `${step.name}: ${statuses[step.status] || ({ PENDING: 'Chưa chạy', SKIPPED: 'Bỏ qua' }[step.status]) || step.status}`; list.appendChild(item); } if (done(execution.status)) { const details = document.createElement('details'); details.className = 'wp-execution-details'; const summary = document.createElement('summary'); summary.textContent = 'Chi tiết thực hiện'; details.append(summary, list); node.appendChild(details); } else node.appendChild(list); }
    if (execution.error) { const message = document.createElement('p'); message.textContent = execution.error; node.appendChild(message); }
    if (execution.status === 'WAITING_INPUT') {
      const form = document.createElement('form'); const inputs = [];
      for (const slot of execution.missingInputs || []) {
        inputs.push({ slot, read: schemaInput(form, slot.schema, slot.ask || slot.label) });
      }
      const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn-primary'; submit.textContent = 'Bổ sung và tiếp tục'; actions.appendChild(submit); form.appendChild(actions);
      const message = document.createElement('p'); message.setAttribute('role', 'alert'); form.appendChild(message);
      form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; submit.textContent = 'Đang xử lý…'; node.setAttribute('aria-busy', 'true'); try { const values = Object.fromEntries(inputs.map(({ slot, read }) => [slot.key, read()])); const data = await api(`/api/automation-runs/${encodeURIComponent(execution.id)}/inputs`, 'POST', { inputs: values, revision: execution.revision }); mount(node, data.execution); } catch (failure) { message.textContent = failure.message; } finally { submit.disabled = false; submit.textContent = 'Bổ sung và tiếp tục'; if (node.contains(form)) node.setAttribute('aria-busy', 'false'); } }; node.appendChild(form);
    }
    const defaults = Object.entries(execution.provenance || {}).filter(([, source]) => source.source === 'default');
    if (defaults.length) { const info = document.createElement('p'); info.textContent = 'Giá trị mặc định: ' + defaults.map(([key]) => `${execution.inputLabels?.[key] || key} = ${JSON.stringify(execution.inputs[key])}`).join(', '); node.appendChild(info); }
    if (execution.result !== null && execution.result !== undefined) node.appendChild(renderResult(execution.result, execution.presentation));
    for (const artifact of execution.artifacts || []) { const link = document.createElement('a'); link.href = artifact.downloadUrl; link.textContent = `Tải ${artifact.filename}`; link.className = 'btn-secondary-sm'; node.appendChild(link); }
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(execution.status)) actions.appendChild(button('Hủy tác vụ', async () => { const data = await api(`/api/automation-runs/${encodeURIComponent(execution.id)}/cancel`, 'POST', { revision: execution.revision }); mount(node, data.execution); }));
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(execution.status) && execution.templateId && execution.conversationId) actions.appendChild(button('Làm lại', async () => {
      const data = await api('/api/automation-runs', 'POST', { templateId: execution.templateId, conversationId: execution.conversationId, inputs: {}, requestId: crypto.randomUUID() });
      const next = document.createElement('div'); node.after(next); mount(next, data.execution); next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      next.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    }));
    if (!actions.parentNode && actions.childElementCount) node.appendChild(actions);
  }
  window.renderWorkflowExecution = execution => {
    if (!execution) return ''; const key = crypto.randomUUID();
    setTimeout(() => { document.querySelectorAll(`[data-execution-key="${key}"]`).forEach(node => mount(node, execution)); }, 0);
    return `<div class="workflow-execution-panel" data-execution-key="${key}" data-automation-run="${h(execution.id || '')}">${h(statuses[execution.status])}</div>`;
  };
  window.initWorkflowsView = async () => { try { await refresh(); } catch (failure) { notify(failure.message, true); } };
  window.restoreWorkflowExecutions = async root => {
    for (const node of root.querySelectorAll('[data-automation-run]')) {
      if (!node.dataset.automationRun || views.has(node) || node.dataset.restoring) continue;
      node.dataset.restoring = 'true';
      if (!node.querySelector('strong')) node.textContent = 'Đang tải tác vụ đã lưu…';
      try { const { execution } = await api(`/api/automation-runs/${encodeURIComponent(node.dataset.automationRun)}`); delete node.dataset.restoring; if (node.isConnected) mount(node, execution); }
      catch (_) { delete node.dataset.restoring; if (!node.querySelector('strong')) node.textContent = 'Không thể tải tác vụ đã lưu. Đang thử lại…'; }
    }
  };
  // Rehydrate saved chat HTML and poll only mounted panels. Owner checks are server-side.
  let pollInFlight = false;
  setInterval(async () => {
    if (pollInFlight || document.hidden) return;
    pollInFlight = true;
    try {
    await window.restoreWorkflowExecutions(document);
    const cached = new Map();
    for (const [node, execution] of views) {
      if (!node.isConnected) { views.delete(node); continue; }
      if (!execution.id || done(execution.status)) continue;
      try { let data = cached.get(execution.id); if (!data) { data = await api(`/api/automation-runs/${encodeURIComponent(execution.id)}`); cached.set(execution.id, data); } if (data.execution.revision !== execution.revision) mount(node, data.execution); } catch (_) { /* Retry while mounted. */ }
    }
    } finally { pollInFlight = false; }
  }, 1500);
})();
