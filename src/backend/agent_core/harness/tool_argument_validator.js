'use strict';

function validateToolCall(toolManager, call, allowedToolNames = null) {
  if (!call || typeof call !== 'object' || !call.name) {
    return { valid: false, category: 'MODEL_FORMAT_ERROR', errors: ['Tool call is missing a valid tool name.'] };
  }
  const allowed = Array.isArray(allowedToolNames) ? new Set(allowedToolNames) : null;
  if (allowed && !allowed.has(call.name)) {
    return { valid: false, category: 'UNKNOWN_TOOL', errors: [`Tool "${call.name}" is not enabled for this request.`] };
  }
  const tool = toolManager?.getTool(call.name);
  if (!tool) return { valid: false, category: 'UNKNOWN_TOOL', errors: [`Tool "${call.name}" does not exist.`] };
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    return { valid: false, category: 'INVALID_ARGUMENTS', errors: [call.parseError || 'Tool arguments must be a JSON object.'] };
  }

  const properties = tool.parameters?.properties || {};
  const args = Object.fromEntries(Object.entries(call.arguments).filter(([key]) => Object.prototype.hasOwnProperty.call(properties, key)));
  const validation = tool.validateArgs(args);
  if (!validation.valid) return { valid: false, category: 'INVALID_ARGUMENTS', errors: validation.errors || ['Invalid tool arguments.'], args, tool };
  return { valid: true, args, tool };
}

module.exports = { validateToolCall };
