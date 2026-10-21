'use strict';

// Keep key groups intact: UNIQUE(a,b) never proves that a or b is unique.
function readUniqueConstraints(json) {
  return JSON.parse(json || '[]').map(key => ({
    name: key.name,
    isPrimaryKey: !!key.isPrimaryKey,
    isDisabled: !!key.isDisabled,
    hasFilter: !!key.hasFilter,
    columnNames: (key.columns || []).map(column => column.columnName)
  }));
}

module.exports = { readUniqueConstraints };
