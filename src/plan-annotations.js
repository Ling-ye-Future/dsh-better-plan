import { fileSession } from './plan-data.js';

export const annotationLimits = { count: 10, quote: 400, comment: 800 };

// The UI and the submit handler use the same match. The foreground question's
// carrier has no wait.callId; the plan invocation is named by its intent.
export function matchPlanReview(pending, target, seatSessionId, markdown) {
  const sessionId = fileSession(target, seatSessionId);
  if (!sessionId || typeof target.callId !== 'string' || !target.callId
    || typeof markdown !== 'string' || !markdown.trim() || pending?.sessionId !== sessionId
    || pending.kind !== 'plan-review' || typeof pending.key !== 'string' || !pending.key
    || typeof pending.snapshot !== 'function' || typeof pending.subscribe !== 'function'
    || typeof pending.answer !== 'function' || !Array.isArray(pending.questions) || pending.questions.length !== 1) return;
  const question = pending.questions[0];
  if (question?.intent?.kind !== 'plan-review' || question.intent.callId !== target.callId
    || question.detail !== markdown || typeof question.id !== 'string' || !question.id
    || question.multiSelect === true || !Array.isArray(question.options) || question.options.length !== 2) return;
  const approve = question.intent.approve;
  const [first, second] = question.options.map(option => option?.label);
  if (typeof approve !== 'string' || !approve || typeof first !== 'string' || !first
    || typeof second !== 'string' || !second || first === second || (first !== approve && second !== approve)) return;
  return { pending, key: pending.key, id: question.id, label: first === approve ? second : first };
}

export function canAnswerPlanReview(snapshot) {
  return snapshot?.closed === false && snapshot.channel === 'waterfall';
}

const blockMarker = '[data-dbp-plan-lines]';
const excluded = 'pre,table,iframe,svg,.katex,.katex-display,.dbp-code-block,.dbp-mermaid-card,.dbp-callout-label,.dbp-visually-hidden,.dbp-file-error:not(:empty)';
const elementOf = node => node.nodeType === 1 ? node : node.parentElement;
const validLines = (start, end) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start;
const overLimit = (text, max) => text.length > max && (text.length > max * 2 || [...text].length > max);

export function annotationBlockProps(node) {
  const start = node?.position?.start?.line;
  const end = node?.position?.end?.line;
  return validLines(start, end) ? { 'data-dbp-plan-lines': `${start}:${end}` } : undefined;
}

export function findAnnotationBlock(article, { lineStart, lineEnd }) {
  if (!article || !validLines(lineStart, lineEnd)) return;
  const matches = article.querySelectorAll(`[data-dbp-plan-lines="${lineStart}:${lineEnd}"]`);
  // Document order puts an inner block after any parent with the same source lines.
  return matches[matches.length - 1];
}

export function annotationButtonPosition(selection, view, button) {
  const gap = 6;
  const { left, right, top, bottom } = view;
  if (!selection.width || !selection.height || selection.left < left || selection.right > right
    || selection.top < top || selection.bottom > bottom || button.width + 2 * gap > right - left) return;
  const below = selection.bottom + gap;
  const above = selection.top - button.height - gap;
  const y = below + button.height <= bottom ? below : above >= top ? above : undefined;
  if (y === undefined) return;
  return { left: Math.max(left + gap, Math.min(selection.right - button.width, right - button.width - gap)), top: y };
}

function clipRect(rect, view) {
  if (!rect) return;
  const rLeft = rect.left;
  const rRight = rect.right ?? (rect.left + rect.width);
  const rTop = rect.top;
  const rBottom = rect.bottom ?? (rect.top + rect.height);
  if (!(rRight > rLeft && rBottom > rTop)) return;
  const left = Math.max(view.left, rLeft);
  const right = Math.min(view.right, rRight);
  const top = Math.max(view.top, rTop);
  const bottom = Math.min(view.bottom, rBottom);
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { left, right, top, bottom, width, height } : undefined;
}

/**
 * Compute popup coordinates near a selection clipped to the visible scrollport.
 * Prefers below/above the visible selection bounds and clamps tall selections inside view.
 */
