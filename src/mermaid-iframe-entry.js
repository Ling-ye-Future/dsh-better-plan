import mermaid from 'mermaid';

let currentTheme;
let renderQueue = Promise.resolve();

function ensureTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'default';
  if (next === currentTheme) return;
  currentTheme = next;
  mermaid.initialize({
    startOnLoad: false,
    theme: next,
    securityLevel: 'strict',
    htmlLabels: false,
  });
}

async function handleRender(data) {
  const source = typeof data.code === 'string' ? data.code : '';
  const targetId = 'dbp-mmd-' + data.id;
  try {
    ensureTheme(data.theme);
    const result = await mermaid.render(targetId, source);
    window.parent.postMessage({ type: 'mermaid-result', id: data.id, svg: result?.svg ?? '' }, '*');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    window.parent.postMessage({ type: 'mermaid-error', id: data.id, message }, '*');
  } finally {
    document.getElementById(targetId)?.remove();
    document.getElementById('d' + targetId)?.remove();
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== 'mermaid-render' || typeof data.id !== 'number') return;
  // Serialize renders because mermaid.initialize mutates global configuration.
  renderQueue = renderQueue.then(() => handleRender(data), () => handleRender(data));
});

ensureTheme('default');
window.parent.postMessage({ type: 'mermaid-frame-ready' }, '*');
