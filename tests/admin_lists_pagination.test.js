'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Admin modules live in admin-client/, modules both clients use in shared/.
const frontendFile = rel => ['admin-client', 'shared'].map(dir => path.join(__dirname, '../src/frontend', dir, rel)).find(file => fs.existsSync(file));
for (const [key, dataName, render, body, pager, moduleName] of [
  ['mcp_servers', 'mcpServersData', 'renderMcpServersTable', 'mcp-servers-tbody', 'mcp-servers-pagination', 'mcp_api'],
  ['api_keys', 'apiKeysData', 'renderApiKeysTable', 'api-keys-tbody', 'api-keys-pagination', 'mcp_api'],
  ['embed_configs', 'embedConfigsData', 'renderEmbedConfigs', 'embed-config-list', 'embed-configs-pagination', 'mcp_api'],
  ['ai_providers', 'aiProvidersData', 'renderAiProvidersTable', 'page-ai-providers-tbody', 'ai-providers-pagination', 'ai_providers']
]) {
  test(`${key} paginates with continuous STT and clamps after deletion`, () => {
    const elements = { [body]: { innerHTML: '' }, [pager]: { innerHTML: '' } };
    const context = vm.createContext({ window: {}, document: { getElementById: id => elements[id] || null } });
    const app = fs.readFileSync(path.join(__dirname, '../src/frontend/shared/js/app.js'), 'utf8');
    const end = app.indexOf('\n};', app.indexOf('window.changePageSize =')) + 4;
    vm.runInContext(app.slice(app.indexOf('window.paginationState ='), end), context);
    vm.runInContext(fs.readFileSync(frontendFile(`js/modules/${moduleName}.js`), 'utf8'), context);
    context.window[dataName] = Array.from({ length: 23 }, (_, i) => ({ id: `demo${i}`, name: `Sample ${i}`, key: 'sk-demo-only', allowedOrigins: [] }));
    vm.runInContext(`${render}()`, context);
    assert.equal((elements[body].innerHTML.match(/class="row-index"|class="embed-config-index"/g) || []).length, 10);
    assert.match(elements[pager].innerHTML, /value="100"/);
    context.window.changePage(key, 3, render);
    assert.equal((elements[body].innerHTML.match(/class="row-index"|class="embed-config-index"/g) || []).length, 3);
    assert.match(elements[body].innerHTML, />21<\/td>|aria-label="STT 21"/);
    context.window.changePageSize(key, 20, render);
    assert.equal(context.window.paginationState[key].currentPage, 1);
    assert.equal((elements[body].innerHTML.match(/class="row-index"|class="embed-config-index"/g) || []).length, 20);
    context.window.changePage(key, 2, render);
    context.window[dataName] = context.window[dataName].slice(0, 2);
    vm.runInContext(`${render}()`, context);
    assert.equal(context.window.paginationState[key].currentPage, 1);
    context.window[dataName] = [];
    vm.runInContext(`${render}()`, context);
    assert.match(elements[pager].innerHTML, /0 - 0/);
  });
}
