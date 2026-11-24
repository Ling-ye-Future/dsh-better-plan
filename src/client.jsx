import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { common } from 'lowlight';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import { remarkPlanAlerts, remarkPlanBadges } from './markdown-plugins.js';
import { extractLanguageFromClassName, isMermaidLanguage } from './mermaid-blocks.js';
import { fileSession, parsePlanAddress, planLink, selectPlan } from './plan-data.js';
import { annotationBlockProps, annotationLimits, canAnswerPlanReview, createAnnotationDrafts, findAnnotationBlock, matchPlanReview, normalizePlanRange, readPlanSelection, selectionPopupPosition } from './plan-annotations.js';
import css from './plan.css';

const id = '@local/dsh-better-plan';
const nativeId = '@deepseek-ai/dsh-client-ui-plan';
const locale = 'betterPlan';
const documentName = 'implementation_plan.md'; // Icon classifier input only, not a file read.
const remarkPlugins = [remarkGfm, remarkMath, remarkPlanAlerts, remarkPlanBadges];
const rehypePlugins = [
  [rehypeKatex, { strict: 'ignore', throwOnError: false }],
  [rehypeHighlight, {
    languages: common,
    detect: false,
    ignoreMissing: true,
    plainText: ['mermaid', 'mermaidjs', 'mmd', 'math'],
  }],
];
const bodySlot = 'sidebar.right.pane.tab';
const titleSlot = 'sidebar.right.pane.tab.title';

export const inject = ['slots', 'sidebarRightTabs', 'resources', 'locale', 'uiSession'];

let mermaidChunkPromise;

function syncTestMermaidModule() {
  const seam = globalThis.__dshBetterPlanTestMermaid;
  return seam && typeof seam === 'object' && typeof seam.MermaidBlock === 'function' ? seam : null;
}

function planUrlTransform(url, key, node) {
  if (key === 'href' && node?.tagName === 'a' && /^(?:file:\/\/|[a-zA-Z]:\/)/i.test(url)) {
    // Pass workspace file candidates through to `planLink(href, { cwd })`, which enforces strict containment.
    return url;
  }
  return defaultUrlTransform(url);
}

function loadMermaidModule() {
  const seam = globalThis.__dshBetterPlanTestMermaid;
  if (typeof seam === 'function') return Promise.resolve(seam());
  if (seam && typeof seam === 'object') return Promise.resolve(seam);
  // `__dshLoadChunk` is captured in the module banner before esbuild transforms `require`.
  if (typeof __dshLoadChunk !== 'function') {
    return Promise.reject(new Error('Mermaid chunk loader unavailable'));
  }
  if (!mermaidChunkPromise) {
    mermaidChunkPromise = Promise.resolve(__dshLoadChunk('./client.mermaid.js')).catch((error) => {
      mermaidChunkPromise = undefined;
      throw error;
    });
  }
  return mermaidChunkPromise;
}

function DocIcon({ icon }) {
  return <span className="dbp-icon" aria-hidden="true">{icon ?? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M5 2.5h4l3 3v7.75H4V2.5h1Zm4 0v3h3M6 8h4m-4 2.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )}</span>;
}

function planIcon(sidebar) {
  try { return sidebar.fileIcon(documentName, 16); }
  catch { return undefined; }
}

function sessionListOf(scope) {
  try {
    const list = (scope?.sessions ?? scope?.get?.('sessions'))?.list;
    return typeof list?.getSnapshot === 'function' ? list : undefined;
  } catch {
    return undefined;
  }
}

function sessionCwdOf(scope, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  try {
    const cwd = sessionListOf(scope)?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined;
  } catch {
    return undefined;
  }
}

function usePlan({ useTabInfo, useResource }) {
  const { tab } = useTabInfo();
  const { address, params } = tab.navigation;
  const target = useMemo(() => parsePlanAddress(address), [address]);
  const resource = useResource(target?.kind === 'plan' ? address : '');
  return { tab, target, address, ...selectPlan(target, resource, params) };
}

