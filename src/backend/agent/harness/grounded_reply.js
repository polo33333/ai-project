'use strict';

function ensureDownloadLink(text, downloadUrl) {
  let reply = String(text || '').trim();
  const url = String(downloadUrl || '').trim();
  if (!url) return reply;
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Collapse a malformed outer Markdown link around an already valid export link.
  const nestedLinkPattern = new RegExp(`\\[(\\[[^\\]]+\\]\\(\\s*${escapedUrl}\\s*\\))\\]\\([^\\n)]*\\)`, 'i');
  reply = reply.replace(nestedLinkPattern, '$1');
  if (new RegExp(`\\[[^\\]]+\\]\\(\\s*${escapedUrl}\\s*\\)`, 'i').test(reply)) return reply;
  const link = `[Tải file tại đây](${url})`;
  const codeUrlPattern = new RegExp('`' + escapedUrl + '`', 'i');
  if (codeUrlPattern.test(reply)) return reply.replace(codeUrlPattern, link);
  const plainUrlPattern = new RegExp(escapedUrl, 'i');
  if (plainUrlPattern.test(reply)) return reply.replace(plainUrlPattern, link);
  return `${reply}\n\n${link}.`.trim();
}

function formatDisplayDate(value) {
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match) return text;
  const [, year, month, day, hour, minute, second] = match;
  const date = `${day}/${month}/${year}`;
  if (hour === undefined || (hour === '00' && minute === '00' && second === '00')) return date;
  return `${date} ${hour}:${minute}:${second}`;
}

function markdownCell(value, unit) {
  if (value === undefined) return 'Chưa truy vấn';
  if (value === null || value === '') return '—';
  const normalized = unit && typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 20 }).format(value) : formatDisplayDate(value);
  return normalized.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function ageRankingConclusion(sqlCall, rows) {
  const ranking=sqlCall.result?.ranking;
  // Only the validated semantic compiler can bind a conclusion to this execution.
  if(!ranking || ranking.sql!==(sqlCall.result.sql || sqlCall.args?.sql)
    || !['youngest','oldest'].includes(ranking.kind) || !ranking.identityColumns?.length) return '';
  const dates=rows.map(row=>row[ranking.column]);
  if(dates.some(value=>value===null||value===undefined||value==='')
    || new Set(dates.map(value=>new Date(value).getTime())).size!==1
    || !Number.isFinite(new Date(dates[0]).getTime())) return '';
  if(rows.some(row=>ranking.identityColumns.some(column=>row[column]===undefined)))return '';
  const identities=rows.slice(0,10).map(row=>ranking.identityColumns.map(column=>row[column])
    .filter(value=>value!==null&&value!=='').map(value=>markdownCell(value)).join(' · '));
  if(identities.some(value=>!value))return '';
  const date=markdownCell(dates[0]), adjective=ranking.kind==='youngest'?'trẻ nhất':'lớn tuổi nhất';
  let text=`**${identities.join('**, **')}** ${rows.length>1?'đồng hạng ':''}${adjective} trong các hồ sơ có ngày sinh được ghi nhận, cùng phạm vi tra cứu. ${rows.length>1?'Ngày sinh chung':'Ngày sinh'}: **${date}**.`;
  text+='\n\nHồ sơ thiếu ngày sinh không được xét; chưa thể kết luận cho toàn bộ danh sách nếu còn thiếu dữ liệu này.';
  const birth=new Date(dates[0]), now=new Date();
  let age=now.getUTCFullYear()-birth.getUTCFullYear();
  if(now.getUTCMonth()<birth.getUTCMonth() || (now.getUTCMonth()===birth.getUTCMonth()&&now.getUTCDate()<birth.getUTCDate()))age--;
  if(birth>now || (ranking.subject==='employee'&&age<16))text+='\n\n**Cần kiểm tra dữ liệu:** ngày sinh này có dấu hiệu bất thường'+(ranking.subject==='employee'?' đối với hồ sơ nhân viên':'')+'. Kết quả trên phản ánh dữ liệu hiện có, cần xác minh trước khi kết luận chính thức.';
  if(rows.length>=100)text+='\n\nKết quả đạt giới hạn 100 hồ sơ; có thể còn người đồng hạng chưa được trả về.';
  return text;
}

