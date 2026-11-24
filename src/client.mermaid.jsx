import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderMermaidDiagram } from './mermaid-frame.js';
import { sanitizeSvg } from './mermaid-sanitize.js';

function isDarkTheme() {
  return typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme') === true;
}

function summarizeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').slice(0, 4).join('\n');
}

function importSvgElement(svgMarkup) {
  if (typeof DOMParser === 'undefined' || !svgMarkup) return null;
  const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
  const sourceSvg = parsed.documentElement;
  if (!sourceSvg || sourceSvg.localName !== 'svg') return null;
  return document.importNode(sourceSvg, true);
}

function readNaturalSvgSize(node) {
  const viewBox = (node.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 && Number.isFinite(viewBox[3]) && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  const rawWidth = node.getAttribute('width') ?? '';
  const rawHeight = node.getAttribute('height') ?? '';
  if (!rawWidth.includes('%') && !rawHeight.includes('%')) {
    const width = Number.parseFloat(rawWidth);
    const height = Number.parseFloat(rawHeight);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  }
  return null;
}

function MermaidZoomModal({ svgMarkup, labels, onClose }) {
  const viewportRef = useRef(null);
  const closeButtonRef = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef({ active: false, moved: false, originX: 0, originY: 0, startX: 0, startY: 0 });
  const zoomRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const fitRef = useRef(1);

  const applyTransform = useCallback(() => {
    const node = svgRef.current;
    if (!node) return;
    const { scale, tx, ty } = zoomRef.current;
    node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }, []);

  const applyFit = useCallback(() => {
    const viewport = viewportRef.current;
    const node = svgRef.current;
    let scale = 1;
    if (viewport && node) {
      const box = viewport.getBoundingClientRect();
      const styles = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(viewport) : null;
      const padX = styles ? (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0) : 0;
      const padY = styles ? (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0) : 0;
      const availWidth = Math.max(1, box.width - padX);
      const availHeight = Math.max(1, box.height - padY);
      const prev = node.style.transform;
      node.style.transform = 'none';
      const rect = node.getBoundingClientRect();
      node.style.transform = prev;
      if (availWidth > 0 && availHeight > 0 && rect.width > 0 && rect.height > 0) {
        scale = Math.min(1, availWidth / rect.width, availHeight / rect.height);
      }
    }
    const clamped = Math.min(8, Math.max(0.2, scale));
    fitRef.current = clamped;
    zoomRef.current = { scale: clamped, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform]);

  const zoom = useCallback((factor, cx, cy) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const cur = zoomRef.current;
    const next = Math.min(8, Math.max(0.2, cur.scale * factor));
    const sx = rect.width / 2;
    const sy = rect.height / 2;
    const ratio = next / cur.scale;
    cur.tx = px - sx - (px - sx - cur.tx) * ratio;
    cur.ty = py - sy - (py - sy - cur.ty) * ratio;
    cur.scale = next;
    applyTransform();
  }, [applyTransform]);

  const reset = useCallback(() => {
    zoomRef.current = { scale: fitRef.current, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform]);

  useEffect(() => {
    const prevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      if (prevFocused && typeof prevFocused.focus === 'function') {
        prevFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const node = importSvgElement(svgMarkup);
    if (!viewport || !node) return undefined;
    const size = readNaturalSvgSize(node);
    node.removeAttribute('style');
    node.removeAttribute('width');
    node.removeAttribute('height');
    if (size) {
      node.style.width = `${size.width}px`;
      node.style.height = `${size.height}px`;
    }
    svgRef.current = node;
    viewport.replaceChildren(node);
    applyFit();
    return () => {
      node.remove();
      svgRef.current = null;
    };
  }, [svgMarkup, applyFit]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') zoom(1.2);
      else if (event.key === '-') zoom(1 / 1.2);
      else if (event.key === '0') reset();
    };
    const onMouseDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragRef.current = {
        active: true,
        moved: false,
        originX: event.clientX,
        originY: event.clientY,
        startX: event.clientX - zoomRef.current.tx,
        startY: event.clientY - zoomRef.current.ty,
      };
    };
    const onMouseMove = (event) => {
      if (!dragRef.current.active) return;
      if (Math.abs(event.clientX - dragRef.current.originX) > 3 || Math.abs(event.clientY - dragRef.current.originY) > 3) {
        dragRef.current.moved = true;
      }
      zoomRef.current.tx = event.clientX - dragRef.current.startX;
      zoomRef.current.ty = event.clientY - dragRef.current.startY;
      applyTransform();
    };
    const onMouseUp = () => { dragRef.current.active = false; };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKey);
    return () => {
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [zoom, reset, onClose, applyTransform]);

  const onBackdropClick = (event) => {
    if (dragRef.current.moved) {
      dragRef.current.moved = false;
      return;
    }
    if (event.target === event.currentTarget) onClose();
  };

  if (typeof document === 'undefined' || !document.body) return null;
  return createPortal(
    <div className="dbp-mermaid-modal" role="dialog" aria-modal="true" aria-label={labels.mermaid} onClick={onBackdropClick}>
      <div className="dbp-mermaid-modal-toolbar">
        <button type="button" onClick={() => zoom(1 / 1.2)} aria-label={labels.mermaidZoomOut} title={labels.mermaidZoomOut}>−</button>
        <button type="button" onClick={() => zoom(1.2)} aria-label={labels.mermaidZoomIn} title={labels.mermaidZoomIn}>+</button>
        <button type="button" onClick={reset} aria-label={labels.mermaidZoomReset} title={labels.mermaidZoomReset}>⟲</button>
        <button type="button" ref={closeButtonRef} onClick={onClose} aria-label={labels.mermaidClose} title={labels.mermaidClose}>✕</button>
      </div>
      <div className="dbp-mermaid-modal-stage" ref={viewportRef} onClick={onBackdropClick} />
      <div className="dbp-mermaid-modal-hint">{labels.mermaidZoomHint}</div>
    </div>,
    document.body,
  );
}

export function MermaidBlock({ code, labels }) {
  const [dark, setDark] = useState(isDarkTheme);
  const [mode, setMode] = useState('diagram');
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const canvasRef = useRef(null);
  const svgNodeRef = useRef(null);
  const copyTimerRef = useRef(0);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    const observer = new MutationObserver(() => setDark(isDarkTheme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    if (!code?.trim()) {
      setError(labels.mermaidError);
      return;
    }
    renderMermaidDiagram(code, dark ? 'dark' : 'default').then((raw) => {
      if (cancelled) return;
      const clean = sanitizeSvg(raw);
      if (!clean) {
        setError(labels.mermaidError);
        return;
      }
      setSvg(clean);
    }).catch((err) => {
      if (cancelled) return;
      setError(summarizeError(err) || labels.mermaidError);
    });
    return () => { cancelled = true; };
  }, [code, dark, labels.mermaidError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const node = importSvgElement(svg);
    if (!node) {
      svgNodeRef.current = null;
      canvas.replaceChildren();
      return undefined;
    }
    svgNodeRef.current = node;
    canvas.replaceChildren(node);
    return () => {
      svgNodeRef.current = null;
      canvas.replaceChildren();
    };
  }, [svg]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const node = svgNodeRef.current;
    if (mode !== 'diagram' || error || !canvas || !node) return;
    // Ensure external DOM mutations or reconciler quirks never accumulate multiple SVGs.
    if (canvas.childNodes.length !== 1 || canvas.firstChild !== node) {
      canvas.replaceChildren(node);
    }
  }, [mode, error, svg]);

  const onCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
      }).catch(() => {});
    }
  };

  return (
    <div className="dbp-mermaid-card" data-mermaid-block>
      <div className="dbp-code-header">
        <span className="dbp-code-lang">{labels.mermaid}</span>
        <div className="dbp-code-actions">
          <div className="dbp-seg" role="tablist" aria-label={labels.mermaid}>
            <button type="button" role="tab" aria-selected={mode === 'diagram'} className={mode === 'diagram' ? 'is-active' : ''} onClick={() => setMode('diagram')}>
              {labels.mermaidDiagram}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'source'} className={mode === 'source' ? 'is-active' : ''} onClick={() => setMode('source')}>
              {labels.mermaidSource}
            </button>
          </div>
          {mode === 'diagram' && svg && (
            <button type="button" className="dbp-code-btn" onClick={() => setZoomOpen(true)}>
              {labels.mermaidZoom}
            </button>
          )}
          <button type="button" className="dbp-code-btn" onClick={onCopy}>
            {copied ? labels.copied : labels.copy}
          </button>
        </div>
      </div>
      {mode === 'source' && (
        <div key="source" className="dbp-mermaid-source">
          <pre tabIndex={0} aria-label={labels.code}><code>{code}</code></pre>
        </div>
      )}
      {mode === 'diagram' && error && (
        <div key="fallback" className="dbp-mermaid-fallback">
          <div className="dbp-mermaid-error" role="status">
            <strong>{labels.mermaidError}</strong>
            <span>{error}</span>
          </div>
          <pre tabIndex={0} aria-label={labels.code}><code>{code}</code></pre>
        </div>
      )}
      {mode === 'diagram' && !error && !svg && (
        <div key="loading" className="dbp-mermaid-loading" role="status" aria-busy="true">{labels.mermaidLoading}</div>
      )}
      {svg && !error && (
        <div key="canvas" ref={canvasRef} className="dbp-mermaid-canvas" role="button" tabIndex={0}
          hidden={mode !== 'diagram'}
          aria-label={labels.mermaidZoom}
          onClick={() => setZoomOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomOpen(true); } }} />
      )}
      {zoomOpen && svg && <MermaidZoomModal svgMarkup={svg} labels={labels} onClose={() => setZoomOpen(false)} />}
    </div>
  );
}