function PlanTitle(props) {
  const { tab, document } = usePlan(props);
  return <><DocIcon icon={planIcon(props.betterSidebar)} />{document?.title || tab.title || props.t('document')}</>;
}

function PlanStatus({ state, t }) {
  const detail = state === 'expired' ? 'reopen' : state === 'failed' ? 'retry' : undefined;
  return <div className="dbp-status" role="status" aria-busy={state === 'loading'}>
    <span className="dbp-status-label">{t(state)}</span>
    {detail && <p>{t(detail)}</p>}
  </div>;
}

function formatLinkTitle(link) {
  if (link.line === undefined) return link.path;
  if (link.lineEnd === undefined) return `${link.path}#L${link.line}`;
  return `${link.path}#L${link.line}-L${link.lineEnd}`;
}

function PlanFileLink({ link, openFile, errorLabel, children }) {
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" className="dbp-file-link" title={formatLinkTitle(link)} onClick={() => {
      try { openFile(link); setFailed(false); }
      catch { setFailed(true); }
    }}>{children}</button>
    <span className="dbp-file-error" role="status">{failed ? errorLabel : ''}</span>
  </>;
}

function extractTextContent(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractTextContent).join('');
  if (node && typeof node === 'object' && node.props?.children !== undefined) {
    return extractTextContent(node.props.children);
  }
  return '';
}

function firstCodeElement(children) {
  const list = Array.isArray(children) ? children : [children];
  return list.find(child => child && typeof child === 'object' && child.type === 'code')
    ?? list.find(child => child && typeof child === 'object' && typeof child.props?.className === 'string');
}

function PlanCodeBlock({ language, rawCode, children, labels }) {
  const [wrapped, setWrapped] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(0);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const onCopy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(rawCode).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };

  return (
    <div className={wrapped ? 'dbp-code-block is-wrapped' : 'dbp-code-block'}>
      <div className="dbp-code-header">
        <span className="dbp-code-lang">{language || labels.codeBlock}</span>
        <div className="dbp-code-actions">
          <button type="button" className="dbp-code-btn" aria-pressed={wrapped} title={wrapped ? labels.unwrap : labels.wrap} onClick={() => setWrapped(prev => !prev)}>
            {labels.wrap}
          </button>
          <button type="button" className="dbp-code-btn" onClick={onCopy}>
            {copied ? labels.copied : labels.copy}
          </button>
        </div>
      </div>
      <pre tabIndex={0} aria-label={labels.code}>{children}</pre>
    </div>
  );
}

function LazyMermaidBlock({ code, labels }) {
  const [mod, setMod] = useState(syncTestMermaidModule);
  const [chunkError, setChunkError] = useState(false);

  useEffect(() => {
    if (mod) return;
    let cancelled = false;
    loadMermaidModule().then((loaded) => {
      if (!cancelled && loaded && typeof loaded.MermaidBlock === 'function') {
        setMod(() => loaded);
      } else if (!cancelled) {
        setChunkError(true);
      }
    }).catch(() => {
      if (!cancelled) setChunkError(true);
    });
    return () => { cancelled = true; };
  }, [mod]);

  if (mod?.MermaidBlock) {
    const LoadedMermaidBlock = mod.MermaidBlock;
    return <LoadedMermaidBlock code={code} labels={labels} />;
  }

  return (
    <div className="dbp-mermaid-card" data-mermaid-pending={chunkError ? undefined : ''} data-mermaid-fallback={chunkError ? '' : undefined}>
      <div className="dbp-code-header">
        <span className="dbp-code-lang">{labels.mermaid}</span>
      </div>
      <div className={chunkError ? 'dbp-mermaid-error' : 'dbp-mermaid-loading'} role="status" aria-busy={!chunkError}>
        {chunkError ? labels.mermaidError : labels.mermaidLoading}
      </div>
      <pre tabIndex={0} aria-label={labels.code}><code>{code}</code></pre>
    </div>
  );
}

