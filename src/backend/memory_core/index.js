'use strict';

const { MemoryService } = require('./memory_service');
const policy = require('./memory_policy');
const { detectTopic } = require('./topic_detector');
const { resolveReference } = require('./reference_store');
const sanitizer = require('./memory_sanitizer');

const memoryService = new MemoryService();

module.exports = { memoryService, MemoryService, policy, detectTopic, resolveReference, sanitizer };
