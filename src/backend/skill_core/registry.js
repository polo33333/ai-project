'use strict';

const skills = [
  {
    id: 'record_lookup', version: 1, intents: ['record_lookup'],
    instructions: 'Truy vấn đúng bảng đã chọn. Chỉ dùng các cột có trong schema. Với tìm kiếm tên hoặc mã, dùng điều kiện chính xác khi có mã và LIKE khi là tên.',
    exampleIds: ['lookup_by_code']
  },
  {
    id: 'aggregate_report', version: 1, intents: ['aggregate_timeseries', 'list'],
    instructions: 'Tạo báo cáo từ bảng đã chọn. Dùng metric, cột thời gian và phép tổng hợp trong plan. Khi có biểu đồ hoặc export, lấy dataset tổng hợp trước rồi mới gọi tool tạo artifact.',
    exampleIds: ['monthly_aggregate', 'list_rows']
  }
];

function getSkills() { return skills.map(skill => ({ ...skill, intents: [...skill.intents], exampleIds: [...skill.exampleIds] })); }
function getSkill(id) { return getSkills().find(skill => skill.id === id) || null; }

module.exports = { getSkills, getSkill };