function PlanParagraph({ node, ...props }) {
  return <p {...props} {...annotationBlockProps(node)} />;
}

function PlanListItem({ node, ...props }) {
  return <li {...props} {...annotationBlockProps(node)} />;
}

const PlanRenderContext = createContext(null);

function PlanAnchor({ href, children, title, id: anchorId, ...props }) {
  const { openFile, workspaceCwd, prefix, fileErrorLabel } = useContext(PlanRenderContext);
  const link = planLink(href, workspaceCwd ? { cwd: workspaceCwd } : undefined);
  if (link?.kind === 'external') {
    return <a href={link.href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
  }
  if (link?.kind === 'fragment' && link.href.startsWith('#' + prefix)) {
    const describedBy = anchorId?.startsWith(prefix + 'fnref-') ? prefix + 'footnote-label' : undefined;
    return <a href={link.href} id={anchorId} title={title} aria-label={props['aria-label']} aria-describedby={describedBy}>{children}</a>;
  }
  if (link?.kind === 'file' && openFile) {
    return <PlanFileLink link={link} openFile={openFile} errorLabel={fileErrorLabel}>{children}</PlanFileLink>;
  }
  return <span>{children}</span>;
}

function PlanImage({ alt }) {
  return alt ? <span className="dbp-image-alt">{alt}</span> : null;
}

function PlanHeading2({ id: headingId, className, children }) {
  const { prefix } = useContext(PlanRenderContext);
  return <h2 id={headingId === 'footnote-label' ? prefix + headingId : headingId} className={className}>{children}</h2>;
}

function PlanPre({ children }) {
  const { codeLabels, mermaidLabels } = useContext(PlanRenderContext);
  const codeElement = firstCodeElement(children);
  const language = extractLanguageFromClassName(codeElement?.props?.className);
  const rawCode = extractTextContent(codeElement?.props?.children ?? children).replace(/\n$/, '');
  if (isMermaidLanguage(language)) {
    return <LazyMermaidBlock code={rawCode} labels={mermaidLabels} />;
  }
  return <PlanCodeBlock language={language} rawCode={rawCode} labels={codeLabels}>{children}</PlanCodeBlock>;
}

function PlanTable({ children }) {
  const { tableLabel } = useContext(PlanRenderContext);
  return <div className="dbp-table" tabIndex={0} role="region" aria-label={tableLabel}><table>{children}</table></div>;
}

// Module-level map keeps component identities constant so child blocks never remount on prop updates.
const markdownComponents = {
  p: PlanParagraph,
  li: PlanListItem,
  a: PlanAnchor,
  img: PlanImage,
  h2: PlanHeading2,
  pre: PlanPre,
  table: PlanTable,
};

const PlanDocument = memo(function PlanDocument({
  markdown, openFile, workspaceCwd, codeLabels, mermaidLabels, tableLabel, footnotesLabel, fileErrorLabel,
}) {
  const prefix = 'dbp-' + useId().replace(/[^a-zA-Z0-9_-]/g, '') + '-';
  const renderContext = useMemo(() => ({
    openFile, workspaceCwd, prefix, codeLabels, mermaidLabels, tableLabel, fileErrorLabel,
  }), [openFile, workspaceCwd, prefix, codeLabels, mermaidLabels, tableLabel, fileErrorLabel]);
  const rehypeOptions = useMemo(() => ({
    clobberPrefix: prefix,
    footnoteLabel: footnotesLabel,
    footnoteLabelProperties: { className: ['dbp-visually-hidden'] },
  }), [prefix, footnotesLabel]);
  return <PlanRenderContext.Provider value={renderContext}>
    <Markdown skipHtml urlTransform={planUrlTransform} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} remarkRehypeOptions={rehypeOptions} components={markdownComponents}>
      {markdown}
    </Markdown>
  </PlanRenderContext.Provider>;
});

const noSnapshot = () => undefined;
const noSubscription = () => () => {};

