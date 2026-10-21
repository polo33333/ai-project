'use strict';
const StorageHelper = require('../utils/storage_helper');
const service = {};
StorageHelper.bind(service, 'settings', 'tool_settings.json', []);
service.isEnabled = name => service.settings.find(item => item.id === name)?.enabled !== false;
service.setEnabled = (name, enabled, expectedEnabled, actor) => {
  if (typeof enabled !== 'boolean' || typeof expectedEnabled !== 'boolean') throw Object.assign(new Error('Trạng thái tool phải là boolean.'), { statusCode: 400 });
  if (service.isEnabled(name) !== expectedEnabled) throw Object.assign(new Error('Trạng thái tool đã thay đổi. Hãy tải lại danh sách.'), { statusCode: 409 });
  const next = service.settings.filter(item => item.id !== name).concat({ id: name, enabled, updatedBy: actor, updatedAt: new Date().toISOString() });
  StorageHelper.saveJson('tool_settings.json', next);
  service.settings = next;
  return { name, enabled };
};
module.exports = service;
