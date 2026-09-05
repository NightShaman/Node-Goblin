export const settingsSections = Object.freeze([
  { id: 'controller', label: 'Controller & TLS' },
  { id: 'pairings', label: 'Pending pairings' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'assignments', label: 'Agent assignments' },
  { id: 'operations', label: 'Operation activity' },
]);

// Declarative metadata is intentionally limited to the host-owned Settings contract.
// Live values and actions remain on the legacy adapter until the host data/action
// bindings are migrated in a later slice.
export const settingsContribution = Object.freeze({
  sections: Object.freeze([
    {
      id: 'controller',
      label: 'Controller & TLS',
      description: 'Configure the Host Gateway controller and its TLS listener.',
      layout: 'form',
      fields: Object.freeze([
        { id: 'enabled', label: 'Enabled', control: 'boolean', value: 'false' },
        { id: 'bind-host', label: 'Bind host', control: 'text', value: '127.0.0.1' },
        { id: 'bind-port', label: 'Bind port', control: 'number', value: '7443' },
      ]),
      actions: Object.freeze([
        { id: 'save-controller', label: 'Save controller', tone: 'primary', confirm: 'Save the Host Gateway controller configuration?' },
      ]),
    },
    {
      id: 'pairings',
      label: 'Pending pairings',
      description: 'Review pairing requests before allowing a Node Goblin to execute operations.',
      layout: 'list-detail',
      items: Object.freeze([]),
    },
    {
      id: 'gateways',
      label: 'Gateways',
      description: 'Inspect configured gateway trust and live connection health.',
      layout: 'list-detail',
      items: Object.freeze([]),
    },
    {
      id: 'assignments',
      label: 'Agent assignments',
      description: 'Choose where each agent executes future turns. Assignments are controller-owned and apply to future turns only.',
      layout: 'list-detail',
      items: Object.freeze([]),
    },
    {
      id: 'operations',
      label: 'Operation activity',
      description: 'Inspect bounded, UI-safe execution provenance without prompts, parameters, secrets, or raw output.',
      layout: 'activity',
      items: Object.freeze([]),
    },
  ]),
});

