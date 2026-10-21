'use strict';
// Only render permission-filtered tool metadata; never infer business values.
function renderSchemaDescription(selection = {}, attributes = []) {
  const requested = new Set((attributes || []).map(value => String(value).normalize('NFC').toLocaleLowerCase('vi')));
  const escape = value => String(value || '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const tables = (selection.tables || []).map(table => ({ ...table,
    columns: (table.columns || []).filter(column => column.isVisible !== false && (column.name || column.columnName)
      && (!requested.size || [column.name, column.columnName, column.displayName, column.businessRole].some(value => value && requested.has(String(value).normalize('NFC').toLocaleLowerCase('vi')))))
  })).filter(table => table.columns.length);
  if (!tables.length) return null;
  return 'Theo c\u1ea5u tr\u00fac d\u1eef li\u1ec7u \u0111\u01b0\u1ee3c ph\u00e9p tra c\u1ee9u, h\u1ec7 th\u1ed1ng l\u01b0u c\u00e1c th\u00f4ng tin sau:\n\n'
    + tables.map(table => '**' + escape(table.displayName || table.tableName) + '**\n\n'
      + '| Th\u00f4ng tin | Tr\u01b0\u1eddng d\u1eef li\u1ec7u | M\u00f4 t\u1ea3 c\u1ea5u h\u00ecnh |\n| --- | --- | --- |\n'
      + table.columns.map(column => '| ' + escape(column.displayName || column.name || column.columnName) + ' | '
        + escape(column.name || column.columnName) + ' | ' + escape(column.description || '\u2014') + ' |').join('\n')).join('\n\n')
    + '\n\nPh\u1ea1m vi tr\u00ean l\u00e0 c\u1ea5u tr\u00fac \u0111\u00e3 c\u1ea5u h\u00ecnh cho AI, ch\u01b0a truy v\u1ea5n gi\u00e1 tr\u1ecb c\u1ee7a t\u1eebng doanh nghi\u1ec7p.';
}
module.exports = { renderSchemaDescription };
