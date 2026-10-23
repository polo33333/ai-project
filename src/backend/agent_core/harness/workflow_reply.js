'use strict';

// User-facing text for a workflow handoff. Results themselves are rendered by
// the execution card; the text names the workflow and, when waiting, exactly
// which inputs are missing so the user knows what to answer.
const clean = value => String(value ?? '').replace(/[*_`[\]]/g, '').trim();

function missingLabels(state) {
  return (state.missingInputs || []).map(item => clean(item.label || state.inputLabels?.[item.key] || item.ask || item.key)).filter(Boolean);
}

function reply(state = {}) {
  const name = clean(state.name) ? ` **${clean(state.name)}**` : '';
  if (state.status === 'WAITING_INPUT') {
    const missing = missingLabels(state);
    return missing.length ? `Để chạy quy trình${name}, mình cần thêm thông tin sau:\n${missing.map(item => `- ${item}`).join('\n')}`
      : name ? `Quy trình${name} cần bổ sung thông tin để tiếp tục.` : 'Cần bổ sung thông tin để tiếp tục quy trình.';
  }
  if (state.status === 'CANCELLED') return 'Đã dừng tác vụ.';
  if (state.status === 'SUCCEEDED') return `Đã chạy xong quy trình${name}. Kết quả hiển thị bên dưới.`;
  if (state.status === 'FAILED') return `Quy trình${name} chưa thể hoàn tất.${state.error?.message ? ` Lý do: ${clean(state.error.message).slice(0, 200)}.` : ''}`;
  return `Đã tiếp nhận quy trình${name}. Bạn có thể theo dõi trạng thái bên dưới.`;
}

module.exports = { reply, missingLabels };
