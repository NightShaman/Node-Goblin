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
export function pairingPayload(nonce, gatewayId, gatewayPublicKey, controllerPublicKey) { return `${CONTEXT}\0${nonce}\0${gatewayId}\0${gatewayPublicKey}\0${controllerPublicKey}`; }
export function signPairing(identity, nonce, gatewayId, controllerPublicKey) { return crypto.sign(null, Buffer.from(pairingPayload(nonce, gatewayId, identity.publicKey, controllerPublicKey)), identity.privateKey).toString('base64url'); }
export function verifyPairing({ nonce, gatewayId, gatewayPublicKey, controllerPublicKey, signature }) { try { return crypto.verify(null, Buffer.from(pairingPayload(nonce, gatewayId, gatewayPublicKey, controllerPublicKey)), gatewayPublicKey, Buffer.from(signature, 'base64url')); } catch { return false; } }
export function pairingCode({ nonce, gatewayId, gatewayPublicKey, controllerPublicKey }) { const hex = crypto.createHash('sha256').update(pairingPayload(nonce, gatewayId, gatewayPublicKey, controllerPublicKey)).digest('hex'); return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`.toUpperCase(); }
export function controllerIdentity() { const pair = crypto.generateKeyPairSync('ed25519'); return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }; }