function useSessionCwd(sessionList, sessionId, fallbackCwd) {
  const readCwd = useCallback(() => {
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    try {
      const cwd = sessionList?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
      return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : fallbackCwd;
    } catch {
      return fallbackCwd;
    }
  }, [sessionList, sessionId, fallbackCwd]);
  const subscribe = useCallback(listener => (
    sessionList && typeof sessionList.subscribe === 'function' && typeof sessionId === 'string' && sessionId
      ? sessionList.subscribe(listener) : noSubscription()
  ), [sessionList, sessionId]);
  return useSyncExternalStore(subscribe, readCwd, readCwd);
}

function PlanAnnotationBinding({ sessionStatus, sessionId, target, markdown, articleRef, previewRef, getAnnotationDraft, t, showReceipt, onSent }) {
  const readPending = useCallback(() => sessionId === undefined ? undefined
    : sessionStatus?.getSnapshot()?.get(sessionId)?.pendingInteraction, [sessionStatus, sessionId]);
  const subscribe = useCallback(listener => sessionId === undefined || !sessionStatus
    ? noSubscription() : sessionStatus.subscribe(listener), [sessionStatus, sessionId]);
  const pending = useSyncExternalStore(subscribe, readPending, readPending);
  const match = useMemo(() => matchPlanReview(pending, target, sessionId, markdown), [pending, target, sessionId, markdown]);
  const readCard = useCallback(() => match ? match.pending.snapshot() : undefined, [match]);
  const subscribeCard = useCallback(listener => match ? match.pending.subscribe(listener) : noSubscription(), [match]);
  const card = useSyncExternalStore(subscribeCard, readCard, readCard);
  const review = canAnswerPlanReview(card) ? match : undefined;
  // A review can change between React's last render and the send click.
  const readCurrent = () => matchPlanReview(readPending(), target, sessionId, markdown);

  return <>
    {review && getAnnotationDraft && <PlanAnnotations key={review.key} articleRef={articleRef} previewRef={previewRef} review={review}
      draft={getAnnotationDraft(review.pending)} readCurrent={readCurrent} t={t} onSent={onSent} />}
    <div className="dbp-annotation-receipt" role="status">{!review && showReceipt ? t('annotationSent') : ''}</div>
  </>;
}

function selectionRectsOf(article, selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return [];
  const rawRange = selection.getRangeAt(0);
  if (!article.contains(rawRange.startContainer) && !article.contains(rawRange.endContainer)) return [];
  const { range } = article.contains(rawRange.startContainer) && article.contains(rawRange.endContainer)
    ? normalizePlanRange(article, rawRange)
    : { range: rawRange };
  const rects = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
  if (rects.some(rect => rect && rect.width > 0 && rect.height > 0)) return rects;
  if (typeof range.getBoundingClientRect === 'function') {
    const box = range.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) return [box];
  }
  return [];
}