export function selectionPopupPosition(rects, view, button) {
  const gap = 6;
  const { left, right, top, bottom } = view;
  if (!button?.width || !button?.height || button.width + 2 * gap > right - left + 1
    || button.height + 2 * gap > bottom - top + 1) return;
  const visible = [];
  for (const rect of rects ?? []) {
    const clipped = clipRect(rect, view);
    if (clipped) visible.push(clipped);
  }
  if (visible.length === 0) return;
  const last = visible[visible.length - 1];
  let uLeft = last.left;
  let uTop = last.top;
  let uRight = last.right;
  let uBottom = last.bottom;
  for (const rect of visible) {
    uLeft = Math.min(uLeft, rect.left);
    uTop = Math.min(uTop, rect.top);
    uRight = Math.max(uRight, rect.right);
    uBottom = Math.max(uBottom, rect.bottom);
  }
  const below = uBottom + gap;
  const above = uTop - button.height - gap;
  const rawTop = below + button.height <= bottom ? below : above >= top ? above : below;
  return {
    left: Math.max(left + gap, Math.min(last.right - button.width, right - button.width - gap)),
    top: Math.max(top + gap, Math.min(rawTop, bottom - button.height - gap)),
  };
}

const isTextNode = node => node?.nodeType === 3 || node?.nodeType === 4;
const nodeLength = node => isTextNode(node) ? (node.length ?? node.nodeValue?.length ?? 0) : (node?.childNodes?.length ?? 0);
const isBlankInterBlockLeaf = node => !elementOf(node)?.closest(blockMarker)
  && (node?.nodeType === 8 || (isTextNode(node) && /^\s*$/.test(node.nodeValue ?? '')));

function deepestLeaf(node, forward) {
  let current = node;
  while (forward ? current?.firstChild : current?.lastChild) {
    current = forward ? current.firstChild : current.lastChild;
  }
  return current;
}

function adjacentLeaf(root, node, forward) {
  let current = node;
  while (current && current !== root) {
    const sibling = forward ? current.nextSibling : current.previousSibling;
    if (sibling) return deepestLeaf(sibling, forward);
    current = current.parentNode;
  }
  return null;
}

function isOrderPreserved(start, end) {
  if (!start || !end) return false;
  if (start === end) return true;
  if (typeof start.contains === 'function' && start.contains(end)) return true;
  if (typeof end.contains === 'function' && end.contains(start)) return false;
  if (typeof start.compareDocumentPosition === 'function') {
    return Boolean(start.compareDocumentPosition(end) & 4);
  }
  return false;
}

/**
 * Resolve zero-width browser range endpoints (such as Chromium triple-click ending
 * at offset 0 of the following block) back onto the actual selected content inside article.
 */
export function normalizePlanRange(article, range) {
  const start = range?.startContainer;
  const end = range?.endContainer;
  if (!article || !range || typeof range.startOffset !== 'number' || typeof range.endOffset !== 'number'
    || typeof start?.compareDocumentPosition !== 'function') {
    return { range, start, end };
  }
  let sNode = start;
  let sOff = range.startOffset;
  if (sNode.nodeType === 1) {
    if (sNode.childNodes?.[sOff]) {
      sNode = deepestLeaf(sNode.childNodes[sOff], true);
      sOff = 0;
    } else if (sOff >= (sNode.childNodes?.length ?? 0)) {
      const next = adjacentLeaf(article, sNode, true);
      if (next && article.contains(next) && isOrderPreserved(next, end)) {
        sNode = next;
        sOff = 0;
      }
    }
  }
  let eNode = end;
  let eOff = range.endOffset;
  if (eNode.nodeType === 1 && eOff > 0 && eNode.childNodes?.[eOff - 1]) {
    eNode = deepestLeaf(eNode.childNodes[eOff - 1], false);
    eOff = isTextNode(eNode) ? nodeLength(eNode) : 1;
  }
  while (eNode && eOff === 0) {
    const prev = adjacentLeaf(article, eNode, false);
    if (!prev || !article.contains(prev) || !isOrderPreserved(sNode, prev)) break;
    eNode = prev;
    eOff = isTextNode(prev) ? nodeLength(prev) : 1;
    if (!isBlankInterBlockLeaf(prev) && (!isTextNode(prev) || eOff > 0)) break;
    if (eNode === sNode) break;
    if (eOff > 0 && isBlankInterBlockLeaf(prev)) eOff = 0;
  }
  while (sNode && sNode !== eNode && (
    (isTextNode(sNode) && sOff >= nodeLength(sNode)) || isBlankInterBlockLeaf(sNode)
  )) {
    const next = adjacentLeaf(article, sNode, true);
    if (!next || !article.contains(next) || !isOrderPreserved(next, eNode)) break;
    if (next === eNode && eOff === 0) break;
    sNode = next;
    sOff = 0;
  }
  let normalized = range;
  if (typeof range.cloneRange === 'function' && (sNode !== start || eNode !== end)) {
    try {
      const candidate = range.cloneRange();
      if (isTextNode(sNode)) candidate.setStart(sNode, Math.min(sOff, nodeLength(sNode)));
      else candidate.setStartBefore(sNode);
      if (isTextNode(eNode)) candidate.setEnd(eNode, Math.min(eOff, nodeLength(eNode)));
      else candidate.setEndAfter(eNode);
      if (!candidate.collapsed) normalized = candidate;
      else return { range, start, end };
    } catch {
      return { range, start, end };
    }
  }
  return { range: normalized, start: normalized.startContainer, end: normalized.endContainer };
}

