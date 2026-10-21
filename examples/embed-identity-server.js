'use strict';
// Mount this handler on the WEBSITE server, after its normal session middleware.
const crypto = require('node:crypto');
function createChatIdentityHandler({ privateKey, issuer, widgets, getAuthenticatedUser }) {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('RSA key must be at least 2048 bits');
  return async function chatIdentity(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'GET') { res.writeHead(405); res.end(JSON.stringify({message:'Method not allowed'})); return; }
    try {
      const embedId = new URL(req.url, 'https://website.invalid').searchParams.get('embedId');
      const audience = Object.hasOwn(widgets, embedId) ? widgets[embedId] : null;
      if (!audience) { res.writeHead(403); res.end(JSON.stringify({message:'Unknown widget'})); return; }
      // Read user from the verified server session, never query/body supplied IDs.
      const user = await getAuthenticatedUser(req);
      if (!user) { res.end(JSON.stringify({token:null})); return; }
      if (user.id == null || !String(user.id).trim()) throw new Error('Missing user ID');
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now()/1000);
      const input = encode({alg:'RS256',typ:'JWT'}) + '.' + encode({iss:issuer,aud:audience,sub:String(user.id),name:String(user.displayName || user.id),iat:now,exp:now+300});
      const token = input + '.' + crypto.sign('RSA-SHA256',Buffer.from(input),{key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64url');
      res.end(JSON.stringify({token}));
    } catch (_) { res.writeHead(500); res.end(JSON.stringify({message:'Cannot issue identity token'})); }
  };
}
module.exports = { createChatIdentityHandler };