function SelectionPrompt({ articleRef, previewRef, panelRef, kind, label, onAdd }) {
  const popupRef = useRef(null);
  const [position, setPosition] = useState();
  // This overlay is mounted only after an actual selection, never during server rendering.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const preview = previewRef.current;
    const panel = panelRef.current;
    const article = articleRef.current;
    if (!popup || !preview || !panel || !article) return;
    const doc = popup.ownerDocument;
    const view = doc.defaultView;
    const place = () => {
      const rects = selectionRectsOf(article, doc.getSelection());
      let next;
      if (rects.length > 0) {
        const pane = preview.getBoundingClientRect();
        const header = panel.getBoundingClientRect();
        const left = pane.left + (preview.clientLeft || 0);
        const top = pane.top + (preview.clientTop || 0);
        const width = preview.clientWidth || pane.width;
        const height = preview.clientHeight || pane.height;
        const winRight = view?.innerWidth || (left + width);
        const winBottom = view?.innerHeight || (top + height);
        const point = selectionPopupPosition(rects, {
          left: Math.max(0, left), right: Math.min(winRight, left + width),
          top: Math.max(0, top, header.bottom), bottom: Math.min(winBottom, top + height),
        }, popup.getBoundingClientRect());
        if (point) {
          next = {
            left: point.left - header.left - (panel.clientLeft || 0),
            top: point.top - header.top - (panel.clientTop || 0),
          };
        }
      }
      setPosition(previous => previous?.left === next?.left && previous?.top === next?.top ? previous : next);
    };
    place();
    doc.addEventListener('selectionchange', place);
    preview.addEventListener('scroll', place, { passive: true });
    view?.addEventListener('resize', place);
    const observer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(place) : undefined;
    for (const element of [preview, panel, article, popup]) observer?.observe(element);
    return () => {
      observer?.disconnect();
      doc.removeEventListener('selectionchange', place);
      preview.removeEventListener('scroll', place);
      view?.removeEventListener('resize', place);
    };
  }, [articleRef, previewRef, panelRef, kind, label]);

  if (kind === 'hint') {
    return <div role="status" className="dbp-annotation-at-selection dbp-annotation-at-selection-hint"
      ref={popupRef} style={position ?? { visibility: 'hidden' }}>{label}</div>;
  }
  return <button type="button" className="dbp-annotation-at-selection" ref={popupRef} tabIndex={-1}
    style={position ?? { visibility: 'hidden' }} onPointerDown={event => {
      if (event.button === 0) event.preventDefault(); // Keep the text selection until click opens the editor.
    }} onClick={onAdd}>{label}</button>;
}

const annotationLines = ({ lineStart, lineEnd }) => lineStart === lineEnd ? `L${lineStart}` : `L${lineStart}–L${lineEnd}`;

function AnnotationQuote({ anchor, label, locateLabel, onLocate }) {
  const lines = annotationLines(anchor);
  return <div className="dbp-annotation-quote">
    <small>{label} {onLocate ? <button type="button" className="dbp-annotation-location"
      aria-label={`${locateLabel} ${lines}`} onClick={onLocate}>{lines}</button> : lines}</small>
    <blockquote>{anchor.quote}</blockquote>
  </div>;
}

