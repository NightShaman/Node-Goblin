import { digestHex, truncateUtf8 } from './protocol.mjs';

// Includes the JSONL delimiter. Budget the serialized envelope, not source text:
// a single source byte can require six JSON bytes (for example NUL).
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const size = (message) => Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;

export function boundOutputFrame(message) {
  if (size(message) <= MAX_FRAME_BYTES) return message;
  const copy = structuredClone(message);
  const outcome = copy.evidence ?? copy.result?.outcome;
  const fields = outcome?.type === 'process.result' ? ['stdout', 'stderr']
    : outcome?.tool === 'files_read' && outcome.ok ? ['content']
      : copy.type === 'process.stream' ? ['data'] : [];
  const target = copy.type === 'process.stream' ? copy : outcome;
  if (fields.length) {
    const original = Object.fromEntries(fields.map(key => [key, target[key] || '']));
    const update = (budget) => {
      let remaining = budget;
      for (const key of fields) {
        target[key] = truncateUtf8(original[key], remaining);
        remaining -= Buffer.byteLength(target[key]);
      }
      target.truncated = true;
      target.transportTruncated = true;
      if (outcome?.type === 'process.result') {
        outcome.stdoutDigest = digestHex(outcome.stdout);
        outcome.stderrDigest = digestHex(outcome.stderr);
      } else if (outcome?.tool === 'files_read') {
        // Transport truncation is distinct from the runner's byte range limit.
        // Do not invent a resumable source offset for arbitrary encodings.
        outcome.incomplete = true;
        outcome.nextOffsetBytes = null;
        outcome.returnedBytes = Buffer.byteLength(outcome.content, outcome.encoding || 'utf8');
        outcome.contentHash = digestHex(Buffer.from(outcome.content, outcome.encoding || 'utf8')).slice(0, 16);
        delete outcome.resultFingerprint;
        outcome.warnings = [...(message.result.outcome.warnings || []), 'transport frame limit reached; read a smaller byte range'];
      }
    };
    let low = 0;
    let high = fields.reduce((n, key) => n + Buffer.byteLength(original[key]), 0);
    update(0);
    if (size(copy) <= MAX_FRAME_BYTES) {
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        update(mid);
        if (size(copy) <= MAX_FRAME_BYTES) low = mid;
        else high = mid - 1;
      }
      update(low);
      return copy;
    }
  }
  // Huge metadata/collections cannot safely be silently shortened. Preserve a
  // bounded, explicit failure instead; never resend an undeliverable envelope.
  const failure = { type: 'response', requestId: message.requestId ?? null, ok: false, error: { code: 'output_frame_too_large' } };
  if (size(failure) > MAX_FRAME_BYTES) failure.requestId = null;
  return failure;
}

export function boundCompletedOutcome(outcome, { operationId, requestId }) {
  // replay:false is one byte larger than replay:true. Also budget terminal
  // evidence, so journal, terminal and immediate response agree.
  const response = boundOutputFrame({ type: 'response', requestId, ok: true, result: { operationId, replay: false, outcome } });
  if (!response.ok) return { ok: false, error: 'output_frame_too_large', truncated: true, incomplete: true };
  const terminal = boundOutputFrame({ type: 'process.terminal', operationId, seq: Number.MAX_SAFE_INTEGER, evidence: response.result.outcome });
  return terminal.evidence ?? { ok: false, error: 'output_frame_too_large', truncated: true, incomplete: true };
}