export async function createSettingsContribution(context) {
  const [controllerResult, pairingResult, trustResult, gatewayResult, operationResult] = await Promise.all([
    context.api('/controller'),
    context.api('/pairings?limit=50'),
    context.api('/gateway-trust'),
    context.api('/gateways'),
    context.api('/operations?limit=50'),
  ]);
  const pairings = Array.isArray(pairingResult?.pairings) ? pairingResult.pairings : [];
  const items = pairings.map((pairing) => {
    const gateway = pairing.gateway || {};
    const id = String(pairing.gatewayId || pairing.id || gateway.id || 'pending-node');
    const name = String(gateway.name || pairing.gatewayId || pairing.controllerId || id);
    const code = String(pairing.pairingCode || pairing.code || 'Unavailable');
    return {
      id,
      label: name,
      description: 'Pending Node Goblin pairing request.',
      meta: `Code: ${code}`,
      detail: `Requested ${pairing.requestedAt ? new Date(pairing.requestedAt).toLocaleString() : '—'} · Expires ${pairing.expiresAt ? new Date(pairing.expiresAt).toLocaleString() : '—'}`,
      actions: [
        { id: `approve-pairing:${id}`, label: 'Approve', tone: 'primary', confirm: 'Approve this Node Goblin? Approval enables host execution.' },
        { id: `reject-pairing:${id}`, label: 'Reject', tone: 'danger', confirm: 'Reject this Node Goblin pairing?' },
      ],
    };
  });
  const trusted = Array.isArray(trustResult?.gateways) ? trustResult.gateways : [];
  const live = Array.isArray(gatewayResult?.gateways) ? gatewayResult.gateways : [];
  const gatewayOptions = [{ value: '', label: 'Select a gateway' }, ...trusted
    .filter((item) => {
      const connection = live.find((candidate) => candidate.gatewayId === item.gatewayId);
      return !item.revoked || Boolean(connection?.connected);
    })
    .filter((item, index, entries) => entries.findIndex((candidate) => candidate.gatewayId === item.gatewayId) === index)
    .map((item) => ({ value: String(item.gatewayId), label: String(item.gatewayId) }))];
  const assignmentItems = (Array.isArray(context.agents) ? context.agents : []).map((agent) => {
    const current = agent.executionEnvironment || {};
    const kind = current.kind === 'remote' ? 'remote' : 'local';
    const targetId = kind === 'remote' && current.providerId === 'node-goblin' ? String(current.targetId || '') : '';
    return {
      id: String(agent.id),
      label: String(agent.name || agent.id),
      description: 'Controller-owned assignment for future turns. The model cannot switch hosts mid-turn.',
      meta: `${kind === 'remote' ? `Gateway: ${targetId || 'not selected'}` : 'Local controller'} · ${current.workspaceRoot || 'Workspace not set'}`,
      fields: [
        { id: `assignment-kind:${agent.id}`, label: 'Runs on', control: 'select', value: kind, options: [{ value: 'local', label: 'Local controller' }, { value: 'remote', label: 'Configured gateway' }] },
        { id: `assignment-gateway:${agent.id}`, label: 'Gateway', control: 'select', value: targetId, options: gatewayOptions, description: 'Required when using a gateway.' },
        { id: `assignment-workspace:${agent.id}`, label: 'Default workspace root', control: 'text', value: String(current.workspaceRoot || ''), description: 'Use an absolute workspace path.' },
      ],
      actions: [{ id: `save-assignment:${agent.id}`, label: 'Save assignment', tone: 'primary' }],
    };
  });
  const operations = (Array.isArray(operationResult?.operations) ? operationResult.operations : []).slice(0, 50).map((operation) => ({
    id: String(operation.operationId || operation.id || `${operation.gatewayId || 'gateway'}-${operation.startedAt || 'operation'}`),
    label: String(operation.kind || 'operation'),
    description: 'Bounded controller activity. Prompts, parameters, protected values, and raw output are omitted.',
    meta: `${String(operation.state || 'unknown')} · Gateway ${String(operation.gatewayId || 'unknown')} · Operation ${String(operation.operationId || operation.id || 'unknown')}`,
    detail: `${operation.terminalOutcome ? `Outcome: ${String(operation.terminalOutcome)}` : operation.reconnectRequired ? 'Reconnect required' : operation.replay ? 'Replayed from gateway journal' : 'Controller dispatch tracked'} · Started ${operation.startedAt ? new Date(operation.startedAt).toLocaleString() : '—'} · Ended ${operation.endedAt ? new Date(operation.endedAt).toLocaleString() : '—'} · Duration ${operation.durationMs == null ? '—' : `${operation.durationMs} ms`}`,
  }));
  const controller = controllerResult?.controller || {};
  const tls = controller.tls || {};
  const controllerSection = {
    ...settingsContribution.sections.find((section) => section.id === 'controller'),
    fields: [
      { id: 'enabled', label: 'Enabled', control: 'boolean', value: controller.enabled === true ? 'true' : 'false' },
      { id: 'bind-host', label: 'Bind host', control: 'text', value: String(controller.host || '127.0.0.1') },
      { id: 'bind-port', label: 'Bind port', control: 'number', value: String(controller.port || 7443) },
      { id: 'tls-key', label: 'TLS private key', control: 'password', description: `${tls.keyConfigured ? 'Configured' : 'Not configured'}; secret is never returned.` },
      { id: 'tls-cert', label: 'TLS certificate', control: 'password', description: `${tls.certConfigured ? 'Configured' : 'Not configured'}; secret is never returned.` },
      { id: 'tls-ca', label: 'TLS CA certificate (optional)', control: 'password', description: `${tls.caConfigured ? 'Configured' : 'Not configured'}; secret is never returned.` },
    ],
    description: `The active listener is ${controller.running ? 'running' : 'not running'} at ${controller.host || '—'}:${controller.port || '—'}${controller.error ? ` · ${controller.error}` : ''}. Changes require a Burrow restart when the listener reports it.`,
    actions: [
      { id: 'save-controller', label: 'Save controller', tone: 'primary', confirm: 'Save the Host Gateway controller configuration?' },
      { id: 'save-tls', label: 'Save TLS', tone: 'primary', confirm: 'Save these TLS credentials? They will not be shown again.' },
      { id: 'clear-tls', label: 'Clear TLS', tone: 'danger', confirm: 'Clear controller TLS credentials?' },
    ],
  };
  const gatewayItems = trusted.map((item) => {
    const connection = live.find((candidate) => candidate.gatewayId === item.gatewayId);
    const connected = Boolean(connection?.connected);
    const revoked = Boolean(item.revoked) && !connected;
    const approved = Boolean(item.approved || item.trusted || connected);
    return {
      id: String(item.gatewayId),
      label: String(item.gatewayId),
      description: approved ? 'Approved gateway.' : 'Approval status unavailable.',
      meta: `${revoked ? 'Revoked' : approved ? 'Approved' : 'Pending'} · ${connected ? 'Connected' : 'Disconnected'}`,
      detail: `${connection?.name || 'Gateway daemon'}${connection?.version ? ` · v${connection.version}` : ''}${connection?.protocolVersion ? ` · protocol ${connection.protocolVersion}` : ''} · Connected ${connection?.connectedAt || '—'} · Last seen ${connection?.lastSeenAt || '—'}`,
      actions: revoked ? [] : [{ id: `revoke-gateway:${item.gatewayId}`, label: 'Revoke gateway', tone: 'danger', confirm: 'Revoke this gateway? It will no longer be allowed to execute.' }],
    };
  });
  return {
    ...settingsContribution,
    sections: settingsContribution.sections.map((section) => section.id === 'controller' ? controllerSection : section.id === 'pairings' ? { ...section, items } : section.id === 'gateways' ? { ...section, fields: [
      { id: 'enroll-gateway-id', label: 'Gateway ID', control: 'text', description: 'Identity to enroll or rotate.' },
      { id: 'enroll-controller-id', label: 'Controller ID', control: 'text', value: 'controller' },
      { id: 'enroll-secret', label: 'Enrollment / rotation secret', control: 'password', description: 'One-time input; never displayed after submission.' },
    ], actions: [{ id: 'enroll-gateway', label: 'Enroll or rotate gateway', tone: 'primary' }], items: gatewayItems } : section.id === 'assignments' ? { ...section, items: assignmentItems } : section.id === 'operations' ? { ...section, items: operations } : section),
  };
}