function PlanAnnotations({ articleRef, previewRef, draft, review, readCurrent, onSent, t }) {
  const { entries, phase } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [selection, setSelection] = useState({});
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState('');
  const [jump, setJump] = useState(null);
  const panelRef = useRef(null);
  const toolbar = useRef(null);
  const input = useRef(null);
  const hintId = useId();
  const editorAnchor = editor?.anchor;
  const locked = phase === 'sending' || phase === 'sent';

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const doc = article.ownerDocument;
    const view = doc.defaultView;
    let dragging = false;
    let pointerInArticle = false;
    const capture = (clearCollapsed = false) => {
      const next = readPlanSelection(article, doc.getSelection());
      if (!next) {
        // Toolbar focus can collapse the range without discarding the captured quote.
        setSelection(previous => {
          if (clearCollapsed) return {};
          if (!previous.hasRange) return previous;
          return previous.anchor ? { anchor: previous.anchor } : {};
        });
        return;
      }
      setSelection({ ...next, hasRange: Boolean(next.anchor || next.error) });
    };
    const startSelection = event => {
      if (event.button !== 0) return;
      dragging = true;
      pointerInArticle = true;
      // Hide only the floating range overlay during drag so header height does not jump mid-drag.
      setSelection(previous => previous.hasRange
        ? { ...(previous.anchor ? { anchor: previous.anchor } : {}), ...(previous.error ? { error: previous.error } : {}) }
        : previous);
    };
    const finishSelection = () => {
      if (!dragging) return;
      dragging = false;
      const clearCollapsed = pointerInArticle;
      pointerInArticle = false;
      capture(clearCollapsed);
    };
    const handleSelectionChange = () => {
      if (dragging) return;
      capture(false);
    };
    capture(false);
    doc.addEventListener('selectionchange', handleSelectionChange);
    article.addEventListener('pointerdown', startSelection);
    doc.addEventListener('pointerup', finishSelection);
    doc.addEventListener('pointercancel', finishSelection);
    view?.addEventListener('blur', finishSelection);
    return () => {
      doc.removeEventListener('selectionchange', handleSelectionChange);
      article.removeEventListener('pointerdown', startSelection);
      doc.removeEventListener('pointerup', finishSelection);
      doc.removeEventListener('pointercancel', finishSelection);
      view?.removeEventListener('blur', finishSelection);
    };
  }, [articleRef]);

  useEffect(() => { if (editorAnchor) input.current?.focus(); }, [editorAnchor]);
  useEffect(() => {
    if (!jump || !articleRef.current?.contains(jump.block)) return;
    const preview = previewRef.current;
    const panel = panelRef.current;
    if (!preview || !panel) return;
    const { block } = jump;
    const clearFocus = () => block.removeAttribute('tabindex');
    const clearMark = () => block.removeAttribute('data-dbp-annotation-located');
    block.tabIndex = -1;
    block.addEventListener('blur', clearFocus, { once: true });
    block.focus({ preventScroll: true });
    const visibleTop = Math.max(preview.getBoundingClientRect().top, panel.getBoundingClientRect().bottom);
    preview.scrollTop += block.getBoundingClientRect().top - visibleTop - 8;
    block.setAttribute('data-dbp-annotation-located', '');
    const timer = setTimeout(clearMark, 1200);
    return () => {
      clearTimeout(timer);
      clearMark();
      block.removeEventListener('blur', clearFocus);
      clearFocus();
    };
  }, [jump, articleRef, previewRef]);

  const locate = anchor => {
    const block = findAnnotationBlock(articleRef.current, anchor);
    setSelection({});
    setError(block ? '' : 'annotationLocationUnavailable');
    setJump(block ? { block, lines: annotationLines(anchor) } : null);
  };
  const begin = (anchor, previous) => {
    setError('');
    setEditor({ anchor, previous, text: previous?.comment ?? '' });
  };
  const closeEditor = () => {
    setEditor(null);
    setSelection({});
    setError('');
    toolbar.current?.focus();
  };
  const save = () => {
    const problem = draft.save(editor.anchor, editor.text, editor.previous);
    if (problem) { setError(problem); return; }
    closeEditor();
  };
  const send = async () => {
    if (editor) return;
    setError('');
    const result = await draft.submit(review, readCurrent);
    if (result === 'sent') onSent();
    if (result === 'unavailable') setError('annotationReviewUnavailable');
  };
  const selectionHint = entries.length >= annotationLimits.count && !selection.error ? 'annotationCountLimit'
    : selection.error ?? 'annotationHint';
  const status = error || (phase === 'failed' ? 'annotationSendFailed' : phase === 'sending' ? 'annotationSending'
    : phase === 'sent' ? 'annotationSent' : '');

  const canAdd = !locked && !editor && !!selection.anchor && entries.length < annotationLimits.count;
  const add = () => begin(selection.anchor);
  const showSelectionPrompt = !locked && !editor && selection.hasRange && Boolean(selection.anchor || selection.error);
  const promptKind = canAdd ? 'add' : 'hint';
  const promptLabel = showSelectionPrompt
    ? t(canAdd ? 'annotationAdd' : (selection.anchor ? 'annotationCountLimit' : selection.error))
    : '';

  return <section className="dbp-annotations" ref={panelRef} aria-label={t('annotations')}>
    <div className="dbp-annotation-toolbar" ref={toolbar} tabIndex={-1}>
      <strong>{t('annotations')}</strong>
      <div className="dbp-annotation-actions">
        <button type="button" aria-describedby={!editor && !locked ? hintId : undefined} disabled={!canAdd}
          onClick={add}>{t('annotationAdd')}</button>
        <button type="button" className="dbp-annotation-submit" disabled={locked || !!editor || entries.length === 0}
          onClick={send}>{t('annotationSubmit')} ({entries.length})</button>
      </div>
    </div>
    {entries.length > 0 && !locked && <div className="dbp-annotation-warning">{t('annotationDraftWarning')}</div>}
    <div className="dbp-annotation-status" role="status" data-tone={error || phase === 'failed' ? 'error' : undefined}>
      {status && t(status)}
    </div>
    <div className="dbp-visually-hidden" role="status">{jump && `${t('annotationLocated')} ${jump.lines}`}</div>
    <div className="dbp-annotation-details">
      {!editor && !locked && <div id={hintId} className="dbp-annotation-hint">
        {selection.anchor && entries.length < annotationLimits.count
          ? <AnnotationQuote anchor={selection.anchor} label={t('annotationSelected')} /> : t(selectionHint)}
      </div>}
      {editor && <div className="dbp-annotation-editor">
        <AnnotationQuote anchor={editor.anchor} label={t('annotationPlanLines')} />
        <label>{t('annotationComment')}
          <textarea ref={input} rows={3} value={editor.text} disabled={locked} onChange={event => {
            setEditor({ ...editor, text: event.target.value });
            setError('');
          }} />
        </label>
        <div className="dbp-annotation-actions">
          <button type="button" disabled={locked || !editor.text.trim()} onClick={save}>{t('annotationSave')}</button>
          <button type="button" onClick={closeEditor}>{t('annotationCancel')}</button>
        </div>
      </div>}
      {entries.length > 0 && <ol className="dbp-annotation-list">
        {entries.map((entry, index) => <li key={entry.id}>
          <AnnotationQuote anchor={entry} label={t('annotationPlanLines')} locateLabel={t('annotationLocate')}
            onLocate={() => locate(entry)} />
          <div className="dbp-annotation-memo">{entry.comment}</div>
          <div className="dbp-annotation-actions">
            <button type="button" aria-label={`${t('annotationEdit')} ${index + 1}`} disabled={locked || !!editor}
              onClick={() => begin(entry, entry)}>{t('annotationEdit')}</button>
            <button type="button" aria-label={`${t('annotationRemove')} ${index + 1}`} disabled={locked || !!editor}
              onClick={() => { draft.remove(entry); toolbar.current?.focus(); }}>{t('annotationRemove')}</button>
          </div>
        </li>)}
      </ol>}
    </div>
    {showSelectionPrompt && <SelectionPrompt articleRef={articleRef}
      previewRef={previewRef} panelRef={panelRef} kind={promptKind} label={promptLabel} onAdd={add} />}
  </section>;
}

