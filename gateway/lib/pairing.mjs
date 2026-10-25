import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONTEXT = 'burrow-node-goblin-pairing-v1';
export function nodeIdentityPath(stateDir) { return path.join(stateDir, 'node-identity.json'); }
export function loadNodeIdentity(stateDir) {
  if (!stateDir) throw new Error('missing_state_dir');
  const file = nodeIdentityPath(stateDir);
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || !value.publicKey || !value.privateKey) throw new Error('invalid_node_identity');
    return value;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pair = crypto.generateKeyPairSync('ed25519');
  const value = { version: 1, nodeId: crypto.randomUUID(), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), createdAt: new Date().toISOString() };
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  return value;
}
// v1 is retained only for identities approved before channel binding existed.
export function pairingPayload(nonce, gatewayId, gatewayPublicKey, controllerPublicKey, tlsFingerprint) {
  const payload = `${CONTEXT}\0${nonce}\0${gatewayId}\0${gatewayPublicKey}\0${controllerPublicKey}`;
  if (tlsFingerprint == null) return payload;
  if (!/^[0-9a-f]{64}$/.test(tlsFingerprint)) throw new Error('invalid_tls_fingerprint');
  return `burrow-node-goblin-pairing-v2\0${payload}\0${tlsFingerprint}`;
}
export function signPairing(identity, nonce, gatewayId, controllerPublicKey, tlsFingerprint) { return crypto.sign(null, Buffer.from(pairingPayload(nonce, gatewayId, identity.publicKey, controllerPublicKey, tlsFingerprint)), identity.privateKey).toString('base64url'); }
export function verifyPairing({ nonce, gatewayId, gatewayPublicKey, controllerPublicKey, signature, tlsFingerprint }) { try { return crypto.verify(null, Buffer.from(pairingPayload(nonce, gatewayId, gatewayPublicKey, controllerPublicKey, tlsFingerprint)), gatewayPublicKey, Buffer.from(signature, 'base64url')); } catch { return false; } }
export function pairingCode({ nonce, gatewayId, gatewayPublicKey, controllerPublicKey, tlsFingerprint }) { const hex = crypto.createHash('sha256').update(pairingPayload(nonce, gatewayId, gatewayPublicKey, controllerPublicKey, tlsFingerprint)).digest('hex'); return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`.toUpperCase(); }
export function validPairingIdentity(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,254}$/i.test(value) && value !== 'local';
}
export function validPending(entry) {
  try { return entry?.status === 'pending' && validPairingIdentity(entry.gatewayId) && validPairingIdentity(entry.controllerId)
    && typeof entry.publicKey === 'string' && entry.publicKey.length <= 1024 && crypto.createPublicKey(entry.publicKey).asymmetricKeyType === 'ed25519'; } catch { return false; }
}
export const MAX_PENDING_PAIRINGS = 256;
export function boundedPending(values) {
  if (!Array.isArray(values)) return [];
  const entries = new Map();
  for (const entry of values) {
    if (!validPending(entry)) continue;
    const bounded = {
      gatewayId: entry.gatewayId, controllerId: entry.controllerId, publicKey: entry.publicKey,
      status: 'pending', channelBinding: entry.channelBinding === true,
    };
    for (const key of ['nonce', 'generation', 'pairingCode', 'requestedAt']) {
      if (typeof entry[key] === 'string' && entry[key].length <= 256) bounded[key] = entry[key];
    }
    entries.delete(entry.gatewayId);
    entries.set(entry.gatewayId, bounded);
    if (entries.size > MAX_PENDING_PAIRINGS) entries.delete(entries.keys().next().value);
  }
  return [...entries.values()];
}
export function controllerIdentity() { const pair = crypto.generateKeyPairSync('ed25519'); return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }; }
