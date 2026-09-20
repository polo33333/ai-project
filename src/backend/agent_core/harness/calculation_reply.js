'use strict';

function explicitUnit(question = '') {
  const text = String(question);
  if (/\$\s*\d|\d\s*\$/u.test(text)) return { prefix: '$', suffix: '' };
  const match = text.match(/\d(?:[\d.,]*)\s*(%|vnđ|vnd|usd|eur|gbp|jpy|đồng|kg|km|cm|mm|m|g|l|ml|giờ|phút|ngày)\b/iu);
  return match ? { prefix: '', suffix: ` ${match[1]}` } : { prefix: '', suffix: '' };
}

function buildCalculationReply(question = '', call = {}) {
  if (call?.toolName !== 'calculate_expression' || call?.success === false || call?.result?.value === undefined) return '';
  const expression = String(call.args?.expression || call.result?.expression || '').replace(/\$/g, '').trim();
  const value = call.result.value;
  const unit = explicitUnit(question);
  return `Kết quả của phép tính **${expression}** là **${unit.prefix}${value}${unit.suffix}**.`;
}

module.exports = { buildCalculationReply, explicitUnit };
