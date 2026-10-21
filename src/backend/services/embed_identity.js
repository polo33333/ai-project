'use strict';
const crypto = require('node:crypto');
const fail = () => Object.assign(new Error('Danh tính Embed không hợp lệ hoặc token đã hết hạn.'), { statusCode: 401 });

function normalize(data) {
  if (!data || data.enabled !== true) return { enabled: false };
  const serverUrl = new URL(String(data.serverUrl || ''));
  if (serverUrl.protocol !== 'https:' && !(serverUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(serverUrl.hostname))) throw new Error('Server xác thực phải dùng HTTPS.');
  const issuer = String(data.issuer || '').trim(), audience = String(data.audience || '').trim();
  if (!issuer || !audience || issuer.length > 500 || audience.length > 200) throw new Error('Cần issuer và audience hợp lệ.');
  const publicKey = String(data.publicKey || '').trim();
  if (publicKey.includes('PRIVATE KEY')) throw new Error('Chỉ nhập khóa công khai, không nhập khóa riêng.');
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('Cần khóa công khai RSA từ 2048 bit.');
  return { enabled: true, required: data.required === true, serverUrl: serverUrl.href, issuer, audience, publicKey: key.export({ type: 'spki', format: 'pem' }) };
}

function verify(config, token) {
  const setup = config.identity;
  if (!token) { if (setup?.enabled && setup.required) throw fail(); return null; }
  if (!setup?.enabled || typeof token !== 'string' || token.length > 16384) throw fail();
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw fail();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (header.alg !== 'RS256' || header.crit) throw fail();
    if (!crypto.verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), { key: setup.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(parts[2], 'base64url'))) throw fail();
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url')), now = Date.now() / 1000;
    if (claims.iss !== setup.issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(setup.audience) : claims.aud === setup.audience)
      || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now || claims.exp > now + 3600
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now))
      || typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 200) throw fail();
    return { id: crypto.createHash('sha256').update(JSON.stringify([config.id, claims.iss, claims.sub])).digest('hex'),
      subject: claims.sub, name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : claims.sub,
      issuer: claims.iss, verified: true };
  } catch (_) { throw fail(); }
}
module.exports = { normalize, verify };
