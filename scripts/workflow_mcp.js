'use strict';
const tools = require('../src/backend/automation/mcp_tools');
if (require.main === module) tools.main();
module.exports = tools;
