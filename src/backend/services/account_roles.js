'use strict';
const StorageHelper = require('../utils/storage_helper');
const capabilities = [
  ['dashboard.read','Tổng quan'], ['chat.use','Trò chuyện'], ['schema.read','Lược đồ CSDL'], ['sources.read','Danh sách nguồn CSDL'],
  ['library.read','Thư viện tài liệu'], ['glossary.read','Thuật ngữ'], ['workflows.use','Sử dụng mẫu nghiệp vụ'],
  ['history.read','Lịch sử trò chuyện'], ['feedback.read','Đánh giá AI'], ['analytics.read','Báo cáo'], ['memory.use','Bộ nhớ cá nhân'],
  ['sql:read','Tra cứu dữ liệu SQL qua AI'], ['knowledge:read','Tra cứu tài liệu qua AI']
].map(([id,label])=>({id,label}));
// System roles. "user" and "khach_widget" may take function groups; "admin" is fixed.
const BUILTIN = ['admin','user','khach_widget'];
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
function functionGroupIds(value) {
  if (!Array.isArray(value) || value.length>50 || value.some(id=>typeof id!=='string')) fail('Danh sách nhóm chức năng không hợp lệ.');
  const groups=require('./account_function_groups');
  const missing=value.filter(id=>!groups.get(id));
  if (missing.length) fail(`Nhóm chức năng không tồn tại: ${missing.join(', ')}.`);
  return [...new Set(value)];
}
class AccountRoles {
  constructor() { StorageHelper.bind(this,'roles','account_roles.json',[]); }
  list() {
    const stored=id=>this.roles.find(role=>role.id===id);
    const system=(role)=>{ const saved=stored(role.id); return saved?.functionGroups ? {...role,functionGroups:saved.functionGroups,revision:saved.revision||0} : role; };
    return [
      {id:'admin',name:'Admin — Quản trị viên',builtin:true,permissions:capabilities.map(c=>c.id),dataAccess:null,revision:0},
      system({id:'user',name:'User — Người dùng',builtin:true,permissions:capabilities.map(c=>c.id),dataAccess:null,revision:0}),
      system({id:'khach_widget',name:'Khách widget',description:'Vai trò mặc định của widget nhúng.',builtin:true,permissions:['chat.use'],dataAccess:null,revision:0}),
      ...this.roles.filter(role=>!BUILTIN.includes(role.id)).map(role=>({...role,builtin:false})) ];
  }
  get(id) { return this.list().find(role=>role.id===id); }
  save(input,id) {
    const existing = id && this.get(id);
    if (id && !existing) fail('Không tìm thấy vai trò.',404);
    // System roles "user" and "khach_widget" accept function groups only.
    if (existing?.builtin) {
      if (existing.id==='admin' || !Array.isArray(input.functionGroups)) fail('Không thể chỉnh sửa vai trò hệ thống.',409);
      if (input.revision!==existing.revision) fail('Vai trò đã thay đổi. Hãy tải lại.',409);
      const role={id:existing.id,functionGroups:functionGroupIds(input.functionGroups),revision:(existing.revision||0)+1};
      this.roles=[...this.roles.filter(item=>item.id!==existing.id),role];
      StorageHelper.saveJson('account_roles.json',this.roles); return this.get(existing.id);
    }
    const key = id || input.id;
    if (typeof key!=='string'||!/^[a-z][a-z0-9_-]{1,39}$/.test(key)||BUILTIN.includes(key)) fail('Mã vai trò gồm 2–40 ký tự chữ thường, số, gạch ngang hoặc gạch dưới.');
    if (!id && this.get(key)) fail('Mã vai trò đã tồn tại.',409);
    if (existing && input.revision!==existing.revision) fail('Vai trò đã thay đổi. Hãy tải lại.',409);
    if (typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100) fail('Tên vai trò phải có từ 1 đến 100 ký tự.');
    const common={id:key,name:input.name.trim(),description:String(input.description||'').slice(0,400),revision:(existing?.revision||0)+1};
    // Function groups replace the per-role permission list and data scope.
    const role=Array.isArray(input.functionGroups) ? {...common,functionGroups:functionGroupIds(input.functionGroups)}
      : {...common,permissions:permissions(input.permissions),dataAccess:dataAccess(input.dataAccess)};
    this.roles = existing ? this.roles.map(item=>item.id===id?role:item) : [...this.roles,role];
    StorageHelper.saveJson('account_roles.json',this.roles); return role;
  }
  // Custom roles only, and only when no account or widget still uses them.
  remove(id,revision) {
    const existing=this.get(id);
    if(!existing) fail('Không tìm thấy vai trò.',404);
    if(existing.builtin) fail('Không thể xóa vai trò hệ thống.',409);
    if(revision!==existing.revision) fail('Vai trò đã thay đổi. Hãy tải lại.',409);
    let accounts=[]; try { accounts=require('./auth_service').accounts.filter(account=>(account.role||'user')===id); } catch { accounts=[]; }
    const widgets=require('./embed_chat_service').configs.filter(config=>config.role===id);
    if(accounts.length||widgets.length) fail(`Vai trò đang được dùng bởi ${accounts.length} tài khoản và ${widgets.length} widget. Hãy đổi vai trò cho họ trước.`,409);
    this.roles=this.roles.filter(role=>role.id!==id);
    StorageHelper.saveJson('account_roles.json',this.roles); return true;
  }
  effective(account) {
    const role=this.get(account.role||'user');
    if(account.role==='admin') return {permissions:capabilities.map(c=>c.id),dataAccess:{sql:null,documents:null},functionGroups:[],grants:null,roleLabel:role.name,accessRevision:'admin'};
    const roleGroups=Array.isArray(role?.functionGroups)?role.functionGroups:null, extra=Array.isArray(account.extraFunctionGroups)?account.extraFunctionGroups:[];
    const combined=require('./account_function_groups').combine([...(roleGroups||[]),...extra]);
    // Legacy roles keep their permission list until migrated; function groups only add to it.
    const grants=account.permissions!=null?account.permissions:roleGroups?[...combined.permissions]:[...new Set([...(role?.permissions||[]),...combined.permissions])];
    const base=role?.dataAccess||{}, override=account.dataAccess||{};
    const scope=Object.fromEntries(['sql','documents'].map(key=>[key,base[key]==null?(override[key]??null):override[key]==null?base[key]:override[key].filter(id=>base[key].includes(id))]));
    return {permissions:[...grants],dataAccess:scope,functionGroups:[...new Set([...(roleGroups||[]),...extra])],
      grants:{sql:[...combined.sql],documents:[...combined.documents],watchfolders:[...combined.watchfolders],workflows:[...combined.workflows],packages:combined.packages},
      roleLabel:role?.name||account.role,accessRevision:[`${role?.id||account.role}:${role?.revision||0}`,...combined.revisions].join('|')};
  }
  // Governance principal fields for a widget: the role assigned to the widget.
  forEmbed(config) {
    const roleId=config?.role && this.get(config.role) ? config.role : 'khach_widget';
    const effective=this.effective({role:roleId});
    return {role:roleId,permissions:effective.permissions,dataAccess:null,grants:effective.grants,accessRevision:effective.accessRevision};
  }
}
module.exports = new AccountRoles();
module.exports.capabilities=capabilities;
module.exports.BUILTIN=BUILTIN;
module.exports.validatePermissions=permissions;
module.exports.validateDataAccess=dataAccess;
module.exports.validateFunctionGroups=functionGroupIds;
