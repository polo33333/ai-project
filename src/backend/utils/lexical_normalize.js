'use strict';

// Search fields only. Never apply to displayed text, identifiers or memory pronouns.
module.exports = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