export async function handleSettingsAction(actionId, values) {
  if (actionId.startsWith('revoke-gateway:')) {
    const gatewayId = actionId.slice('revoke-gateway:'.length);
    await fetch(`/api/mods/node-goblin/gateway-trust/${encodeURIComponent(gatewayId)}`, { method: 'DELETE' }).then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || `Gateway revoke failed (${response.status}).`);
    });
    return;
  }
  if (actionId.startsWith('approve-pairing:') || actionId.startsWith('reject-pairing:')) {
    const [operation, gatewayId] = actionId.split(':');
    await fetch(`/api/mods/node-goblin/pairings/${encodeURIComponent(gatewayId)}/${operation === 'approve-pairing' ? 'approve' : 'reject'}`, { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || `Pairing action failed (${response.status}).`);
    });
    return;
  }
  if (actionId.startsWith('save-assignment:')) {
    const agentId = actionId.slice('save-assignment:'.length);
    const kind = String(values[`assignment-kind:${agentId}`] || 'local');
    const workspaceRoot = String(values[`assignment-workspace:${agentId}`] || '').trim();
    const targetId = String(values[`assignment-gateway:${agentId}`] || '').trim();
    if (!workspaceRoot.startsWith('/') || (kind === 'remote' && !targetId)) throw new Error('Execution environment needs an absolute workspace root and gateway.');
    await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ executionEnvironment: { kind, workspaceRoot, ...(kind === 'remote' ? { providerId: 'node-goblin', targetId } : {}) } }) }).then(async (response) => { if (!response.ok) throw new Error((await response.text()) || `Assignment save failed (${response.status}).`); });
    return;
  }
  if (actionId === 'enroll-gateway') {
    const id = String(values['enroll-gateway-id'] || '').trim();
    const controllerId = String(values['enroll-controller-id'] || 'controller').trim() || 'controller';
    const secret = String(values['enroll-secret'] || '');
    if (!id || !secret) throw new Error('Gateway ID and enrollment secret are required.');
    await fetch(`/api/mods/node-goblin/gateway-trust/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId, secret }) }).then(async (response) => { if (!response.ok) throw new Error((await response.text()) || `Gateway enrollment failed (${response.status}).`); });
    return;
  }
  if (actionId === 'clear-tls') {
    await fetch('/api/mods/node-goblin/controller/tls', { method: 'DELETE' }).then(async (response) => { if (!response.ok) throw new Error((await response.text()) || `TLS clear failed (${response.status}).`); });
    return;
  }
  if (actionId === 'save-tls') {
    const key = String(values['tls-key'] || '').trim(); const cert = String(values['tls-cert'] || '').trim(); const ca = String(values['tls-ca'] || '').trim();
    if (!key || !cert) throw new Error('TLS private key and certificate are required.');
    await fetch('/api/mods/node-goblin/controller/tls', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, cert, ...(ca ? { ca } : {}) }) }).then(async (response) => { if (!response.ok) throw new Error((await response.text()) || `TLS save failed (${response.status}).`); });
    return;
  }
  if (actionId !== 'save-controller') throw new Error(`Unsupported Node Goblin settings action: ${actionId}`);
  const enabled = values.enabled === true;
  const host = String(values['bind-host'] || '127.0.0.1').trim();
  const port = Number(values['bind-port']);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid bind host and port are required.');
  await fetch('/api/mods/node-goblin/controller', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled, host, port }),
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()) || `Controller save failed (${response.status}).`);
  });
}
