'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { verify } = require('../../../scripts/backup_all');

const magic = Buffer.from('KHBACKUP1\n');
const safePart = part => part && part !== '.' && part !== '..' && !/[\\/:\x00-\x1f]/.test(part);

async function description(directory) {
  const manifest = await verify(directory);
  const files = ['manifest.json', ...manifest.components.map(c => c.relativePath)];
  const entries = [];
  for (const name of files) {
    const stat = await fsp.stat(path.join(directory, ...name.split('/')));
    entries.push({ name, bytes: stat.size });
  }
  const header = Buffer.from(JSON.stringify({ version: 1, backupId: manifest.backupId, entries }));
  if (header.length > 8 * 1024 * 1024) throw new Error('Backup header too large.');
  return { manifest, entries, header, bytes: magic.length + 8 + header.length + entries.reduce((sum, item) => sum + item.bytes, 0) };
}

async function createStream(directory) {
  const info = await description(directory);
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(info.header.length));
  const stream = Readable.from((async function* () {
    yield magic; yield length; yield info.header;
    for (const item of info.entries) yield* fs.createReadStream(path.join(directory, ...item.name.split('/')));
  })());
  return { stream, bytes: info.bytes, filename: `${info.manifest.backupId}.khbackup` };
}

async function unpack(file, directory) {
  const handle = await fsp.open(file, 'r');
  try {
    const prefix = Buffer.alloc(magic.length + 8);
    if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length || !prefix.subarray(0, magic.length).equals(magic)) throw new Error('Invalid backup file.');
    const headerSize = Number(prefix.readBigUInt64BE(magic.length));
    if (!Number.isSafeInteger(headerSize) || headerSize < 2 || headerSize > 8 * 1024 * 1024) throw new Error('Invalid backup header.');
    const headerBytes = Buffer.alloc(headerSize);
    if ((await handle.read(headerBytes, 0, headerSize, prefix.length)).bytesRead !== headerSize) throw new Error('Truncated backup header.');
    const header = JSON.parse(headerBytes.toString('utf8'));
    if (header.version !== 1 || !/^storage-[0-9TZ-]+-[a-f0-9]{8}$/.test(header.backupId) || !Array.isArray(header.entries) || header.entries.length > 100000) throw new Error('Invalid backup index.');
    const seen = new Set();
    let offset = prefix.length + headerSize;
    const total = (await handle.stat()).size;
    for (const item of header.entries) {
      if (typeof item.name !== 'string' || item.name.split('/').some(p => !safePart(p)) || seen.has(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || offset + item.bytes > total) throw new Error('Unsafe or truncated backup entry.');
      seen.add(item.name);
      const destination = path.join(directory, ...item.name.split('/'));
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (item.bytes) await pipeline(fs.createReadStream(file, { start: offset, end: offset + item.bytes - 1 }), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      else await fsp.writeFile(destination, '', { flag: 'wx', mode: 0o600 });
      offset += item.bytes;
    }
    if (offset !== total || !seen.has('manifest.json')) throw new Error('Unexpected backup file contents.');
    const manifest = await verify(directory);
    if (manifest.backupId !== header.backupId) throw new Error('Backup ID mismatch.');
    const expected = new Set(['manifest.json', ...manifest.components.map(component => component.relativePath)]);
    if (seen.size !== expected.size || [...seen].some(name => !expected.has(name))) throw new Error('Unexpected backup entry.');
    return manifest;
  } finally { await handle.close(); }
}

async function receiveUpload(req, destination, limit = Number(process.env.BACKUP_UPLOAD_MAX_BYTES || 10 * 1024 * 1024 * 1024)) {
  let bytes = 0;
  const counter = async function* (source) {
    for await (const chunk of source) { bytes += chunk.length; if (bytes > limit) throw new Error('Backup upload exceeds size limit.'); yield chunk; }
  };
  await pipeline(req, counter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return bytes;
}

module.exports = { createStream, unpack, receiveUpload };
