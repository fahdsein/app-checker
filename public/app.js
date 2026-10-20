const elements = {
  refresh: document.querySelector('#refresh-button'),
  run: document.querySelector('#redis-run'),
  status: document.querySelector('#redis-status'),
  target: document.querySelector('#redis-target'),
  transport: document.querySelector('#redis-transport'),
  latency: document.querySelector('#redis-latency'),
  result: document.querySelector('#redis-result')
};

function setStatus(label, kind = 'neutral') {
  elements.status.textContent = label;
  elements.status.className = `status ${kind}`;
}

async function loadConfiguration() {
  elements.run.disabled = true;
  setStatus('Loading');
  try {
    const response = await fetch('/api/checks', { cache: 'no-store' });
    const body = await response.json();
    const redis = body.checks.find((check) => check.id === 'redis');
    elements.target.textContent = redis?.target || 'REDIS_HOST not set';
    elements.transport.textContent = redis?.tls ? 'TLS / TCP' : 'Private TCP';
    elements.run.disabled = !redis?.configured;
    setStatus(redis?.configured ? 'Ready' : 'Not configured', redis?.configured ? 'ready' : 'failed');
  } catch (error) {
    setStatus('Unavailable', 'failed');
    showResult({ ok: false, message: error.message || 'Could not load configuration.' });
  }
}

function showResult(result) {
  elements.result.hidden = false;
  elements.result.className = `result-panel ${result.ok ? 'success' : 'error'}`;
  const message = document.createElement('div');
  message.textContent = result.message;
  elements.result.replaceChildren(message);

  if (Array.isArray(result.steps)) {
    const list = document.createElement('ul');
    for (const step of result.steps) {
      const item = document.createElement('li');
      item.textContent = `${step.ok ? '✓' : '×'} ${step.name}`;
      list.append(item);
    }
    elements.result.append(list);
  }
}

async function runRedisCheck() {
  elements.run.disabled = true;
  elements.run.textContent = 'Checking…';
  setStatus('Running');
  elements.result.hidden = true;
  try {
    const response = await fetch('/api/check/redis', { method: 'POST' });
    const result = await response.json();
    showResult(result);
    elements.latency.textContent = Number.isFinite(result.latencyMs) ? `${result.latencyMs} ms` : '—';
    setStatus(result.ok ? 'Passed' : 'Failed', result.ok ? 'ready' : 'failed');
  } catch (error) {
    showResult({ ok: false, message: error.message || 'The check request failed.' });
    setStatus('Failed', 'failed');
  } finally {
    elements.run.disabled = false;
    elements.run.textContent = 'Run Redis check';
  }
}

elements.refresh.addEventListener('click', loadConfiguration);
elements.run.addEventListener('click', runRedisCheck);
loadConfiguration();
