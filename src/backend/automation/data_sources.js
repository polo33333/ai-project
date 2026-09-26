'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ensure, error, resolve, get, safeObject } = require('./contract');
const MAX_BYTES = 2 * 1024 * 1024;
const privateNetworks = { ipv4:new net.BlockList(),ipv6:new net.BlockList() };
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['224.0.0.0',4],['240.0.0.0',4]]) privateNetworks.ipv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8]]) privateNetworks.ipv6.addSubnet(address, prefix, 'ipv6');
function publicAddress(address) { const version = net.isIP(address),family=version===4?'ipv4':'ipv6'; return Boolean(version && !privateNetworks[family].check(address,family)); }
function apiUrl(value, state) { return require('./api_http').apiUrl(value, state); }
function kind(binding) { return binding.type || 'sql'; }
function validateSource(binding) {
  ensure(['sql','api','file','previous'].includes(kind(binding)), 'Loại nguồn dữ liệu chưa được hỗ trợ.');
  if (kind(binding) === 'api') {
    require('./api_http').validateApi(binding);
  }
  if (kind(binding) === 'file') { ensure(typeof binding.documentId === 'string' && binding.documentId, 'Nguồn file cần chọn tài liệu trong Thư viện.'); ensure(['auto','text','json','csv','xlsx'].includes(binding.format || 'auto'), 'Định dạng file chưa hỗ trợ.'); }
  if (kind(binding) === 'previous') ensure(typeof binding.reference === 'string' && /^\{\{\s*steps\.[\w.-]+\s*\}\}$/.test(binding.reference), 'Nguồn bước trước cần một tham chiếu đầu ra.');
}
function normalizeData(data, source) {
  ensure(data !== undefined, 'Không tìm thấy dữ liệu ở đường dẫn đã chọn.'); safeObject(data);
  ensure(Buffer.byteLength(JSON.stringify(data)) <= MAX_BYTES, 'Dữ liệu nguồn vượt quá 2 MB.');
  const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : data && typeof data === 'object' ? [data] : [];
  ensure(rows.length <= 1000, 'Nguồn dữ liệu vượt quá 1.000 dòng.');
  return { data, rows, rowCount: rows.length, empty: rows.length === 0, source, retrievedAt: new Date().toISOString() };
}
async function readFile(binding, state) {
  const library = require('../services/library_service');
  const document = library.findDocument(resolve(binding.documentId, state)); ensure(document && document.isActive !== false, 'File không còn trong Thư viện.');
  const format = binding.format && binding.format !== 'auto' ? binding.format : ['CSV','XLSX','XLS'].includes(document.type) ? document.type === 'CSV' ? 'csv' : 'xlsx' : document.type === 'JSON' ? 'json' : 'text';
  if (format === 'text') { const content = library.getContent(document.id).content; ensure(content, 'File chưa có nội dung đã xử lý.'); return content; }
  const {buffer} = await readLibraryBuffer(document.id);
  if (format === 'json') return JSON.parse(buffer.toString('utf8'));
  if (format === 'csv') return require('csv-parse/sync').parse(buffer, { columns: true, bom: true, skip_empty_lines: true });
  const XLSX = require('xlsx'), workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: 1002 });
  const sheet = binding.sheet || workbook.SheetNames[0]; ensure(workbook.Sheets[sheet], 'Không tìm thấy sheet trong file.');
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { defval: null });
}
async function readLibraryBuffer(id) {
  const document=require('../services/library_service').findDocument(id);ensure(document && document.isActive!==false,'File không còn trong Thư viện.');
  const root = path.join(require('../utils/storage_helper').getDataDirectory(), 'library_files');
  const [filePath, rootPath] = await Promise.all([fs.realpath(document.storagePath), fs.realpath(root)]);
  ensure(filePath.startsWith(rootPath + path.sep), 'File nằm ngoài vùng lưu trữ Thư viện.');
  ensure((await fs.stat(filePath)).size <= MAX_BYTES, 'File vượt quá 2 MB.'); const buffer = await fs.readFile(filePath);
  return {buffer,document};
}
async function executeSource(binding, state, context = {}) {
  validateSource(binding);
  if (kind(binding) === 'sql') return require('./sql').executeBinding(binding, state.input, { ...context, state });
  if (kind(binding) !== 'previous' && !context.permissions?.some(permission => ['admin','knowledge:read'].includes(permission))) throw error('Không có quyền đọc nguồn dữ liệu.',403);
  if(kind(binding)==='api') {
    const response=await require('./api_http').readApi(binding,state,context.signal);
    if(response.binary) {
      const id=require('node:crypto').randomUUID();
      const filename=path.basename(response.binary.filename).replace(/[\x00-\x1f"\\/]/g,'_').slice(0,150) || 'api-response.bin';
      const directory=path.join(require('../utils/export_paths').getExportsDirectory(),'automation');await fs.mkdir(directory,{recursive:true});
      const storageName=`${id}.bin`;await fs.writeFile(path.join(directory,storageName),response.binary.buffer);
      const contentType=/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/.test(response.binary.contentType)?response.binary.contentType:'application/octet-stream';
      const artifact={id,filename,storageName,contentType,expiresAt:new Date(Date.now()+7*86400000).toISOString()};
      return {...normalizeData({artifactId:id,filename},'api'),response:response.response,artifactId:id,filename,artifact};
    }
    return {...normalizeData(response.data,'api'),response:response.response};
  }
  const data = kind(binding) === 'previous' ? resolve(binding.reference, state) : await readFile(binding,state);
  return normalizeData(data, kind(binding));
}
module.exports = { kind, validateSource, executeSource, normalizeData, apiUrl, publicAddress,readLibraryBuffer };
