'use strict';
// Protocol delimiters, not language/keyword heuristics: preserve normal business prose.
function visibleAnswer(value) {
  const text = String(value || '');
  const start = '<final_answer>', end = '</final_answer>';
  const opening = text.indexOf(start);
  if (opening >= 0) {
    const closing = text.indexOf(end, opening + start.length);
    return closing < 0 ? '' : text.slice(opening + start.length, closing).trim();
  }
  let answer = text;
  for (const tag of ['think', 'analysis', 'reasoning']) {
    const open = '<' + tag + '>', close = '</' + tag + '>';
    let index = answer.indexOf(open);
    while (index >= 0) {
      const stop = answer.indexOf(close, index + open.length);
      answer = stop < 0 ? answer.slice(0, index) : answer.slice(0, index) + answer.slice(stop + close.length);
      index = answer.indexOf(open);
    }
  }
  return answer.trim();
}
const instruction = 'User-visible output must contain only the finished business answer in the language of the current user question. Never include planning, self-instructions, draft verification, analysis, reasoning or narration about preparing the response. Keep technical field names unchanged. For a final answer, wrap only the finished answer in <final_answer> and </final_answer>; all text outside this final-answer block is private and will not be displayed. Tool calls must remain native tool calls, never wrapped in this block.';
module.exports = { visibleAnswer, instruction };
