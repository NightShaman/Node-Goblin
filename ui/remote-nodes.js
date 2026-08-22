(() => {
  'use strict';

  const API_ROOT = '/api/mods/remote-nodes';
  const surface = document.documentElement.dataset.surface;
  const list = document.querySelector('#node-list');
  const feedback = document.querySelector('#feedback');
  const pending = new Map();
  const checking = new Set();
  let nodes = [];
  let editingId = null;
  let requestSequence = 0;

  function request(path, options = {}) {
    const id = `remote-nodes-${Date.now()}-${++requestSequence}`;
    const method = options.method || 'GET';

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error('Burrow did not respond. Please try again.'));
      }, 20000);

      pending.set(id, { resolve, reject, timeout });
      window.parent.postMessage(
        {
          type: 'burrow.mod.request',
          id,
          method,
          path: `${API_ROOT}${path}`,
          ...(Object.prototype.hasOwnProperty.call(options, 'body') ? { body: options.body } : {}),
        },
        '*',
      );
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.type !== 'burrow.mod.response') return;

    const entry = pending.get(message.id);
    if (!entry) return;
    window.clearTimeout(entry.timeout);
    pending.delete(message.id);

    if (message.ok) {
      entry.resolve(message.body);
      return;
    }

    const body = message.body;
    const detail = body && typeof body === 'object'
      ? body.error || body.details || body.message
      : typeof body === 'string' ? body : null;
    entry.reject(new Error(detail || `Request failed (${message.status || 'unknown status'}).`));
  });

  function setFeedback(message = '', isError = false) {
    feedback.textContent = message;
    feedback.classList.toggle('feedback-error', Boolean(message) && isError);
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(label, className, handler) {
    const element = el('button', `button ${className}`, label);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }

  function formatDate(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function normalizedStatus(node) {
    if (!node.enabled) return 'disabled';
    return ['online', 'offline', 'unknown'].includes(node.status) ? node.status : 'unknown';
  }

  function nodeCard(node) {
    const card = el('article', 'node-card');
    const heading = el('div', 'node-heading');
    const identity = el('div');
    identity.append(el('h2', 'node-name', node.name || 'Unnamed node'));
    identity.append(el('p', 'node-url', node.baseUrl || 'No URL configured'));

    const status = normalizedStatus(node);
    heading.append(identity, el('span', `status status-${status}`, status));
    card.append(heading);

    const meta = el('ul', 'meta-list');
    const items = [
      `Version: ${node.version || 'Unknown'}`,
      `Checked: ${formatDate(node.lastCheckedAt)}`,
      `Last seen: ${formatDate(node.lastSeenAt)}`,
    ];
    if (surface === 'settings') {
      items.push(node.credentialConfigured ? 'Credential configured' : 'No credential');
    }
    for (const item of items) meta.append(el('li', '', item));
    card.append(meta);

    if (node.error) card.append(el('p', 'node-error', node.error));

    const actions = el('div', 'node-actions');
    if (surface === 'control') {
      const check = button(checking.has(node.id) ? 'Checking…' : 'Check', 'button-secondary', () => checkNode(node.id));
      check.disabled = checking.has(node.id) || !node.enabled;
      actions.append(check);
    } else {
      actions.append(
        button('Edit', 'button-secondary', () => openEditor(node)),
        button('Delete', 'button-danger', () => deleteNode(node)),
      );
    }
    card.append(actions);
    return card;
  }

  function render() {
    list.replaceChildren();
    list.setAttribute('aria-busy', 'false');
    if (!nodes.length) {
      list.append(el('div', 'empty-state', surface === 'control'
        ? 'No remote nodes are configured.'
        : 'No remote nodes yet. Add one to get started.'));
      return;
    }
    for (const node of nodes) list.append(nodeCard(node));
  }

  async function loadNodes() {
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(el('div', 'loading-row', 'Loading remote nodes…'));
    setFeedback();
    try {
      const response = await request('/nodes');
      nodes = Array.isArray(response && response.nodes) ? response.nodes : [];
      render();
    } catch (error) {
      nodes = [];
      render();
      setFeedback(error.message, true);
    }
  }

  async function checkNode(id) {
    checking.add(id);
    render();
    setFeedback();
    try {
      const response = await request(`/nodes/${encodeURIComponent(id)}/check`, { method: 'POST' });
      if (response && response.node) {
        nodes = nodes.map((node) => node.id === id ? response.node : node);
        setFeedback(`${response.node.name || 'Node'} checked.`);
      }
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      checking.delete(id);
      render();
    }
  }

  const dialog = document.querySelector('#node-dialog');
  const form = document.querySelector('#node-form');
  const formError = document.querySelector('#form-error');
  const saveButton = document.querySelector('#save-node');

  function clearValidation() {
    for (const input of form.querySelectorAll('[aria-invalid="true"]')) input.removeAttribute('aria-invalid');
    for (const error of form.querySelectorAll('.field-error')) error.textContent = '';
    formError.hidden = true;
    formError.textContent = '';
  }

  function fieldError(name, message) {
    const input = form.elements.namedItem(name);
    const output = form.querySelector(`[data-error-for="${name}"]`);
    input.setAttribute('aria-invalid', 'true');
    output.textContent = message;
  }

  function validHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function openEditor(node = null) {
    editingId = node ? node.id : null;
    clearValidation();
    form.reset();
    document.querySelector('#dialog-title').textContent = node ? 'Edit node' : 'Add node';
    form.elements.name.value = node ? node.name || '' : '';
    form.elements.baseUrl.value = node ? node.baseUrl || '' : '';
    form.elements.enabled.checked = node ? Boolean(node.enabled) : true;
    form.elements.credential.value = '';
    form.elements.clearCredential.checked = false;
    document.querySelector('#clear-credential-field').hidden = !node || !node.credentialConfigured;
    dialog.showModal();
    form.elements.name.focus();
  }

  function closeEditor() {
    if (!saveButton.disabled) dialog.close();
  }

  async function saveNode(event) {
    event.preventDefault();
    clearValidation();

    const name = form.elements.name.value.trim();
    const baseUrl = form.elements.baseUrl.value.trim();
    let valid = true;
    if (!name) {
      fieldError('name', 'Enter a name.');
      valid = false;
    }
    if (!validHttpUrl(baseUrl)) {
      fieldError('baseUrl', 'Enter a valid http:// or https:// URL.');
      valid = false;
    }
    if (!valid) return;

    const body = {
      name,
      baseUrl,
      enabled: form.elements.enabled.checked,
    };
    const credential = form.elements.credential.value;
    if (form.elements.clearCredential.checked) body.credential = '';
    else if (credential) body.credential = credential;

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const path = editingId ? `/nodes/${encodeURIComponent(editingId)}` : '/nodes';
      const response = await request(path, {
        method: editingId ? 'PUT' : 'POST',
        body,
      });
      if (response && response.node) {
        const exists = nodes.some((node) => node.id === response.node.id);
        nodes = exists
          ? nodes.map((node) => node.id === response.node.id ? response.node : node)
          : [...nodes, response.node];
      } else {
        await loadNodes();
      }
      dialog.close();
      render();
      setFeedback(`${name} saved.`);
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save node';
    }
  }

  async function deleteNode(node) {
    if (!window.confirm(`Delete ${node.name || 'this remote node'}?`)) return;
    setFeedback();
    try {
      await request(`/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      nodes = nodes.filter((candidate) => candidate.id !== node.id);
      render();
      setFeedback(`${node.name || 'Node'} deleted.`);
    } catch (error) {
      setFeedback(error.message, true);
    }
  }

  if (surface === 'control') {
    document.querySelector('#refresh-nodes').addEventListener('click', loadNodes);
  } else if (surface === 'settings') {
    document.querySelector('#add-node').addEventListener('click', () => openEditor());
    document.querySelector('#close-dialog').addEventListener('click', closeEditor);
    document.querySelector('#cancel-dialog').addEventListener('click', closeEditor);
    form.addEventListener('submit', saveNode);
    dialog.addEventListener('cancel', (event) => {
      if (saveButton.disabled) event.preventDefault();
    });
  }

  loadNodes();
})();
