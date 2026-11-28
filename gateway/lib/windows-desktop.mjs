import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREENSHOT_BYTES = 1024 * 1024;
const REPLY_BYTES = 1_450_000; // base64(1 MiB) + envelope, below the 2 MiB gateway frame
const actions = ['status', 'screenshot', 'windows', 'inspect', 'invoke'];
const limitError = code => Object.assign(new Error(code), { code });
export const desktopErrorCodes = new Set([
  'desktop_arguments_invalid', 'desktop_disabled', 'desktop_helper_absent', 'desktop_busy',
  'desktop_starting', 'desktop_timeout', 'desktop_transport_required', 'desktop_response_invalid',
  'desktop_session_0', 'desktop_elevated', 'desktop_session_inactive', 'desktop_input_unavailable', 'desktop_indicator_unavailable',
  'desktop_window_unavailable', 'desktop_window_access_denied', 'desktop_control_unavailable',
  'desktop_action_failed', 'desktop_screenshot_too_large',
]);

export function desktopRequest(value) {
  const { action, windowId, controlId } = value ?? {};
  const windowAction = action === 'inspect' || action === 'invoke';
  if (!actions.includes(action) || Object.keys(value).some(k => !['action', 'windowId', 'controlId'].includes(k))
    || (windowAction ? typeof windowId !== 'string' || !/^\d{1,10}:\d{1,19}$/.test(windowId) : windowId !== undefined)
    || (action === 'invoke' ? typeof controlId !== 'string' || !/^-?\d+(?::-?\d+)*$/.test(controlId) || controlId.length > 160 : controlId !== undefined)) {
    throw limitError('desktop_arguments_invalid');
  }
  return { action, ...(windowAction ? { windowId } : {}), ...(action === 'invoke' ? { controlId } : {}) };
}

export class WindowsDesktop {
  constructor({ enabled, spawnHelper = spawn, systemRoot = process.env.SystemRoot, timeout = 5000, startupTimeout = 30_000 } = {}) {
    this.reason = enabled ? 'desktop_helper_absent' : 'desktop_disabled';
    this.timeout = timeout;
    if (!enabled || !systemRoot) return;
    const winps = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const entry = fileURLToPath(new URL('../deploy/windows/desktop-helper.ps1', import.meta.url));
    // The foreground launcher opts in locally. No listener, durable switch, or restart on loss of consent.
    const child = this.child = spawnHelper(winps, ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', entry], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    });
    // Assembly loading/C# compilation is startup, not a desktop action. Never
    // queue an action across this boundary or extend the action deadline.
    this.startupTimer = setTimeout(() => this.stop('desktop_timeout'), startupTimeout);
    this.startupTimer.unref?.();
    let reply = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      reply += chunk;
      if (Buffer.byteLength(reply) > REPLY_BYTES) return this.stop('desktop_response_invalid');
      const end = reply.indexOf('\n');
      if (end === -1) return;
      if (!this.child || end !== reply.length - 1) return this.stop('desktop_response_invalid');
      let message;
      try { message = JSON.parse(reply); } catch { return this.stop('desktop_response_invalid'); }
      reply = '';
      if (!message || Array.isArray(message) || typeof message !== 'object') return this.stop('desktop_response_invalid');
      if (!this.ready) {
        if (message.ready !== true || Object.keys(message).length !== 1) return this.stop('desktop_response_invalid');
        clearTimeout(this.startupTimer);
        this.ready = true;
        return;
      }
      const pending = this.pending;
      if (!pending) return this.stop('desktop_response_invalid');
      this.pending = null;
      clearTimeout(pending.timer);
      if (message.error) return pending.reject(limitError(desktopErrorCodes.has(message.error) ? message.error : 'desktop_action_failed'));
      pending.resolve(message);
    });
    child.once('error', () => this.stop());
    child.once('exit', () => this.stop());
    child.stdin.on('error', () => this.stop());
  }

  async execute(request) {
    const command = desktopRequest(request);
    if (!this.child) {
      if (command.action === 'status') return { available: false, state: this.reason };
      throw limitError(this.reason);
    }
    if (!this.ready) {
      if (command.action === 'status') return { available: false, state: 'desktop_starting' };
      throw limitError('desktop_starting');
    }
    if (this.pending) throw limitError('desktop_busy');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.stop('desktop_timeout'), this.timeout) };
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  stop(reason = 'desktop_helper_absent') {
    clearTimeout(this.startupTimer);
    const child = this.child;
    if (child) {
      this.child = null;
      this.reason = reason;
      child.stdin.destroy();
      if (child.exitCode == null && child.signalCode == null) child.kill();
    }
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(limitError(reason));
    }
  }
}