function buildSqlRowsFallbackReply(sqlCall, displayNames = {}, options = {}) {
  displayNames = { ...displayNames, ...sqlCall?.result?.displayNames };
  const rows = Array.isArray(sqlCall?.result?.rows) ? sqlCall.result.rows : [];
  if (!rows.length) return 'Không tìm thấy dữ liệu phù hợp.';

  if (options.resultGroupBy?.length) {
    const groups = require('./result_grouping').partition(sqlCall, options.resultGroupBy, displayNames);
    if (!groups) return 'Đã lấy được dữ liệu nhưng chưa xác định được cột để tách nhóm theo yêu cầu; chưa thể trình bày các nhóm riêng biệt.';
    return groups.map(group => `**${group.values.map(value=>markdownCell(value == null || value === '' ? 'Chưa xác định' : value)).join(' · ')} (${group.rows.length})**\n\n`
      + buildSqlRowsFallbackReply({...sqlCall,result:{...sqlCall.result,rows:group.rows}},displayNames,{...options,resultGroupBy:[],forceTable:true})).join('\n\n');
  }

  const allColumns = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  const columns = allColumns.slice(0, options.forceTable ? 100 : 10);
  const columnNotice = allColumns.length > columns.length
    ? `\n\nHiển thị ${columns.length}/${allColumns.length} trường kết quả.` : '';
  const scopeNotice = sqlCall?.result?.hasMore || sqlCall?.result?.truncated
    ? '\n\nNguồn trả về một phần dữ liệu; bảng này chưa bao phủ toàn bộ phạm vi yêu cầu.' : '';
  const usableLabel = value => typeof value === 'string' && value.trim() && !/^[-—–]+$/.test(value.trim());
  const labels = columns.map((column, index) => {
    const name = usableLabel(displayNames[column]) ? displayNames[column].trim()
      : usableLabel(column) ? column : `Giá trị kết quả ${index + 1}`;
    return `${name}${sqlCall?.result?.units?.[column] ? ` (${sqlCall.result.units[column]})` : ''}`;
  });
  const uniqueLabels = labels.map((label, index) => labels.indexOf(label) === index ? label : `${label} (${columns[index]})`);
  const valueCell = (column, value) => markdownCell(require('./money_display').format(value,
    `${column} ${displayNames[column] || ''}`, sqlCall.result.units?.[column]), sqlCall.result.units?.[column]);
  const fieldLabels=uniqueLabels.filter(label=>!/(?:^id$|ID$)/.test(label)).slice(0,4);
  let introduction=`Đã tra cứu được **${rows.length}** bản ghi phù hợp với yêu cầu.`;
  if(fieldLabels.length)introduction+=' Thông tin gồm '+fieldLabels.map(label=>`**${markdownCell(label)}**`).join(', ')+'.';
  let orderingNotice='';
  try {
    const sql=sqlCall.result?.sql || sqlCall.args?.sql;
    if(sql) {
      const ast=new(require('node-sql-parser/build/transactsql').Parser)().astify(sql);
      if(!Array.isArray(ast)) {
        const ordered=(ast.orderby || []).filter(item=>item.expr?.type==='column_ref')
          .map(item=>`**${markdownCell(displayNames[item.expr.column] || item.expr.column)} ${item.type==='DESC'?'giảm dần':'tăng dần'}**`);
        if(ordered.length)orderingNotice='\n\nThứ tự truy vấn: '+ordered.join(', ')+'.';
      }
    }
  } catch { /* Never infer ordering from prose when SQL cannot be inspected. */ }
  const rankingConclusion=ageRankingConclusion(sqlCall, rows);
  if(rankingConclusion) { introduction=rankingConclusion; orderingNotice=''; }
  const missing=columns.map((column,index)=>({label:uniqueLabels[index],count:rows.filter(row=>row[column]===null || row[column]==='').length}))
    .filter(item=>item.count>0).slice(0,2);
  const missingNotice=missing.length ? '\n\nTrong các dòng trả về, dữ liệu còn thiếu ở '+missing.map(item=>`**${markdownCell(item.label)}** (${item.count}/${rows.length} dòng)`).join(', ')+'.' : '';
  if (rows.length === 1 && !options.forceTable) {
    const details = columns.map((column, index) => `- **${markdownCell(uniqueLabels[index])}:** ${valueCell(column, rows[0]?.[column])}`).join('\n');
    return `${introduction}${orderingNotice}\n\n${details}${missingNotice}${columnNotice}${scopeNotice}`;
  }

  const visibleRows = rows.slice(0, 10);
  if (options.forceTable && options.comparison) {
    // Use verified values for column identities, without business-specific field names.
    const uniqueIdentity = column => visibleRows.every(row => row[column] !== null && row[column] !== undefined && row[column] !== '')
      && new Set(visibleRows.map(row => String(row[column]))).size === visibleRows.length;
    const textualIdentity = column => uniqueIdentity(column)
      && visibleRows.every(row => typeof row[column] === 'string' && row[column].trim() && !Number.isFinite(Number(row[column])));
    const configuredColumns = (options.displayIdentityColumns || []).flatMap(column => {
      const aliases = [column, displayNames[column]].filter(Boolean).map(value => String(value).toLocaleLowerCase('vi'));
      return columns.filter(name => aliases.includes(name.toLocaleLowerCase('vi')));
    });
    const identityColumn = configuredColumns.find(textualIdentity) || columns.find(textualIdentity) || columns.find(uniqueIdentity);
    const identities = visibleRows.map((row, index) => identityColumn
      ? markdownCell(row[identityColumn]) : `Đối tượng ${index + 1}`);
    const header = `| Tiêu chí | ${identities.join(' | ')} |`;
    const separator = `| --- | ${visibleRows.map(() => '---').join(' | ')} |`;
    const body = columns.map((column, index) => `| ${markdownCell(uniqueLabels[index])} | ${visibleRows.map(row => valueCell(column, row[column])).join(' | ')} |`).join('\n');
    const remainder = rows.length > visibleRows.length ? `\n\nHiển thị ${visibleRows.length}/${rows.length} đối tượng.` : '';
    return `${header}\n${separator}\n${body}${remainder}${columnNotice}${scopeNotice}`;
  }
  const header = `| ${uniqueLabels.map(markdownCell).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = visibleRows.map(row => `| ${columns.map(column => valueCell(column, row?.[column])).join(' | ')} |`).join('\n');
  const remainder = rows.length > visibleRows.length ? `\n\nHiển thị ${visibleRows.length}/${rows.length} kết quả.` : '';
  return `${introduction}${orderingNotice}\n\n${header}\n${separator}\n${body}${remainder}${missingNotice}${columnNotice}${scopeNotice}`;
}

function isUngroundedKnowledgeAnswer(text = '') {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  return /khong co thong tin(?: cu the)?|khong phai ung dung|neu co ung dung|app nao cu the|ung dung nao cu the|hay cho (?:toi|minh) biet them/.test(normalized);
}

module.exports = { ensureDownloadLink, buildSqlRowsFallbackReply, formatDisplayDate, isUngroundedKnowledgeAnswer };
