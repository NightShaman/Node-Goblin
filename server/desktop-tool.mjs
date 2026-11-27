import { desktopErrorCodes, desktopRequest, SCREENSHOT_BYTES } from '../gateway/lib/windows-desktop.mjs';

const name = 'node_goblin_desktop';
const text = result => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });
const failure = error => ({ ...text({ error }), isError: true });
const connErrors = new Set(['controller_not_running', 'gateway_not_connected', 'gateway_not_ready', 'gateway_disconnected', 'unknown_method']);

export function registerDesktopTool(tools, service) {
  tools?.register({ name, availability: 'grant-required',
    description: 'Use an explicitly enabled Windows Node Goblin desktop. Check status, capture the primary display, list main windows, inspect an exact window, or invoke one of its exposed controls. Never retry a lost invoke blindly.',
    inputSchema: { type: 'object', required: ['targetId', 'action'], additionalProperties: false, properties: {
      targetId: { type: 'string', description: 'Exact approved Node Goblin gateway ID.' },
      action: { type: 'string', enum: ['status', 'screenshot', 'windows', 'inspect', 'invoke'] },
      windowId: { type: 'string', description: 'Exact window ID from windows; required for inspect and invoke.' },
      controlId: { type: 'string', description: 'Exact control ID from inspect; required for invoke.' },
    } },
    async handler(args, caller = {}) {
      let targetId, request;
      try {
        const { targetId: target, ...body } = args || {};
        if (typeof target !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,254}$/i.test(target) || target === 'local') return failure('target_id_invalid');
        targetId = target;
        request = desktopRequest(body);
        caller.signal?.throwIfAborted();
        const { response } = await service.dispatchDesktop(targetId, request);
        caller.signal?.throwIfAborted();
        const result = response?.result;
        if (response.ok !== true || !result || typeof result !== 'object' || Array.isArray(result)) return failure('desktop_response_invalid');
        if (request.action === 'screenshot') {
          const { data, mimeType, width, height } = result;
          if (mimeType !== 'image/jpeg' || typeof data !== 'string' || data.length % 4 !== 0 || data.length > Math.ceil(SCREENSHOT_BYTES / 3) * 4
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || !Number.isInteger(width) || !Number.isInteger(height)
            || Math.min(width, height) < 1 || Math.max(width, height) > 1280) return failure('desktop_response_invalid');
          const bytes = Buffer.from(data, 'base64');
          if (bytes.toString('base64') !== data || bytes.length < 4 || bytes.length > SCREENSHOT_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return failure('desktop_response_invalid');
          return { content: [...text({ targetId, width, height, display: 'primary' }).content, { type: 'image', mimeType, data }] };
        }
        return text({ targetId, ...result, ...(request.action === 'status' ? { connected: true } : {}) });
      } catch (error) {
        const code = error.code ?? error.message;
        if (caller.signal?.aborted || (request?.action === 'invoke' && ['gateway_disconnected', 'desktop_timeout', 'desktop_helper_absent'].includes(code))) return failure('desktop_outcome_not_confirmed');
        if (request?.action === 'status' && connErrors.has(code)) return text({ targetId, connected: code === 'unknown_method', available: false, state: code === 'unknown_method' ? 'desktop_unsupported' : code });
        return failure(desktopErrorCodes.has(code) || connErrors.has(code) ? code : 'desktop_action_failed');
      }
    },
  });
}