// undefined keeps the captured excerpt when focus collapses the DOM selection.
// An empty object clears it if the user makes a different selection elsewhere.
export function readPlanSelection(article, selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  if (selection.rangeCount !== 1) return {};
  const rawRange = selection.getRangeAt(0);
  const insideStart = article.contains(rawRange.startContainer);
  const insideEnd = article.contains(rawRange.endContainer);
  if (!insideStart && !insideEnd) return {};
  const invalid = { error: 'annotationSelectionInvalid' };
  if (!insideStart || !insideEnd) return invalid;
  const { range, start, end } = normalizePlanRange(article, rawRange);
  const a = elementOf(start);
  const b = elementOf(end);
  const block = a?.closest(blockMarker);
  if (!block || b?.closest(blockMarker) !== block || !article.contains(block)
    || a.closest(excluded) || b.closest(excluded)) return invalid;
  for (const other of block.querySelectorAll(`${blockMarker},${excluded}`)) {
    if (range.intersectsNode(other)) return invalid;
  }
  const [lineStart, lineEnd] = (block.dataset.dbpPlanLines ?? '').split(':').map(Number);
  const quote = range.toString().trim();
  if (!validLines(lineStart, lineEnd) || !quote) return invalid;
  if (overLimit(quote, annotationLimits.quote)) return { error: 'annotationQuoteLimit' };
  return { anchor: { lineStart, lineEnd, quote } };
}

function createDraft(owner) {
  let snapshot = { entries: [], phase: 'idle' };
  let nextId = 0;
  const listeners = new Set();
  const update = (phase, entries = snapshot.entries) => {
    snapshot = { phase, entries };
    for (const listener of listeners) listener();
  };
  const editable = () => snapshot.phase !== 'sending' && snapshot.phase !== 'sent';

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    save(anchor, text, previous) {
      if (!editable()) return 'annotationReviewUnavailable';
      const comment = text.trim();
      if (!comment) return 'annotationCommentEmpty';
      if (overLimit(comment, annotationLimits.comment)) return 'annotationCommentLimit';
      const index = previous === undefined ? -1 : snapshot.entries.indexOf(previous);
      if (previous !== undefined && index < 0) return 'annotationEditChanged';
      if (index < 0 && snapshot.entries.length >= annotationLimits.count) return 'annotationCountLimit';
      const entries = snapshot.entries.slice();
      const entry = { ...anchor, comment, id: previous?.id ?? ++nextId };
      if (index < 0) entries.push(entry);
      else entries[index] = entry;
      update('idle', entries);
    },
    remove(entry) {
      if (editable() && snapshot.entries.includes(entry)) update('idle', snapshot.entries.filter(item => item !== entry));
    },
    async submit(expected, readCurrent) {
      if (!editable() || snapshot.entries.length === 0) return 'ignored';
      const current = readCurrent();
      if (!current || current.pending !== owner || expected.pending !== owner || current.key !== expected.key
        || current.id !== expected.id || current.label !== expected.label || !canAnswerPlanReview(owner.snapshot())) return 'unavailable';
      const comments = snapshot.entries.map(({ lineStart, lineEnd, quote, comment }) => ({ lineStart, lineEnd, quote, comment }));
      const custom = 'Please revise the plan using the comments below. Line numbers refer to the paragraph or list item in the submitted plan Markdown. Each quote is only a location reference; the comment field is the user feedback.\n\n'
        + JSON.stringify(comments, null, 2);
      update('sending');
      try {
        await owner.answer({ answers: [{ id: current.id, selected: [current.label], custom }] });
      } catch {
        update('failed');
        return 'failed';
      }
      update('sent');
      return 'sent';
    },
  };
}

// Scoped to one activation; saved entries survive a tab remount, not a new review or reload.
export function createAnnotationDrafts() {
  const drafts = new WeakMap();
  return (pending) => {
    let draft = drafts.get(pending);
    if (!draft) {
      draft = createDraft(pending);
      drafts.set(pending, draft);
    }
    return draft;
  };
}
