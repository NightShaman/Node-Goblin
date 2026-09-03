export const settingsSections = Object.freeze([
  { id: 'controller', label: 'Controller & TLS' },
  { id: 'pairings', label: 'Pending pairings' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'assignments', label: 'Agent assignments' },
  { id: 'operations', label: 'Operation activity' },
]);

function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attributes || {})) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  return node;
}

function section(title, description) {
  const root = element('section', { className: 'setting-section' });
  root.append(element('h2', { text: title }));
  if (description) root.append(element('p', { className: 'settings-description', text: description }));
  return root;
}

function field(label, control) {
  const root = element('label', { className: 'field' });
  root.append(element('span', { text: label }), control);
  return root;
}

function button(label, className, action) {
  const control = element('button', { className, text: label, attributes: { type: 'button' } });
  control.addEventListener('click', action);
  return control;
}

function setBusy(controls, busy) {
  for (const control of controls) control.disabled = busy;
}

function errorMessage(error, fallback) {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}

function mountPlaceholder(context) {
  const copy = {
    pairings: ['Pending Node Goblin pairings', 'Review pairing requests before allowing a node to execute operations.'],
    gateways: ['Configured gateways', 'Inspect configured gateway trust and live connection health.'],
    assignments: ['Agent execution environments', 'Choose where each agent executes future turns.'],
    operations: ['Gateway operation activity', 'Inspect bounded, UI-safe execution provenance.'],
  }[context.section];
  if (!copy) throw new Error(`Unsupported Remote Nodes settings section: ${context.section}`);
  const root = section(copy[0], copy[1]);
  root.append(element('p', { className: 'settings-empty', text: 'This Remote Nodes settings section is being migrated to the Burrow mod runtime contract.' }));
  context.primary.replaceChildren(root);
  context.overflow?.replaceChildren();
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function mountPairings(context) {
  let disposed = false;
  let busy = false;
  const root = section('Pending Node Goblin pairings', 'Review these requests before a new node can execute operations. Compare the exact code with the node, then intentionally approve or reject it. Public-key and transport internals stay hidden.');
  const list = element('div', { className: 'provider-list' });
  const feedback = element('p', { attributes: { role: 'status', 'aria-live': 'polite' } });
  root.append(list, feedback);
  context.primary.replaceChildren(root);
  context.overflow?.replaceChildren();

  function render(pairings) {
    list.replaceChildren();
    if (!pairings.length) {
      list.append(element('p', { className: 'settings-empty', text: 'No pending pairing requests.' }));
      return;
    }
    for (const pairing of pairings.slice(0, 50)) {
      const id = pairing.gatewayId || pairing.nodeId || pairing.id || 'unknown-node';
      const code = pairing.pairingCode || pairing.code || 'Code unavailable';
      const metadata = pairing.metadata || {};
      const card = element('article', { className: 'provider-card' });
      const identity = element('div', { className: 'remote-pairing-identity' });
      identity.append(
        element('strong', { text: metadata.name || id }),
        element('small', { text: `Node Goblin · Gateway ID ${id}${pairing.controllerId ? ` · Controller ${pairing.controllerId}` : ''}` }),
      );
      if (metadata.version || metadata.protocolVersion) identity.append(element('small', { text: `${metadata.version ? `Daemon ${metadata.version}` : ''}${metadata.version && metadata.protocolVersion ? ' · ' : ''}${metadata.protocolVersion ? `Protocol ${metadata.protocolVersion}` : ''}` }));
      identity.append(element('small', { text: `Requested ${formatTime(pairing.requestedAt)}${pairing.expiresAt ? ` · Expires ${formatTime(pairing.expiresAt)}` : ''}` }));
      const codeNode = element('div', { className: 'remote-pairing-code', text: code, attributes: { 'aria-label': `Pairing code ${code}` } });
      const actions = element('div', { className: 'card-actions' });
      const reject = button('Reject', 'danger', () => act(pairing, 'reject'));
      const approve = button('Approve & enable execution', 'primary', () => act(pairing, 'approve'));
      approve.disabled = !pairing.gatewayId && !pairing.nodeId;
      actions.append(reject, approve);
      card.append(identity, codeNode, actions);
      list.append(card);
    }
  }

  async function load() {
    try {
      const result = await context.api('/pairings?limit=50');
      if (!disposed) render(Array.isArray(result?.pairings) ? result.pairings : []);
    } catch (error) {
      if (!disposed) {
        feedback.className = 'settings-request-error';
        feedback.textContent = errorMessage(error, 'Could not load pending pairings');
      }
    }
  }

  async function act(pairing, action) {
    if (busy) return;
    const id = pairing.gatewayId || pairing.nodeId;
    if (!id) {
      feedback.className = 'settings-request-error';
      feedback.textContent = 'This pairing has no usable gateway identity.';
      return;
    }
    const warning = action === 'approve'
      ? `Approve ${id}? This enables the node to execute operations on its host.`
      : `Reject pairing request from ${id}?`;
    if (!window.confirm(`${action === 'approve' ? 'Approve' : 'Reject'} this pending Node Goblin pairing?\n\n${warning}`)) return;
    busy = true;
    for (const control of list.querySelectorAll('button')) control.disabled = true;
    feedback.className = '';
    feedback.textContent = '';
    try {
      await context.api(`/pairings/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
      feedback.textContent = action === 'approve' ? 'Node Goblin approved; execution is now enabled.' : 'Pairing request rejected.';
      await load();
    } catch (error) {
      feedback.className = 'settings-request-error';
      feedback.textContent = errorMessage(error, 'Pairing request failed');
    } finally {
      busy = false;
    }
  }

  void load();
  const timer = window.setInterval(load, 10000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    context.primary.replaceChildren();
    context.overflow?.replaceChildren();
  };
}

function gatewayState(item, connection) {
  const connected = Boolean(connection?.connected);
  const explicitlyRevoked = Boolean(item.revoked) || String(item.status || '').toLowerCase() === 'revoked';
  const configuredApproved = Boolean(item.approved ?? item.trusted);
  return {
    connected,
    revoked: explicitlyRevoked && !connected,
    approved: configuredApproved || connected,
    label: explicitlyRevoked && !connected
      ? 'Revoked'
      : configuredApproved
        ? 'Approved / trusted'
        : connected
          ? 'Authenticated / approved'
          : 'Approval status unavailable',
  };
}

function mountGateways(context) {
  let disposed = false;
  let busy = false;
  let trust = [];
  let connections = [];
  let selectedId = '';

  const root = section('Configured gateways', 'Choose a gateway to inspect its trust, health, and actions. Disconnected gateways remain visible.');
  const selector = element('div', { className: 'mcp-server-selector' });
  const feedback = element('p', { attributes: { role: 'status', 'aria-live': 'polite' } });
  const enrollment = element('div', { className: 'remote-gateway-enroll' });
  enrollment.append(element('strong', { text: 'Enroll or rotate gateway' }));
  const gatewayId = element('input', { attributes: { placeholder: 'host-123' } });
  const controllerId = element('input');
  controllerId.value = 'controller';
  const secret = element('input', { attributes: { type: 'password', placeholder: 'One-time secret input', autocomplete: 'new-password' } });
  const pair = element('div', { className: 'field-pair' });
  pair.append(field('Gateway ID', gatewayId), field('Controller ID', controllerId));
  const actions = element('div', { className: 'setting-actions' });
  const enroll = button('Enroll or rotate gateway', 'primary', saveGateway);
  actions.append(enroll);
  enrollment.append(pair, field('Enrollment / rotation secret', secret), actions);
  root.append(selector, feedback, enrollment);
  context.primary.replaceChildren(root);

  function render() {
    if (disposed) return;
    selector.replaceChildren();
    if (!trust.length) {
      selector.append(element('p', { className: 'settings-empty', text: 'No gateways enrolled yet.' }));
      selectedId = '';
    } else {
      if (!trust.some((item) => item.gatewayId === selectedId)) selectedId = trust[0].gatewayId;
      for (const item of trust) {
        const connection = connections.find((candidate) => candidate.gatewayId === item.gatewayId);
        const state = gatewayState(item, connection);
        const control = button('', selectedId === item.gatewayId ? 'active' : '', () => {
          selectedId = item.gatewayId;
          render();
        });
        control.setAttribute('aria-pressed', String(selectedId === item.gatewayId));
        control.append(
          element('strong', { text: item.gatewayId }),
          element('small', { text: `${state.label} · ${state.connected ? 'Connected' : 'Disconnected'}` }),
        );
        selector.append(control);
      }
    }
    renderDetail();
  }

  function renderDetail() {
    if (!context.overflow) return;
    const item = trust.find((candidate) => candidate.gatewayId === selectedId);
    if (!item) {
      context.overflow.replaceChildren(element('p', { className: 'settings-empty', text: 'Select a configured gateway.' }));
      return;
    }
    const connection = connections.find((candidate) => candidate.gatewayId === item.gatewayId);
    const state = gatewayState(item, connection);
    const detail = section(item.gatewayId);
    const card = element('article', { className: 'provider-card' });
    card.append(
      element('strong', { text: state.label }),
      element('small', { text: `${item.controllerId || 'controller'} · ${state.connected ? `Connected · ${connection?.status || 'authenticated'}` : 'Disconnected'}` }),
    );
    if (connection) {
      card.append(
        element('small', { text: `${connection.name || 'Gateway daemon'}${connection.version ? ` · v${connection.version}` : ''}${connection.protocolVersion ? ` · protocol ${connection.protocolVersion}` : ''}` }),
        element('small', { text: `Connected ${formatTime(connection.connectedAt)} · Last seen ${formatTime(connection.lastSeenAt)}` }),
        element('small', { text: `${connection.activeOperations?.length ?? 0} active operation${connection.activeOperations?.length === 1 ? '' : 's'}` }),
      );
    }
    const detailActions = element('div', { className: 'card-actions' });
    const revoke = button('Revoke gateway', 'danger', () => revokeGateway(item.gatewayId));
    revoke.disabled = busy || state.revoked;
    detailActions.append(revoke);
    card.append(detailActions);
    detail.append(card);
    context.overflow.replaceChildren(detail);
  }

  async function load() {
    try {
      const [trustResult, gatewayResult] = await Promise.all([
        context.api('/gateway-trust'),
        context.api('/gateways'),
      ]);
      if (disposed) return;
      trust = Array.isArray(trustResult?.gateways) ? trustResult.gateways : [];
      connections = Array.isArray(gatewayResult?.gateways) ? gatewayResult.gateways : [];
      feedback.className = '';
      feedback.textContent = '';
      render();
    } catch (error) {
      if (!disposed) {
        feedback.className = 'settings-request-error';
        feedback.textContent = errorMessage(error, 'Could not load configured gateways');
      }
    }
  }

  async function saveGateway() {
    const id = gatewayId.value.trim();
    if (!id || !secret.value) {
      feedback.className = 'settings-request-error';
      feedback.textContent = 'Gateway ID and enrollment secret are required.';
      return;
    }
    await mutate(`/gateway-trust/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: controllerId.value.trim() || 'controller', secret: secret.value }),
    }, 'Gateway enrolled or rotated.', () => { secret.value = ''; selectedId = id; });
  }

  async function revokeGateway(id) {
    if (!window.confirm(`Revoke ${id}? Existing connections remain until restart.`)) return;
    await mutate(`/gateway-trust/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Gateway revoked.');
  }

  async function mutate(path, init, success, afterSuccess) {
    if (busy) return;
    busy = true;
    setBusy([gatewayId, controllerId, secret, enroll, ...selector.querySelectorAll('button')], true);
    feedback.className = '';
    feedback.textContent = '';
    try {
      const result = await context.api(path, init);
      afterSuccess?.();
      feedback.textContent = `${success}${result?.restartRequired ? ' Burrow restart required.' : ''}`;
      await load();
    } catch (error) {
      feedback.className = 'settings-request-error';
      feedback.textContent = errorMessage(error, 'Gateway request failed');
    } finally {
      busy = false;
      setBusy([gatewayId, controllerId, secret, enroll, ...selector.querySelectorAll('button')], false);
      renderDetail();
    }
  }

  void load();
  const timer = window.setInterval(load, 10000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    context.primary.replaceChildren();
    context.overflow?.replaceChildren();
  };
}

function mountAssignments(context) {
  let disposed = false;
  let busy = false;
  let selectedId = context.agents?.[0]?.id || '';
  let approvedGateways = [];

  const root = section('Agent execution environments', 'Choose an agent to configure its controller-owned environment for future turns.');
  const selector = element('div', { className: 'mcp-server-selector' });
  const feedback = element('p', { attributes: { role: 'status', 'aria-live': 'polite' } });
  root.append(selector, feedback);
  context.primary.replaceChildren(root);

  function render() {
    if (disposed) return;
    const agents = Array.isArray(context.agents) ? context.agents : [];
    selector.replaceChildren();
    if (!agents.length) {
      selectedId = '';
      selector.append(element('p', { className: 'settings-empty', text: 'No agents configured.' }));
    } else {
      if (!agents.some((agent) => agent.id === selectedId)) selectedId = agents[0].id;
      for (const agent of agents) {
        const control = button('', selectedId === agent.id ? 'active' : '', () => { selectedId = agent.id; render(); });
        control.setAttribute('aria-pressed', String(selectedId === agent.id));
        control.append(
          element('strong', { text: agent.name }),
          element('small', { text: agent.executionEnvironment?.kind === 'gateway' ? agent.executionEnvironment.hostId : 'Local controller' }),
        );
        selector.append(control);
      }
    }
    renderDetail();
  }

  function renderDetail() {
    if (!context.overflow) return;
    const agent = context.agents?.find((candidate) => candidate.id === selectedId);
    if (!agent) {
      context.overflow.replaceChildren(element('p', { className: 'settings-empty', text: 'Select an agent to configure its environment.' }));
      return;
    }
    const current = agent.executionEnvironment;
    const detail = section(`${agent.name} environment`, 'This controller-owned assignment applies to future turns. The model cannot switch hosts mid-turn.');
    const card = element('article', { className: 'provider-card' });
    const kind = element('select');
    kind.append(element('option', { text: 'Local controller', attributes: { value: 'local' } }), element('option', { text: 'Configured gateway', attributes: { value: 'gateway' } }));
    kind.value = current?.kind === 'gateway' ? 'gateway' : 'local';
    const gateway = element('select');
    gateway.append(element('option', { text: 'Choose gateway', attributes: { value: '' } }));
    for (const item of approvedGateways) gateway.append(element('option', { text: item.gatewayId, attributes: { value: item.gatewayId } }));
    gateway.value = current?.kind === 'gateway' ? current.hostId || '' : '';
    const gatewayField = field('Gateway', gateway);
    gatewayField.hidden = kind.value !== 'gateway';
    kind.addEventListener('change', () => { gatewayField.hidden = kind.value !== 'gateway'; });
    const workspace = element('input', { attributes: { placeholder: '/srv/burrow/agent' } });
    workspace.value = current?.workspaceRoot || '';
    const pair = element('div', { className: 'field-pair' });
    pair.append(field('Runs on', kind), gatewayField);
    const actions = element('div', { className: 'card-actions' });
    const save = button('Save assignment', 'secondary', async () => {
      if (busy) return;
      const workspaceRoot = workspace.value.trim();
      if (!workspaceRoot || (kind.value === 'gateway' && !gateway.value)) {
        feedback.className = 'settings-request-error';
        feedback.textContent = 'Execution environment needs an absolute workspace root and gateway.';
        return;
      }
      busy = true; setBusy([kind, gateway, workspace, save], true); feedback.className = ''; feedback.textContent = '';
      try {
        await context.saveAgentExecutionEnvironment(agent.id, { kind: kind.value, workspaceRoot, ...(kind.value === 'gateway' ? { hostId: gateway.value } : {}) });
        await context.refreshAgents();
        feedback.textContent = `${agent.name} assignment saved for future turns.`;
      } catch (error) {
        feedback.className = 'settings-request-error';
        feedback.textContent = errorMessage(error, 'Could not save execution environment');
      } finally { busy = false; setBusy([kind, gateway, workspace, save], false); }
    });
    actions.append(save);
    card.append(pair, field('Default workspace root', workspace), actions);
    detail.append(card);
    context.overflow.replaceChildren(detail);
  }

  async function load() {
    try {
      const result = await context.api('/gateway-trust');
      if (disposed) return;
      const trust = Array.isArray(result?.gateways) ? result.gateways : [];
      approvedGateways = trust.filter((item) => !item.revoked && (item.approved ?? item.trusted));
      render();
    } catch (error) {
      if (!disposed) { feedback.className = 'settings-request-error'; feedback.textContent = errorMessage(error, 'Could not load assignment gateways'); render(); }
    }
  }

  void load();
  return () => { disposed = true; context.primary.replaceChildren(); context.overflow?.replaceChildren(); };
}

function formatDuration(value) {
  if (value === undefined || value === null) return '—';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function mountOperations(context) {
  let disposed = false;
  const root = section('Gateway operation activity', 'Newest-first, bounded controller activity. Prompts, request parameters, protected values, and command output are intentionally omitted.');
  const list = element('div', { className: 'provider-list' });
  const feedback = element('p', { attributes: { role: 'status', 'aria-live': 'polite' } });
  root.append(list, feedback);
  context.primary.replaceChildren(root);
  context.overflow?.replaceChildren();

  function render(operations) {
    list.replaceChildren();
    if (!operations.length) {
      list.append(element('p', { className: 'settings-empty', text: 'No gateway operations recorded.' }));
      return;
    }
    for (const operation of operations.slice(0, 50)) {
      const card = element('article', { className: 'provider-card' });
      const heading = element('div', { className: 'remote-operation-heading' });
      heading.append(
        element('strong', { text: operation.kind || 'operation' }),
        element('span', { className: `operation-state operation-${operation.state || 'unknown'}`, text: operation.state || 'unknown' }),
      );
      const identity = element('small');
      identity.append(
        document.createTextNode('Gateway '),
        element('b', { text: operation.gatewayId || 'unknown' }),
        document.createTextNode(' · Operation '),
        element('code', { text: operation.operationId || 'unknown' }),
      );
      card.append(
        heading,
        identity,
        element('small', { text: `Started ${formatTime(operation.startedAt)} · Accepted ${formatTime(operation.acceptedAt)} · Ended ${formatTime(operation.endedAt)} · Duration ${formatDuration(operation.durationMs)}` }),
        element('small', { text: operation.terminalOutcome ? `Outcome: ${operation.terminalOutcome}` : operation.reconnectRequired ? 'Reconnect required' : operation.replay ? 'Replayed from gateway journal' : 'Controller dispatch tracked' }),
      );
      list.append(card);
    }
  }

  async function load() {
    try {
      const result = await context.api('/operations?limit=50');
      if (!disposed) {
        feedback.className = '';
        feedback.textContent = '';
        render(Array.isArray(result?.operations) ? result.operations : []);
      }
    } catch (error) {
      if (!disposed) {
        feedback.className = 'settings-request-error';
        feedback.textContent = errorMessage(error, 'Could not load gateway operation activity');
      }
    }
  }

  void load();
  const timer = window.setInterval(load, 10000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    context.primary.replaceChildren();
    context.overflow?.replaceChildren();
  };
}

function mountController(context) {
  let disposed = false;
  let pending = null;
  let latestController = null;

  const controllerSection = section('Host gateway controller', 'The listener snapshots configuration and trust at activation. Changes take effect after a Burrow restart.');
  const enabled = element('input', { attributes: { type: 'checkbox' } });
  const enabledLabel = element('label', { className: 'agent-enabled' });
  enabledLabel.append(enabled, element('span', { text: 'Listen for gateways' }));
  const host = element('input');
  const port = element('input', { attributes: { type: 'number', min: '1', max: '65535' } });
  const firstPair = element('div', { className: 'field-pair' });
  firstPair.append(field('Enabled', enabledLabel), field('Bind host', host));
  const secondPair = element('div', { className: 'field-pair' });
  secondPair.append(field('Port', port), element('div'));
  const controllerActions = element('div', { className: 'setting-actions' });
  const controllerStatus = element('div', { attributes: { role: 'status' } });

  const tlsSection = section('Controller TLS', 'Secrets are sent once and never displayed after saving. Listener readiness is evaluated from the active process.');
  const tlsStatus = element('div', { attributes: { role: 'status' } });
  const tlsKey = element('textarea', { attributes: { rows: '3', placeholder: 'Paste PEM key to set or replace' } });
  const tlsCert = element('textarea', { attributes: { rows: '3', placeholder: 'Paste PEM certificate to set or replace' } });
  const tlsCa = element('textarea', { attributes: { rows: '2', placeholder: 'Optional trust chain' } });
  const tlsActions = element('div', { className: 'setting-actions' });
  const feedback = element('p', { attributes: { role: 'status', 'aria-live': 'polite' } });

  const saveControllerButton = button('Save controller', 'primary', async () => {
    const next = { enabled: enabled.checked, host: host.value.trim(), port: Number(port.value) };
    await request(saveControllerButton, '/controller', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }, 'Controller configuration saved.', () => { pending = next; renderController(latestController); });
  });
  controllerActions.append(saveControllerButton);

  const clearTlsButton = button('Clear TLS', 'secondary', async () => {
    if (!window.confirm('Clear controller TLS credentials?')) return;
    await request(clearTlsButton, '/controller/tls', { method: 'DELETE' }, 'TLS credentials cleared.');
  });
  const saveTlsButton = button('Save TLS', 'primary', async () => {
    if (!tlsKey.value.trim() || !tlsCert.value.trim()) {
      feedback.className = 'settings-request-error';
      feedback.textContent = 'TLS private key and certificate are required.';
      return;
    }
    await request(saveTlsButton, '/controller/tls', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: tlsKey.value, cert: tlsCert.value, ...(tlsCa.value ? { ca: tlsCa.value } : {}) }),
    }, 'TLS credentials saved.', () => { tlsKey.value = ''; tlsCert.value = ''; tlsCa.value = ''; });
  });
  tlsActions.append(clearTlsButton, saveTlsButton);
  const allControls = [enabled, host, port, saveControllerButton, tlsKey, tlsCert, tlsCa, clearTlsButton, saveTlsButton];

  controllerSection.append(firstPair, secondPair, controllerActions, controllerStatus);
  tlsSection.append(tlsStatus, field('Private key', tlsKey), field('Certificate', tlsCert), field('CA certificate (optional)', tlsCa), tlsActions);
  context.primary.replaceChildren(controllerSection, tlsSection, feedback);
  context.overflow?.replaceChildren();

  function renderController(controller) {
    if (!controller || disposed) return;
    latestController = controller;
    const caughtUp = pending && pending.enabled === controller.enabled && pending.host === controller.host && pending.port === controller.port;
    if (caughtUp) pending = null;
    const displayed = pending || controller;
    enabled.checked = Boolean(displayed.enabled);
    host.value = displayed.host || '';
    port.value = String(displayed.port ?? '');
    controllerStatus.className = `mcp-diagnostic${controller.running ? ' ok' : controller.error ? ' error' : ''}`;
    controllerStatus.replaceChildren(
      element('strong', { text: controller.running ? 'Listening' : controller.enabled ? 'Not listening' : 'Disabled' }),
      element('span', { text: `Active listener: ${controller.host}:${controller.port}${controller.error ? ` · ${controller.error}` : ''}` }),
    );
    if (pending) controllerStatus.append(element('span', { className: 'remote-pending-config', text: `Saved configuration: ${pending.host}:${pending.port} · ${pending.enabled ? 'enabled' : 'disabled'} · restart required to activate` }));
    const tls = controller.tls;
    tlsStatus.hidden = !tls;
    if (tls) {
      tlsStatus.className = `mcp-diagnostic${tls.ready ? ' ok' : tls.configured ? ' warning' : ''}`;
      tlsStatus.replaceChildren(
        element('strong', { text: tls.ready ? 'TLS ready' : tls.configured ? 'TLS configured; restart required' : 'TLS not configured' }),
        element('span', { text: `Key ${tls.keyConfigured ? 'configured' : 'missing'} · certificate ${tls.certConfigured ? 'configured' : 'missing'} · CA ${tls.caConfigured ? 'configured' : 'not configured'}` }),
      );
    }
  }

  async function load() {
    try {
      const result = await context.api('/controller');
      renderController(result.controller);
    } catch (error) {
      if (!disposed) {
        feedback.className = 'settings-request-error';
        feedback.textContent = errorMessage(error, 'Could not load controller status');
      }
    }
  }

  async function request(trigger, path, init, success, afterSuccess) {
    feedback.className = '';
    feedback.textContent = '';
    setBusy(allControls, true);
    trigger.textContent = 'Saving…';
    try {
      const result = await context.api(path, init);
      afterSuccess?.();
      feedback.textContent = `${success}${result?.restartRequired ? ' Burrow restart required.' : ''}`;
      await load();
    } catch (error) {
      feedback.className = 'settings-request-error';
      feedback.textContent = errorMessage(error, 'Request failed');
    } finally {
      trigger.textContent = trigger === clearTlsButton ? 'Clear TLS' : trigger === saveTlsButton ? 'Save TLS' : 'Save controller';
      setBusy(allControls, false);
    }
  }

  void load();
  const timer = window.setInterval(load, 10000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    context.primary.replaceChildren();
    context.overflow?.replaceChildren();
  };
}

export function mountSettings(context) {
  if (context.section === 'controller') return mountController(context);
  if (context.section === 'pairings') return mountPairings(context);
  if (context.section === 'gateways') return mountGateways(context);
  if (context.section === 'assignments') return mountAssignments(context);
  if (context.section === 'operations') return mountOperations(context);
  mountPlaceholder(context);
  return {
    unmount() {
      context.primary.replaceChildren();
      context.overflow?.replaceChildren();
    },
  };
}