function PlanBody(props) {
  const { t, betterSidebar, seatSessionId, workspaceCwd, sessionList, sessionStatus, getAnnotationDraft } = props;
  const { address, document, state, target, tab } = usePlan(props);
  const sessionId = fileSession(target, seatSessionId);
  const previewRef = useRef(null);
  const articleRef = useRef(null);
  const [receipt, setReceipt] = useState(null);
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => setReceipt(null), 5000);
    return () => clearTimeout(timer);
  }, [receipt]);
  const effectiveCwd = useSessionCwd(sessionList, sessionId, workspaceCwd);
  const openFile = useMemo(() => sessionId === undefined ? undefined : ({ path, line, lineEnd }) => {
    if (betterSidebar.isTabEnabled?.('editor') === false) throw new Error('Better Sidebar editor is disabled');
    const options = line === undefined ? undefined : (lineEnd === undefined ? { line } : { line, lineEnd });
    betterSidebar.openFile({ sessionId }, path, undefined, options);
  }, [betterSidebar, sessionId]);

  const codeLabels = useMemo(() => ({
    code: t('code'),
    codeBlock: t('codeBlock'),
    copy: t('copy'),
    copied: t('copied'),
    wrap: t('wrap'),
    unwrap: t('unwrap'),
  }), [t]);

  const mermaidLabels = useMemo(() => ({
    code: t('code'),
    copy: t('copy'),
    copied: t('copied'),
    mermaid: t('mermaid'),
    mermaidLoading: t('mermaidLoading'),
    mermaidDiagram: t('mermaidDiagram'),
    mermaidSource: t('mermaidSource'),
    mermaidZoom: t('mermaidZoom'),
    mermaidZoomIn: t('mermaidZoomIn'),
    mermaidZoomOut: t('mermaidZoomOut'),
    mermaidZoomReset: t('mermaidZoomReset'),
    mermaidClose: t('mermaidClose'),
    mermaidZoomHint: t('mermaidZoomHint'),
    mermaidError: t('mermaidError'),
  }), [t]);

  const activeSessionId = tab.visible && state === 'ready' ? sessionId : undefined;
  const showReceipt = Boolean(tab.visible && receipt?.address === address && receipt.markdown === document?.markdown);
  const onSent = () => setReceipt({ address, markdown: document.markdown });
  const annotationProps = {
    articleRef,
    previewRef,
    getAnnotationDraft,
    t,
    showReceipt,
    onSent,
    sessionId: activeSessionId,
    target,
    markdown: document?.markdown,
    sessionStatus,
  };

  return <section className="dbp-preview" ref={previewRef} tabIndex={0} aria-label={document?.title || t('document')}>
    <style>{css}</style>
    {state === 'ready' ? <>
      <PlanAnnotationBinding {...annotationProps} />
      <article className="dbp-document" ref={articleRef}>
        <PlanDocument key={address} markdown={document.markdown} openFile={openFile} workspaceCwd={effectiveCwd}
          codeLabels={codeLabels} mermaidLabels={mermaidLabels} tableLabel={t('table')}
          footnotesLabel={t('footnotes')} fileErrorLabel={t('fileUnavailable')} />
      </article>
    </> : <PlanStatus state={state} t={t} />}
  </section>;
}

