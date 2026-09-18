'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
let cachedKeySource;
let cachedKey;

function readKey() {
  // The encryption key is immutable for a running process. Rotation requires
  // restart; changing the environment source invalidates this cache (tests).
  const source = process.env.APP_DATA_ENCRYPTION_KEY || process.env.APP_DATA_ENCRYPTION_KEY_FILE;
  if (source && source === cachedKeySource && cachedKey) return cachedKey;
  const value = process.env.APP_DATA_ENCRYPTION_KEY ||
    (process.env.APP_DATA_ENCRYPTION_KEY_FILE && fs.readFileSync(process.env.APP_DATA_ENCRYPTION_KEY_FILE, 'utf8').trim());
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('A separate 32-byte APP_DATA_ENCRYPTION_KEY_FILE is required.');
  cachedKeySource = source;
  cachedKey = Buffer.from(value, 'hex');
  return cachedKey;
}

function encrypt(value, context) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', readKey(), nonce);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { $khSecret: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(value, context) {
  const cipher = crypto.createDecipheriv('aes-256-gcm', readKey(), Buffer.from(value.nonce, 'base64'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
}

// Encrypt entire domain records that contain credentials. Also protect nested
// headers/request snapshots: credentials can appear anywhere in legacy payloads.
const secretField = /password|secret|token|api.?key|authorization|cookie|connection.?string|headers|^env$/i;
function protect(value, context, reverse = false) {
  if (reverse && value && value.$khSecret === 1) return decrypt(value, context);
  if (Array.isArray(value)) return value.map((entry, i) => protect(entry, `${context}/${i}`, reverse));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    !reverse && secretField.test(key) && entry !== null ? encrypt(entry, `${context}/${key}`) : protect(entry, `${context}/${key}`, reverse)
  ]));
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
module.exports = { readKey, encrypt, decrypt, protect, sha256 };
