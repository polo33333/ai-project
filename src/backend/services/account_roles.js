'use strict';
const StorageHelper = require('../utils/storage_helper');
const capabilities = [
  ['dashboard.read','Tổng quan'], ['chat.use','Trò chuyện'], ['schema.read','Lược đồ CSDL'], ['sources.read','Danh sách nguồn CSDL'],
  ['library.read','Thư viện tài liệu'], ['glossary.read','Thuật ngữ'], ['workflows.use','Sử dụng mẫu nghiệp vụ'],
  ['history.read','Lịch sử trò chuyện'], ['feedback.read','Đánh giá AI'], ['analytics.read','Báo cáo'], ['memory.use','Bộ nhớ cá nhân'],
  ['sql:read','Tra cứu dữ liệu SQL qua AI'], ['knowledge:read','Tra cứu tài liệu qua AI']
].map(([id,label])=>({id,label}));
const fail = (message,statusCode=400) => { throw Object.assign(new Error(message),{statusCode}); };
function permissions(value) {
  if (!Array.isArray(value) || value.some(key=>!capabilities.some(c=>c.id===key))) fail('Danh sách quyền không hợp lệ.');
  return [...new Set(value)];
}
function dataAccess(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['sql','documents'].includes(k))) fail('Phạm vi dữ liệu không hợp lệ.');
  return Object.fromEntries(['sql','documents'].map(key=> {
    const list=value[key];
    if (list != null && (!Array.isArray(list) || list.length>500 || list.some(id=>typeof id!=='string'||!id||id.length>200))) fail('Danh sách nguồn dữ liệu không hợp lệ.');
    return [key,list==null?null:[...new Set(list)]];
  }));
}
class AccountRoles {
  constructor() { StorageHelper.bind(this,'roles','account_roles.json',[]); }
  list() { return [
    {id:'admin',name:'Admin — Quản trị viên',builtin:true,permissions:capabilities.map(c=>c.id),dataAccess:null,revision:0},
    {id:'user',name:'User — Người dùng',builtin:true,permissions:capabilities.map(c=>c.id),dataAccess:null,revision:0},
    ...this.roles.map(role=>({...role,builtin:false})) ]; }
  get(id) { return this.list().find(role=>role.id===id); }
  save(input,id) {
    const existing = id && this.get(id);
    if (id && (!existing || existing.builtin)) fail('Không thể chỉnh sửa vai trò hệ thống.',409);
    const key = id || input.id;
    if (typeof key!=='string'||!/^[a-z][a-z0-9_-]{1,39}$/.test(key)||['admin','user'].includes(key)) fail('Mã vai trò gồm 2–40 ký tự chữ thường, số, gạch ngang hoặc gạch dưới.');
    if (!id && this.get(key)) fail('Mã vai trò đã tồn tại.',409);
    if (existing && input.revision!==existing.revision) fail('Vai trò đã thay đổi. Hãy tải lại.',409);
    if (typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100) fail('Tên vai trò phải có từ 1 đến 100 ký tự.');
    const role={id:key,name:input.name.trim(),description:String(input.description||'').slice(0,400),permissions:permissions(input.permissions),dataAccess:dataAccess(input.dataAccess),revision:(existing?.revision||0)+1};
    this.roles = existing ? this.roles.map(item=>item.id===id?role:item) : [...this.roles,role];
    StorageHelper.saveJson('account_roles.json',this.roles); return role;
  }
  effective(account) {
    const role=this.get(account.role||'user');
    if(account.role==='admin') return {permissions:capabilities.map(c=>c.id),dataAccess:{sql:null,documents:null},roleLabel:role.name};
    const grants=account.permissions==null?(role?.permissions||[]):account.permissions;
    const base=role?.dataAccess||{}, override=account.dataAccess||{};
    const scope=Object.fromEntries(['sql','documents'].map(key=>[key,base[key]==null?(override[key]??null):override[key]==null?base[key]:override[key].filter(id=>base[key].includes(id))]));
    return {permissions:[...grants],dataAccess:scope,roleLabel:role?.name||account.role};
  }
}
module.exports = new AccountRoles();
module.exports.capabilities=capabilities;
module.exports.validatePermissions=permissions;
module.exports.validateDataAccess=dataAccess;
