'use strict';

const StorageHelper = require('../utils/storage_helper');
const SKILLS_FILE = 'skills.json';
const MAX_NAME_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 6000;
const DEFAULT_SKILLS = Object.freeze([
  { id: 'record_lookup', name: 'Tra cứu bản ghi', version: 1, enabled: true, intents: ['record_lookup'], instructions: 'Truy vấn đúng bảng đã chọn. Chỉ dùng các cột có trong schema. Với tìm kiếm tên hoặc mã, dùng điều kiện chính xác khi có mã và LIKE khi là tên.', exampleIds: ['lookup_by_code'] },
  { id: 'aggregate_report', name: 'Báo cáo dữ liệu', version: 1, enabled: true, intents: ['aggregate_timeseries', 'list'], instructions: 'Tạo báo cáo từ bảng đã chọn. Dùng metric, cột thời gian và phép tổng hợp trong plan. Khi có biểu đồ hoặc export, lấy dataset tổng hợp trước rồi mới gọi tool tạo artifact.', exampleIds: ['monthly_aggregate', 'list_rows'] }
]);
const clone = value => JSON.parse(JSON.stringify(value));
const defaultById = id => DEFAULT_SKILLS.find(skill => skill.id === id) || null;

function normalizeStoredSkill(value, definition) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...clone(definition),
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, MAX_NAME_LENGTH) : definition.name,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : definition.enabled,
    instructions: typeof source.instructions === 'string' && source.instructions.trim() ? source.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH) : definition.instructions,
    exampleIds: Array.isArray(source.exampleIds) ? [...new Set(source.exampleIds.filter(id => definition.exampleIds.includes(id)))] : [...definition.exampleIds]
  };
}
function normalizeStore(value) {
  const records = Array.isArray(value) ? value : value?.skills;
  return DEFAULT_SKILLS.map(definition => normalizeStoredSkill(Array.isArray(records) ? records.find(item => item?.id === definition.id) : null, definition));
}
function getSkills() { return normalizeStore(StorageHelper.loadJson(SKILLS_FILE, { skills: DEFAULT_SKILLS })); }
function getSkill(id) { return getSkills().find(skill => skill.id === id) || null; }
function validateSkillUpdate(value = {}) {
  const definition = defaultById(value.id);
  if (!definition) throw new Error('Skill không tồn tại.');
  if (typeof value.enabled !== 'boolean') throw new Error('Trạng thái skill không hợp lệ.');
  const name = String(value.name || '').trim();
  const instructions = String(value.instructions || '').trim();
  if (!name || name.length > MAX_NAME_LENGTH) throw new Error(`Tên skill phải có từ 1 đến ${MAX_NAME_LENGTH} ký tự.`);
  if (!instructions || instructions.length > MAX_INSTRUCTIONS_LENGTH) throw new Error(`Hướng dẫn phải có từ 1 đến ${MAX_INSTRUCTIONS_LENGTH} ký tự.`);
  if (!Array.isArray(value.exampleIds)) throw new Error('Danh sách ví dụ không hợp lệ.');
  const exampleIds = [...new Set(value.exampleIds.map(String))];
  if (exampleIds.some(id => !definition.exampleIds.includes(id))) throw new Error('Ví dụ không thuộc skill này.');
  return { ...clone(definition), name, enabled: value.enabled, instructions, exampleIds };
}
function saveSkill(value) {
  const updated = validateSkillUpdate(value);
  const skills = getSkills().map(skill => skill.id === updated.id ? updated : skill);
  StorageHelper.saveJson(SKILLS_FILE, { skills });
  return clone(updated);
}
module.exports = { DEFAULT_SKILLS, MAX_INSTRUCTIONS_LENGTH, MAX_NAME_LENGTH, SKILLS_FILE, getSkills, getSkill, normalizeStore, saveSkill, validateSkillUpdate };
