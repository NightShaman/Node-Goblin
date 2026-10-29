const WINDOW_NOTICE = 'Volatile controller window, not complete history. Lost on restart; oldest-updated entries evicted at capacity; gateway entries cleared on revocation.';

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function button(text, action) {
  const node = el('button', text); node.type = 'button';
  node.addEventListener('click', action); return node;
}
function timestamp(value, timeZone) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Time unavailable' : parsed.toLocaleString(undefined, { timeZone });
}
function key(operation) { return JSON.stringify([operation.gatewayId, operation.operationId]); }
function validPage(data, previousCursor) {
  return data && Array.isArray(data.operations) && data.operations.every(operation => operation
    && typeof operation.gatewayId === 'string' && typeof operation.operationId === 'string')
    && typeof data.hasMore === 'boolean' && data.history && typeof data.history.available === 'boolean'
    && (!data.hasMore || (typeof data.nextCursor === 'string' && data.nextCursor.length > 0 && data.nextCursor !== previousCursor));
}

/** Core owns Archive navigation/date; this mod owns its read-only list/detail view. */
export function mountArchive({ root, api, date = '' }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let live = true, generation = 0, controller, busy = false;
  let operations = [], selected = null, cursor = null, hasMore = false, history = null;
  let gatewayId = '', query = '', failed = false;
  const view = el('section', null, 'ng-archive');
  const style = el('style', `
.ng-archive{color:var(--text);min-width:0;line-height:1.5}.ng-archive *{box-sizing:border-box}.ng-archive [hidden]{display:none!important}
.ng-archive h2,.ng-archive h3,.ng-archive p{margin:0 0 8px}.ng-archive h2{font-size:20px}.ng-archive h3{font-size:16px}
.ng-archive .ng-muted{color:var(--muted);font-size:12px}.ng-archive header{margin-bottom:16px}.ng-archive form{display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.ng-archive label{display:grid;gap:4px;font-size:12px;color:var(--muted);flex:1;min-width:140px}.ng-archive input,.ng-archive button{font:inherit;color:var(--text);background:var(--surface-input);border:1px solid var(--line);border-radius:6px;min-height:36px;padding:7px 10px}
.ng-archive input{width:100%;min-width:0}.ng-archive button{cursor:pointer}.ng-archive button:disabled{opacity:.55;cursor:not-allowed}.ng-archive button:hover:not(:disabled){background:var(--surface-hover);border-color:var(--accent-border)}
.ng-archive button:focus-visible,.ng-archive input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ng-archive .ng-split{display:grid;grid-template-columns:minmax(220px,1fr) minmax(240px,1fr);gap:20px;align-items:start}.ng-archive .ng-split>section{min-width:0}
.ng-archive ul{list-style:none;padding:0;margin:0}.ng-archive li+li{margin-top:6px}.ng-archive li button{width:100%;text-align:left;overflow-wrap:anywhere}.ng-archive li button[aria-pressed=true]{border-color:var(--accent-border);background:var(--accent-muted)}
.ng-archive li span{display:block}.ng-archive dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px;font-size:13px}.ng-archive dt{color:var(--muted)}.ng-archive dd{margin:0;overflow-wrap:anywhere}
.ng-archive footer{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}.ng-archive [role=alert]{color:var(--warn)}
@media(max-width:700px){.ng-archive .ng-split{grid-template-columns:minmax(0,1fr)}}
`);
  const head = el('header'), scope = el('p', '', 'ng-muted'), windowNotice = el('p', WINDOW_NOTICE, 'ng-muted');
  head.append(el('h2', 'Node Goblin operations'), scope, windowNotice);
  const form = el('form');
  const gatewayLabel = el('label', 'Gateway ID'), gatewayInput = el('input'); gatewayInput.type = 'text'; gatewayInput.maxLength = 128;
  gatewayLabel.append(gatewayInput);
  const queryLabel = el('label', 'Search metadata'), queryInput = el('input'); queryInput.type = 'search'; queryInput.maxLength = 200;
  queryLabel.append(queryInput);
  const apply = el('button', 'Apply filters'); apply.type = 'submit';
  const refresh = button('Refresh', () => { if (live) reset(); });
  form.append(gatewayLabel, queryLabel, apply, refresh);
  const status = el('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = button('Retry', () => { if (live) void load(); }); retry.hidden = true;
  const split = el('div', null, 'ng-split'), listSection = el('section'), details = el('section');
  details.setAttribute('aria-label', 'Operation details');
  const list = el('ul'); list.setAttribute('aria-label', 'Operations');
  const empty = el('p', '', 'ng-muted');
  listSection.append(el('h3', 'Operations'), empty, list); split.append(listSection, details);
  const footer = el('footer'), counts = el('span', '', 'ng-muted');
  const more = button('Load more', () => { if (live && hasMore) void load(); });
  footer.append(counts, more); view.append(style, head, form, status, retry, split, footer); root.replaceChildren(view);

  function renderDetails() {
    details.replaceChildren(el('h3', 'Operation details'));
    const operation = operations.find(item => key(item) === selected);
    if (!operation) { details.append(el('p', 'Select an operation to inspect its metadata.', 'ng-muted')); return; }
    const metadata = el('dl');
    const values = [
      ['Operation ID', operation.operationId], ['Gateway', operation.gatewayId], ['Kind', operation.kind],
      ['State', operation.state], ['Outcome', operation.terminalOutcome],
      ['Started', timestamp(operation.startedAt, timeZone)], ['Accepted', timestamp(operation.acceptedAt, timeZone)],
      ['Ended', timestamp(operation.endedAt, timeZone)],
      ['Duration', Number.isFinite(operation.durationMs) ? `${operation.durationMs} ms` : '—'],
      ['Replay', operation.replay === true ? 'Yes' : 'No'],
      ['Reconnect required', operation.reconnectRequired === true ? 'Yes' : 'No'],
    ];
    for (const [label, value] of values) metadata.append(el('dt', label), el('dd', value ?? '—'));
    details.append(metadata, el('p', 'Metadata only; commands, paths, output, and secrets are not included.', 'ng-muted'));
  }
  function render() {
    scope.textContent = date ? `Started on ${date} · ${timeZone}` : `All dates · ${timeZone}`;
    list.replaceChildren();
    for (const operation of operations) {
      const row = el('li'), select = button('', () => {
        if (!live || !operations.includes(operation)) return;
        selected = key(operation); render();
      });
      select.setAttribute('aria-pressed', String(selected === key(operation)));
      select.append(el('span', operation.operationId), el('span', `${operation.gatewayId} · ${operation.kind || '—'} · ${operation.terminalOutcome || operation.state || '—'}`, 'ng-muted'), el('span', timestamp(operation.startedAt, timeZone), 'ng-muted'));
      row.append(select); list.append(row);
    }
    empty.textContent = busy && !operations.length ? 'Loading operations…' : history?.available === false ? 'Controller activity is unavailable.' : failed && !operations.length ? 'Operations could not be loaded.' : !operations.length ? 'No retained operations match this view.' : '';
    counts.textContent = history ? `${operations.length} shown · ${history.matchedEntries ?? '—'} matched · ${history.retainedEntries ?? '—'}/${history.maxEntries ?? '—'} retained` : '';
    more.hidden = !hasMore; more.disabled = busy; refresh.disabled = busy;
    retry.hidden = !failed || busy;
    view.setAttribute('aria-busy', String(busy)); renderDetails();
  }
  async function load() {
    if (!live || busy) return;
    busy = true; failed = false; status.setAttribute('role', 'status'); status.textContent = 'Loading…'; render();
    const requestedGeneration = generation, requestedCursor = cursor;
    const signal = controller.signal;
    const params = new URLSearchParams({ timeZone, limit: '50', ...(date ? { date } : {}), ...(requestedCursor ? { cursor: requestedCursor } : {}), ...(gatewayId ? { gatewayId } : {}), ...(query ? { q: query } : {}) });
    try {
      const data = await api(`/operations/archive?${params}`, { method: 'GET', signal });
      if (!live || requestedGeneration !== generation) return;
      if (!validPage(data, requestedCursor)) throw new Error('Invalid operation archive response.');
      history = data.history;
      if (!history.available) { operations = []; selected = null; cursor = null; hasMore = false; }
      else {
        // The volatile window can change while paging. Never show duplicate identities.
        const merged = new Map(operations.map(operation => [key(operation), operation]));
        for (const operation of data.operations) merged.set(key(operation), operation);
        operations = [...merged.values()]; cursor = data.nextCursor || null; hasMore = data.hasMore;
      }
      status.textContent = history.available ? '' : 'Controller activity is unavailable; this is not evidence of no activity.';
    } catch (error) {
      if (!live || requestedGeneration !== generation) return;
      failed = true; status.setAttribute('role', 'alert');
      status.textContent = `Could not load operations. ${error?.message || 'Try again.'}`;
      // A lost session must not leave previously retrieved metadata visible.
      if ([401, 403].includes(error?.status || error?.statusCode)) { operations = []; selected = null; history = null; cursor = null; hasMore = false; }
    } finally {
      if (live && requestedGeneration === generation) { busy = false; render(); }
    }
  }
  function reset() {
    generation++; controller?.abort(); controller = new AbortController();
    busy = false; failed = false; operations = []; selected = null; cursor = null; hasMore = false; history = null;
    void load();
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!live) return;
    gatewayId = gatewayInput.value.trim(); query = queryInput.value.trim(); reset();
  });
  reset();
  return {
    update(context = {}) {
      if (!live || !Object.prototype.hasOwnProperty.call(context, 'date')) return;
      const nextDate = context.date || '';
      if (nextDate === date) return;
      date = nextDate; reset();
    },
    unmount() {
      if (!live) return;
      live = false; generation++; controller.abort(); operations = []; selected = null; root.replaceChildren();
    },
  };
}
