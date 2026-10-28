'use strict';
const { normalize } = require('../../training/request_planner');
function resolve(question) {
  const text = normalize(question);
  const separate = /\b(?:chia|tach|split|separate)\b.{0,50}\b(?:files?|tep)\b|\b(?:files?|tep)\b.{0,25}\brieng\b|\bmoi\b.{0,40}\b(?:mot|1)\s+(?:file|tep)\b/.test(text);
  return { export: separate || /\b(?:xuat file|xuat excel|export|download|tai ve)\b/.test(text), separate,
    expectedFiles: separate ? Number(text.match(/\b(\d+)\s+(?:files?|tep)\b/)?.[1]) || null : null };
}
module.exports = { resolve };
