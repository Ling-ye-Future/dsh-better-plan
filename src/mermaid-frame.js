const FRAME_WIDTH = 1200;
const FRAME_HEIGHT = 900;
const FRAME_READY_TIMEOUT_MS = 10_000;
const FRAME_RENDER_TIMEOUT_MS = 30_000;
const MAX_DIAGRAM_SOURCE_LENGTH = 500_000;

export class MermaidDiagramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MermaidDiagramError';
  }
}

export class MermaidFrameError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MermaidFrameError';
  }
}

const pending = new Map();
let requestSeq = 0;
let frameEpoch = 0;
let frame = null;
let frameReady = null;
let frameObjectUrl = null;
let messageListenerInstalled = false;
let testRenderer = null;

export function setMermaidFrameRendererForTests(renderer) {
  testRenderer = renderer;
}

export function resetMermaidFrameForTests() {
  testRenderer = null;
  disposeFrame();
}

export function acceptFrameMessage(event, expectedWindow) {
  if (expectedWindow === null || event?.source !== expectedWindow) return null;
  if (event.origin !== 'null' && event.origin !== '') return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  if (data.type !== 'mermaid-result' && data.type !== 'mermaid-error') return null;
  if (typeof data.id !== 'number' || !Number.isInteger(data.id) || data.id <= 0) return null;
  if (data.type === 'mermaid-result') {
    return typeof data.svg === 'string' ? { kind: 'result', id: data.id, svg: data.svg } : null;
  }
  return typeof data.message === 'string'
    ? { kind: 'error', id: data.id, message: data.message }
    : null;
}

function installMessageListener() {
  if (messageListenerInstalled || typeof window === 'undefined') return;
  messageListenerInstalled = true;
  window.addEventListener('message', (event) => {
    const message = acceptFrameMessage(event, frame?.contentWindow ?? null);
    if (!message) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    window.clearTimeout(entry.timer);
    if (message.kind === 'result') entry.resolve(message.svg);
    else entry.reject(new MermaidDiagramError(message.message));
  });
}

function failPending(error) {
  for (const [id, entry] of pending) {
    pending.delete(id);
    if (typeof window !== 'undefined') window.clearTimeout(entry.timer);
    entry.reject(error);
  }
}

function disposeFrame(expectedEpoch) {
  if (expectedEpoch !== undefined && expectedEpoch !== frameEpoch) return;
  if (frame === null && frameReady === null && frameObjectUrl === null && pending.size === 0) return;
  frameEpoch += 1;
  failPending(new MermaidFrameError('mermaid frame was reset'));
  frameReady = null;
  if (frame !== null) {
    frame.remove();
    frame = null;
  }
  if (frameObjectUrl !== null) {
    URL.revokeObjectURL(frameObjectUrl);
    frameObjectUrl = null;
  }
}

function buildFrameHtml() {
  if (typeof __MERMAID_FRAME_HTML__ === 'string' && __MERMAID_FRAME_HTML__) {
    return __MERMAID_FRAME_HTML__;
  }
  throw new MermaidFrameError('mermaid frame bundle is unavailable');
}

function ensureFrame() {
  if (frameReady !== null) return frameReady;
  if (
    typeof document === 'undefined'
    || !document.body
    || typeof Blob === 'undefined'
    || typeof URL?.createObjectURL !== 'function'
  ) {
    return Promise.reject(new MermaidFrameError('mermaid frame requires a browser DOM'));
  }
  installMessageListener();
  const epoch = frameEpoch;
  let html;
  try {
    html = buildFrameHtml();
  } catch (err) {
    if (err instanceof MermaidFrameError && err.frameEpoch === undefined) err.frameEpoch = epoch;
    return Promise.reject(err);
  }
  frameReady = new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = `position:fixed;left:-12000px;top:0;width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;border:0;visibility:hidden;pointer-events:none`;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onReady);
      window.clearTimeout(timer);
      if (error !== undefined) {
        if (error instanceof MermaidFrameError && error.frameEpoch === undefined) {
          error.frameEpoch = epoch;
        }
        disposeFrame(epoch);
        reject(error);
        return;
      }
      if (frameObjectUrl !== null && epoch === frameEpoch) {
        URL.revokeObjectURL(frameObjectUrl);
        frameObjectUrl = null;
      }
      resolve();
    };
    const onReady = (event) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== 'null' && event.origin !== '') return;
      const data = event.data;
      if (data && typeof data === 'object' && data.type === 'mermaid-frame-ready') settle();
    };
    const timer = window.setTimeout(() => {
      settle(new MermaidFrameError('mermaid frame did not become ready'));
    }, FRAME_READY_TIMEOUT_MS);
    window.addEventListener('message', onReady);
    frameObjectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    iframe.src = frameObjectUrl;
    document.body.appendChild(iframe);
    frame = iframe;
  });
  return frameReady;
}

async function renderInFrame(code, theme) {
  await ensureFrame();
  const epoch = frameEpoch;
  const target = frame?.contentWindow;
  if (!target) {
    const err = new MermaidFrameError('mermaid frame disappeared');
    err.frameEpoch = epoch;
    throw err;
  }
  const id = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      const err = new MermaidFrameError('mermaid frame render timed out');
      err.frameEpoch = epoch;
      reject(err);
    }, FRAME_RENDER_TIMEOUT_MS);
    pending.set(id, {
      resolve,
      reject: (err) => {
        if (err instanceof MermaidFrameError && err.frameEpoch === undefined) {
          err.frameEpoch = epoch;
        }
        reject(err);
      },
      timer,
    });
    target.postMessage({ type: 'mermaid-render', id, code, theme }, '*');
  });
}

export async function renderMermaidDiagram(code, theme) {
  if (testRenderer !== null) return testRenderer(code, theme);
  if (typeof code !== 'string' || code.length > MAX_DIAGRAM_SOURCE_LENGTH) {
    throw new MermaidDiagramError(`diagram source is invalid or too large (${String(code?.length ?? 0)} chars)`);
  }
  try {
    return await renderInFrame(code, theme);
  } catch (firstError) {
    if (firstError instanceof MermaidDiagramError) throw firstError;
    disposeFrame(firstError?.frameEpoch);
    try {
      return await renderInFrame(code, theme);
    } catch (secondError) {
      if (secondError instanceof MermaidDiagramError) throw secondError;
      disposeFrame(secondError?.frameEpoch);
      throw new MermaidFrameError(
        `mermaid frame unavailable: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
        { cause: secondError },
      );
    }
  }
}
