import os from 'node:os';
import net from 'node:net';

// Bound independently of the JSONL frame limit: a host with many virtual
// interfaces should not turn a small identity response into an inventory dump.
export const MAX_HOST_INTERFACES = 32;
export const MAX_HOST_ADDRESSES = 64;
const safeText = (value, max, pattern) => typeof value === 'string' && value.length > 0 && value.length <= max && pattern.test(value) ? value : null;

function interfaceKind(name) {
  // Hints derived from interface names only; names do not establish topology.
  if (/^(?:docker\d*|veth|br-|cni|flannel|podman|virbr|lxc|lxdbr)/i.test(name)) return 'container';
  if (/^(?:tun|tap|wg|tailscale|zt|utun|ppp|vpn)/i.test(name)) return 'vpn';
  if (/^(?:eth|en|wlan|wl|bond)/i.test(name)) return 'lan-candidate';
  return 'unknown';
}

function validAddress(value, family) {
  if (typeof value !== 'string' || value.length > 45 || value.includes('%')) return false;
  return net.isIP(value) === (family === 'IPv4' ? 4 : 6);
}

export function collectHostMetadata({ hostname = () => os.hostname(), platform = () => os.platform(), networkInterfaces = () => os.networkInterfaces() } = {}) {
  const host = {
    hostname: safeText(hostname(), 255, /^[a-zA-Z0-9_.-]+$/),
    platform: safeText(platform(), 32, /^[a-z0-9_-]+$/),
    addresses: [],
  };
  let interfaces;
  try { interfaces = networkInterfaces(); } catch { return host; }
  if (!interfaces || typeof interfaces !== 'object' || Array.isArray(interfaces)) return host;
  const names = Object.keys(interfaces).filter((name) => safeText(name, 64, /^[a-zA-Z0-9_.:@-]+$/)).sort().slice(0, MAX_HOST_INTERFACES);
  for (const name of names) {
    if (!Array.isArray(interfaces[name])) continue;
    for (const entry of interfaces[name]) {
      if (!entry || typeof entry !== 'object' || entry.internal !== false) continue;
      const family = entry.family === 'IPv4' || entry.family === 4 ? 'IPv4' : entry.family === 'IPv6' || entry.family === 6 ? 'IPv6' : null;
      if (!family || !validAddress(entry.address, family)) continue;
      // Do not expose loopback even if an interface incorrectly marks it external.
      if (family === 'IPv4' && entry.address.startsWith('127.')) continue;
      if (family === 'IPv6' && net.isIP(entry.address) === 6 && /^(?:::1|::ffff:127\.)/i.test(entry.address)) continue;
      host.addresses.push({ interface: name, interfaceKind: interfaceKind(name), family, address: entry.address });
      if (host.addresses.length === MAX_HOST_ADDRESSES) return host;
    }
  }
  return host;
}

// Revalidate the authenticated remote report at the controller boundary. Only
// documented fields survive; interface kind remains a hint, not routing proof.
export function normalizeHostMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hostname = safeText(value.hostname, 255, /^[a-zA-Z0-9_.-]+$/);
  const platform = safeText(value.platform, 32, /^[a-z0-9_-]+$/);
  if (!hostname || !platform || !Array.isArray(value.addresses)) return null;
  const addresses = value.addresses.slice(0, MAX_HOST_ADDRESSES).filter((entry) =>
    entry && safeText(entry.interface, 64, /^[a-zA-Z0-9_.:@-]+$/)
    && ['IPv4', 'IPv6'].includes(entry.family) && validAddress(entry.address, entry.family)
    && !(entry.family === 'IPv4' && entry.address.startsWith('127.'))
    && !(entry.family === 'IPv6' && /^(?:::1$|::ffff:127\.)/i.test(entry.address))
  ).map((entry) => ({ interface: entry.interface, interfaceKind: interfaceKind(entry.interface), family: entry.family, address: entry.address }));
  addresses.sort((a, b) => ['lan-candidate','unknown','vpn','container'].indexOf(a.interfaceKind) - ['lan-candidate','unknown','vpn','container'].indexOf(b.interfaceKind));
  return { hostname, platform, addresses };
}