function registerPlanPreview(scope, betterSidebar) {
  const { sessionStatus } = scope.uiSession;
  const getAnnotationDraft = createAnnotationDrafts();
  scope.effect(() => scope.locale.register(locale, { en: en.ui, zh: zh.ui }), 'better-plan: dictionaries');
  scope.slots.inject(bodySlot, () => scope.slots.register({
    name: bodySlot, key: id, locale,
    inject: seatSessionId => ({
      betterSidebar,
      seatSessionId,
      workspaceCwd: sessionCwdOf(scope, seatSessionId),
      sessionList: sessionListOf(scope),
      sessionStatus,
      getAnnotationDraft,
    }),
  }, PlanBody));
  scope.slots.inject(titleSlot, () => scope.slots.register({
    name: titleSlot, key: id, locale, inject: () => ({ betterSidebar }),
  }, PlanTitle));
  const t = scope.locale.bind(locale);
  scope.effect(() => scope.sidebarRightTabs.register({
    id, kind: 'plan', priority: 'extension',
    patterns: ['dsh-resource://plan/**', 'dsh-resource://plan-review/**'],
    canOpen: address => parsePlanAddress(address) !== undefined,
    title: () => t('document'),
  }), 'better-plan: native plan resource adapter');
}

export function apply(ctx) {
  // No static import or second Better Sidebar installation; a missing/disabled
  // service leaves the native plan type in force.
  ctx.inject(['betterSidebar'], (scope) => {
    const { betterSidebar, sidebarRightTabs } = scope;
    if (betterSidebar.version !== '0.32.1' || typeof betterSidebar.fileIcon !== 'function' || typeof betterSidebar.openFile !== 'function') return;

    scope.effect(() => {
      let waiting = true;
      const stop = () => {
        if (!waiting) return;
        waiting = false;
        unsubscribe();
      };
      const tryRegister = () => {
        if (!waiting || sidebarRightTabs.get('plan')?.id !== nativeId) return;
        // Registration notifies registry listeners synchronously.
        stop();
        registerPlanPreview(scope, betterSidebar);
      };
      const unsubscribe = sidebarRightTabs.subscribe(tryRegister);
      tryRegister();
      return stop;
    }, 'better-plan: wait for native plan type');
  });
}
