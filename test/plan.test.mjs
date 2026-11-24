import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileSession, parsePlanAddress, planLink, selectPlan } from '../src/plan-data.js';
import { annotationBlockProps, annotationButtonPosition, canAnswerPlanReview, createAnnotationDrafts, findAnnotationBlock, matchPlanReview, readPlanSelection } from '../src/plan-annotations.js';

const root = 'dsh-resource://plan/session-1/call%3A1';
const child = 'dsh-resource://plan/subagent/parent/child/continuable/call';
const temp = 'dsh-resource://plan-review/session-1/window%3Arequest';
const nativeId = '@deepseek-ai/dsh-client-ui-plan';
const pluginId = '@local/dsh-better-plan';
const ns = 'betterPlan';
const require = createRequire(import.meta.url);
const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('matches only native plan/review resource identities', () => {
  assert.deepEqual(parsePlanAddress(root), { kind: 'plan', sessionId: 'session-1', callId: 'call:1' });
  assert.deepEqual(parsePlanAddress(child), { kind: 'plan', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable', callId: 'call' });
  assert.deepEqual(parsePlanAddress(temp), { kind: 'review', sessionId: 'session-1', requestKey: 'window:request' });
  for (const invalid of ['', undefined, root + '/extra', root + '#L1', root + '?x=1', root + '%ZZ', child.replace('continuable', 'linked'), 'dsh-resource://file/session/a.md']) {
    assert.equal(parsePlanAddress(invalid), undefined, invalid);
  }
  assert.equal(fileSession(parsePlanAddress(root), 'session-1'), 'session-1');
  assert.equal(fileSession(parsePlanAddress(root), 'session-2'), undefined);
  assert.equal(fileSession(parsePlanAddress(child), 'child'), undefined);
  assert.equal(fileSession(parsePlanAddress(temp), 'session-1'), undefined);
});

test('selects the right immutable document and never shows stale data on failure', () => {
  const document = { title: 'Plan', markdown: '# Plan\n\nOriginal content' };
  const live = { status: 'live', value: document };
  const logged = parsePlanAddress(root);
  const review = parsePlanAddress(temp);
  assert.deepEqual(selectPlan(logged, live, { planReview: { title: 'Other', markdown: '# Other' } }), { state: 'ready', document });
  assert.deepEqual(selectPlan(logged, { status: 'loading' }), { state: 'loading' });
  assert.deepEqual(selectPlan(logged, { status: 'failed', value: document }), { state: 'failed' });
  assert.deepEqual(selectPlan(logged, { status: 'none' }), { state: 'unavailable' });
  assert.deepEqual(selectPlan(logged, { status: 'live', value: { markdown: ' ' } }), { state: 'unavailable' });
  assert.deepEqual(selectPlan(review, live), { state: 'expired' });
  assert.deepEqual(selectPlan(review, undefined, { planReview: document }), { state: 'ready', document });
});

test('allows user-clicked explicit file links with a positive line and rejects escapes', () => {
  assert.deepEqual(planLink('./src/a%20b.ts#L42'), { kind: 'file', path: 'src/a b.ts', line: 42 });
  assert.deepEqual(planLink('README.md'), { kind: 'file', path: 'README.md', line: undefined });
  assert.deepEqual(planLink('https://example.com/a#b'), { kind: 'external', href: 'https://example.com/a#b' });
  assert.deepEqual(planLink('#dbp-fn'), { kind: 'fragment', href: '#dbp-fn' });
  const rejected = ['javascript:alert(1)', 'file:///c:/a.md', 'data:text/html,x', 'mailto:x@example.com', 'https://user:pass@example.com/', '//example.com/a.md', '/a.md', 'C:/a.md', 'C:%5Ca.md', 'a/../../b.md', '%2e%2e/b.md', 'a/..%20/b.md', 'a%2Ffoo.md', 'a%252Fb.md', 'a\\b.md', 'a/NUL.txt', 'a.md?query=foo', 'a.md#L0', 'a.md#L9007199254740992', 'topic'];
  for (const value of rejected) assert.equal(planLink(value), undefined, value);
});

function clientModule() {
  let spec;
  runInNewContext(read('lib/client.js'), { window: { __ModuleLoader__: { load(value) { spec = value; } } }, URL, TextEncoder, TextDecoder, structuredClone });
  assert.equal(spec?.id, pluginId);
  return spec.factory((name) => {
    assert.ok(['react', 'react/jsx-runtime'].includes(name), name);
    return require(name);
  });
}

const planMarkdown = '# Plan\n\nA **main** paragraph\non two Markdown lines.\n\n- A tight item\n\n> [!NOTE]\n> Useful note.';

function pendingReview({ callId = 'call:1', sessionId = 'session-1', detail = planMarkdown, answer = async () => {} } = {}) {
  let card = { channel: 'waterfall', closed: false };
  return {
    kind: 'plan-review', key: 'opaque-request-key', sessionId,
    // The native foreground review carries the invocation on the intent, not the carrier.
    questions: [{ id: 'plan-review', detail, intent: { kind: 'plan-review', approve: 'Approve', callId },
      options: [{ label: 'Approve' }, { label: 'Keep planning' }] }],
    subscribe: () => () => {}, snapshot: () => card, setCard: value => { card = value; }, answer,
  };
}

const reviewOf = (pending, address = root, sessionId = 'session-1', markdown = planMarkdown) =>
  matchPlanReview(pending, parsePlanAddress(address), sessionId, markdown);

const firstExcerpt = { lineStart: 3, lineEnd: 4, quote: 'A main paragraph' };
const secondExcerpt = { lineStart: 6, lineEnd: 6, quote: 'A tight item' };

test('binds annotations only to the exact live plan identity, with the offered non-approval label', () => {
  const pending = pendingReview();
  assert.equal(pending.callId, undefined);
  assert.deepEqual(reviewOf(pending), { pending, key: pending.key, id: 'plan-review', label: 'Keep planning' });
  for (const result of [reviewOf(undefined), reviewOf(pending, root, 'session-2'), reviewOf(pending, root, 'session-1', '# Different'),
    reviewOf(pendingReview({ callId: 'same-text-different-call' })), reviewOf(pendingReview({ sessionId: 'session-2' })),
    reviewOf(pending, temp), reviewOf(pending, child, 'parent')]) assert.equal(result, undefined);
  assert.equal(matchPlanReview(pendingReview({ callId: null }), { kind: 'plan', sessionId: 'session-1', callId: null }, 'session-1', planMarkdown), undefined);
  pending.questions[0].options.reverse();
  assert.equal(reviewOf(pending).label, 'Keep planning');
  pending.questions[0].options = [{ label: 'Approve' }, { label: 'Approve' }];
  assert.equal(reviewOf(pending), undefined);
  assert.equal(canAnswerPlanReview({ channel: 'waterfall', closed: false }), true);
  for (const channel of ['rpc', 'none']) assert.equal(canAnswerPlanReview({ channel, closed: false }), false);
  assert.equal(canAnswerPlanReview({ channel: 'waterfall', closed: true }), false);
});

test('captures text as a block-level Markdown anchor and rejects invalid ranges', () => {
  const marker = '[data-dbp-plan-lines]';
  const makeBlock = (lines, children = []) => {
    const element = { nodeType: 1, dataset: { dbpPlanLines: lines },
      closest: selector => selector === marker ? element : null, querySelectorAll: () => children };
    return element;
  };
  const nonText = {};
  const first = makeBlock('3:4', [nonText]);
  const second = makeBlock('6:6');
  const inside = { nodeType: 3, parentElement: first };
  const formula = { nodeType: 1, closest: selector => selector === marker ? first : formula };
  const outside = {};
  const generated = { nodeType: 1, closest: () => null };
  const article = { contains: node => node !== outside };
  const select = (startContainer, endContainer, text, crosses = undefined) => ({ rangeCount: 1, isCollapsed: false,
    getRangeAt: () => ({ startContainer, endContainer, toString: () => text, intersectsNode: node => node === crosses }) });
  assert.deepEqual(annotationBlockProps({ position: { start: { line: 3 }, end: { line: 4 } } }), { 'data-dbp-plan-lines': '3:4' });
  assert.equal(annotationBlockProps({ position: { start: { line: 4 }, end: { line: 3 } } }), undefined);
  assert.equal(annotationBlockProps({}), undefined);
  assert.deepEqual(readPlanSelection(article, select(inside, first, `  ${firstExcerpt.quote}  `)), { anchor: firstExcerpt });
  assert.equal(readPlanSelection(article, { isCollapsed: true, rangeCount: 1 }), undefined);
  assert.deepEqual(readPlanSelection(article, select(outside, outside, 'another panel')), {});
  for (const [start, end, text, intersection] of [[first, second, 'cross-block'], [first, outside, 'outside'],
    [first, first, ' \n '], [generated, generated, 'synthetic'], [formula, first, 'math'], [first, first, 'math between text', nonText]]) {
    assert.equal(readPlanSelection(article, select(start, end, text, intersection)).error, 'annotationSelectionInvalid');
  }
  assert.equal(readPlanSelection(article, select(first, first, '字'.repeat(401))).error, 'annotationQuoteLimit');
});

test('locates only exact source blocks in the active article, favoring a nested block', () => {
  const parent = {};
  const nested = {};
  const item = {};
  const article = { querySelectorAll: selector => ({
    '[data-dbp-plan-lines="3:4"]': [parent, nested],
    '[data-dbp-plan-lines="6:6"]': [item],
  }[selector] ?? []) };
  assert.equal(findAnnotationBlock(article, firstExcerpt), nested);
  assert.equal(findAnnotationBlock(article, secondExcerpt), item);
  assert.equal(findAnnotationBlock(article, { lineStart: 3, lineEnd: 6 }), undefined);
  assert.equal(findAnnotationBlock({ querySelectorAll: () => assert.fail('invalid lines must not be queried') }, { lineStart: 4, lineEnd: 3 }), undefined);
  assert.equal(findAnnotationBlock(null, firstExcerpt), undefined);
});

test('places the comment shortcut clear of the text and sticky panel, or leaves only the toolbar', () => {
  const visible = { left: 100, right: 390, top: 160, bottom: 520 };
  const button = { width: 115, height: 30 };
  const range = { left: 147, right: 222, top: 200, bottom: 236, width: 75, height: 36 };
  assert.deepEqual(annotationButtonPosition(range, visible, button), { left: 107, top: 242 });
  assert.deepEqual(annotationButtonPosition({ ...range, top: 478, bottom: 514 }, visible, button), { left: 107, top: 442 });
  assert.deepEqual(annotationButtonPosition({ ...range, right: 389 }, visible, button), { left: 269, top: 242 });
  assert.equal(annotationButtonPosition({ ...range, top: 159 }, visible, button), undefined);
  assert.equal(annotationButtonPosition({ ...range, top: 180, bottom: 501 }, visible, button), undefined);
  assert.equal(annotationButtonPosition(range, { ...visible, right: 226 }, button), undefined);
});

test('keeps saved annotations scoped to the pending object and sends an ordered batch only once', async () => {
  const answers = [];
  let finish;
  const pending = pendingReview({ answer: value => { answers.push(value); return new Promise(resolve => { finish = resolve; }); } });
  const review = reviewOf(pending);
  const getDraft = createAnnotationDrafts();
  const draft = getDraft(pending);
  let updates = 0;
  const unlisten = draft.subscribe(() => { updates++; });
  assert.equal(draft.save(firstExcerpt, ' initial '), undefined);
  assert.equal(draft.save(secondExcerpt, '替换验证方法'), undefined);
  const original = draft.getSnapshot().entries[0];
  assert.equal(draft.save(firstExcerpt, '保留第一个边界', original), undefined);
  assert.equal(draft.save(firstExcerpt, 'stale editor', original), 'annotationEditChanged');
  assert.equal(draft.save(secondExcerpt, 'delete me'), undefined);
  draft.remove(draft.getSnapshot().entries[2]);
  assert.equal(updates, 5);
  unlisten();
  assert.equal(getDraft(pending), draft);
  assert.deepEqual(getDraft(pendingReview()).getSnapshot().entries, []); // same key and content, different request
  const savedEntries = draft.getSnapshot().entries;
  const submitting = draft.submit(review, () => reviewOf(pending));
  assert.equal(draft.getSnapshot().phase, 'sending');
  assert.equal(await draft.submit(review, () => reviewOf(pending)), 'ignored');
  assert.equal(answers.length, 1);
  const [{ id, selected, custom }] = answers[0].answers;
  assert.equal(id, 'plan-review');
  assert.deepEqual(selected, ['Keep planning']);
  assert.match(custom, /quote is only a location reference/);
  assert.deepEqual(JSON.parse(custom.split('\n\n')[1]), [
    { ...firstExcerpt, comment: '保留第一个边界' }, { ...secondExcerpt, comment: '替换验证方法' },
  ]);
  finish();
  assert.equal(await submitting, 'sent');
  assert.deepEqual(draft.getSnapshot(), { phase: 'sent', entries: savedEntries });
  assert.equal(await draft.submit(review, () => review), 'ignored');
  assert.equal(updates, 5);
});

test('checks the latest pending object and channel at send time and preserves failed feedback', async () => {
  let sent = 0;
  const pending = pendingReview({ answer: async () => { if (++sent === 1) throw new Error('network'); } });
  const draft = createAnnotationDrafts()(pending);
  const review = reviewOf(pending);
  assert.equal(draft.save(firstExcerpt, ' '), 'annotationCommentEmpty');
  assert.equal(draft.save(firstExcerpt, '🙂'.repeat(801)), 'annotationCommentLimit');
  assert.equal(draft.save(firstExcerpt, '🙂'.repeat(800)), undefined);
  for (let i = 1; i < 10; i++) assert.equal(draft.save(secondExcerpt, `note ${i}`), undefined);
  assert.equal(draft.save(firstExcerpt, 'extra'), 'annotationCountLimit');
  const readCurrent = () => reviewOf(pending);
  for (const read of [() => undefined, () => reviewOf(pendingReview()), () => ({ ...review, key: 'another-key' })]) {
    assert.equal(await draft.submit(review, read), 'unavailable');
  }
  pending.setCard({ channel: 'none', closed: false });
  assert.equal(await draft.submit(review, readCurrent), 'unavailable');
  pending.setCard({ channel: 'waterfall', closed: false });
  assert.equal(sent, 0);
  assert.equal(await draft.submit(review, readCurrent), 'failed');
  assert.equal(draft.getSnapshot().phase, 'failed');
  assert.equal(draft.getSnapshot().entries.length, 10);
  assert.equal(await draft.submit(review, readCurrent), 'sent');
  assert.equal(sent, 2);
});

// Contract-only fixture: no imitation of the DSH window, router or network.
function mount({ version = '0.32.1', native = nativeId, present = true, sessionStatus } = {}) {
  const slots = new Map();
  const dictionaries = new Map();
  const cleanup = [];
  const touchedFiles = [];
  let type = native ? { id: native, kind: 'plan' } : undefined;
  let registrations = 0;
  const registryListeners = new Set();
  const setType = value => {
    type = value;
    for (const listener of [...registryListeners]) listener();
  };
  const sidebar = {
    version,
    fileIcon: (name) => createElement('svg', { 'data-file-glyph': name }),
    openFile: (...args) => touchedFiles.push(args),
  };
  const ctx = {
    betterSidebar: sidebar,
    uiSession: { sessionStatus },
    inject(_names, apply) { if (present) apply(this); },
    effect(callback) { cleanup.push(callback()); },
    locale: {
      register(name, value) { dictionaries.set(name, value); return () => dictionaries.delete(name); },
      bind(name) { return key => dictionaries.get(name).en[key]; },
    },
    slots: {
      inject(_slot, install) { cleanup.push(install()); },
      register(definition, component) { slots.set(definition.name, { definition, component }); return () => slots.delete(definition.name); },
    },
    sidebarRightTabs: {
      get(kind) { return kind === 'plan' ? type : undefined; },
      subscribe(listener) { registryListeners.add(listener); return () => registryListeners.delete(listener); },
      register(value) {
        if (type?.id !== nativeId) throw new Error('can only take over the native plan');
        const previous = type;
        registrations++;
        setType(value);
        return () => setType(previous);
      },
    },
  };
  clientModule().apply(ctx);
  return {
    get type() { return type; },
    get registrations() { return registrations; },
    get watching() { return registryListeners.size; },
    slots, dictionaries, touchedFiles,
    showNativePlan() { setType({ id: nativeId, kind: 'plan' }); },
    dispose() { for (const release of cleanup.splice(0).reverse()) release(); },
  };
}

test('client uses one native plan kind and releases it on unload', () => {
  const mountResult = mount();
  assert.equal(mountResult.type.id, pluginId);
  assert.equal(mountResult.type.kind, 'plan');
  assert.equal(mountResult.type.priority, 'extension');
  assert.equal(mountResult.type.canOpen(child), true);
  assert.equal(mountResult.type.canOpen(temp), true);
  assert.equal(mountResult.type.canOpen('dsh-resource://file/session/README.md'), false);
  assert.equal(mountResult.slots.size, 2);
  assert.equal(mountResult.type.title(), 'Implementation plan');
  mountResult.dispose();
  assert.equal(mountResult.type.id, nativeId);
  assert.equal(mountResult.slots.size, 0);
  assert.equal(mountResult.dictionaries.size, 0);
  for (const options of [{ present: false }, { version: '0.33.0' }, { native: 'another-plan' }, { native: null }]) {
    const inactive = mount(options);
    assert.notEqual(inactive.type?.id, pluginId);
    assert.equal(inactive.slots.size, 0);
    inactive.dispose();
  }
});

test('takes over a late native plan exactly once and stops watching on unload', () => {
  for (const native of [null, 'another-plan']) {
    const waiting = mount({ native });
    assert.equal(waiting.type?.id, native ?? undefined);
    assert.equal(waiting.slots.size, 0);
    waiting.showNativePlan();
    assert.equal(waiting.type?.id, pluginId);
    assert.equal(waiting.registrations, 1);
    assert.equal(waiting.slots.size, 2);
    waiting.dispose();
    assert.equal(waiting.type?.id, nativeId);
    assert.equal(waiting.slots.size, 0);
    assert.equal(waiting.watching, 0);
  }

  const unloaded = mount({ native: null });
  unloaded.dispose();
  unloaded.showNativePlan();
  assert.equal(unloaded.watching, 0);
  assert.equal(unloaded.registrations, 0);
  assert.equal(unloaded.type?.id, nativeId);
  assert.equal(unloaded.slots.size, 0);
});

const renderPlan = (m, { address = root, params, resource = { status: 'none' }, sessionId = 'session-1', lang = 'en', visible = true, slotName = 'sidebar.right.pane.tab' } = {}) => {
  const slot = m.slots.get(slotName);
  return renderToStaticMarkup(createElement(slot.component, {
    ...slot.definition.inject(sessionId),
    useTabInfo: () => ({ tab: { title: 'tab', visible, navigation: { address, params } } }),
    useResource: (readAddress) => {
      assert.equal(readAddress, address.startsWith('dsh-resource://plan/') ? address : '');
      return resource;
    },
    t: key => m.dictionaries.get(ns)[lang][key],
  }));
};

test('shows annotation controls only on a visible pending plan and preserves source positions', async () => {
  const pending = pendingReview({ answer: async () => { throw new Error('network'); } });
  const mounted = mount({ sessionStatus: { subscribe: () => () => {},
    getSnapshot: () => new Map([['session-1', { pendingInteraction: pending }]]) } });
  const resource = { status: 'live', value: { markdown: planMarkdown, title: 'Plan' } };
  const markup = renderPlan(mounted, { resource });
  const panel = /<section class="dbp-annotations"/;
  assert.match(markup, panel);
  assert.match(markup, /Continue planning with comments \(0\)/);
  assert.ok(markup.includes('<p data-dbp-plan-lines="3:4">A <strong>main</strong> paragraph'));
  assert.ok(markup.includes('<li data-dbp-plan-lines="6:6">A tight item</li>'));
  assert.ok(markup.includes('<p class="dbp-callout-label">NOTE</p>'));
  assert.match(renderPlan(mounted, { resource, lang: 'zh' }), /带批注继续规划 \(0\)/);
  assert.doesNotMatch(markup, /<button[^>]+class="dbp-annotation-(?:at-selection|location)"/);
  assert.doesNotMatch(markup, /Reloading the page or ending the review/);
  const { getAnnotationDraft } = mounted.slots.get('sidebar.right.pane.tab').definition.inject('session-1');
  const draft = getAnnotationDraft(pending);
  assert.equal(draft.save(firstExcerpt, 'local note'), undefined);
  const withDraft = renderPlan(mounted, { resource });
  assert.doesNotMatch(withDraft, /<(?:p|li)[^>]+data-dbp-annotation-located/);
  assert.match(withDraft, /Reloading the page or ending the review discards unsent comments/);
  assert.ok(withDraft.includes('class="dbp-annotation-location" aria-label="Jump to plan block L3–L4">L3–L4</button>'));
  assert.match(renderPlan(mounted, { resource, lang: 'zh' }), /aria-label="跳到计划正文 L3–L4"/);
  assert.equal(await draft.submit(reviewOf(pending), () => reviewOf(pending)), 'failed');
  const failed = renderPlan(mounted, { resource });
  assert.match(failed, /data-tone="error">Could not send the comments/);
  assert.match(failed, /local note/);
  for (const args of [{ address: 'dsh-resource://plan/session-1/old-call', resource }, { resource, visible: false },
    { resource, sessionId: 'session-2' }, { address: child, resource, sessionId: 'parent' },
    { address: temp, params: { planReview: resource.value } }, { resource: { status: 'failed' } }]) {
    assert.doesNotMatch(renderPlan(mounted, args), panel);
  }
  pending.setCard({ channel: 'none', closed: false });
  assert.doesNotMatch(renderPlan(mounted, { resource }), panel);
  pending.setCard({ channel: 'waterfall', closed: true });
  const expired = renderPlan(mounted, { resource });
  assert.doesNotMatch(expired, panel);
  assert.doesNotMatch(expired, /<button[^>]+class="dbp-annotation-(?:at-selection|location)"/);
  assert.doesNotMatch(renderPlan(mount(), { resource }), panel);

  // Ensure pending.snapshot/subscribe retain `this === pending` when implemented as methods.
  const methodPending = {
    _card: { channel: 'waterfall', closed: false },
    kind: 'plan-review', key: 'method-key', sessionId: 'session-1',
    questions: [{ id: 'plan-review', detail: planMarkdown, intent: { kind: 'plan-review', approve: 'Approve', callId: 'call:1' },
      options: [{ label: 'Approve' }, { label: 'Keep planning' }] }],
    snapshot() { return this._card; },
    subscribe() { return this._unsub; },
    _unsub: () => {},
    answer: async () => {},
  };
  const methodMounted = mount({ sessionStatus: { subscribe: () => () => {},
    getSnapshot: () => new Map([['session-1', { pendingInteraction: methodPending }]]) } });
  assert.match(renderPlan(methodMounted, { resource }), panel);
});

test('renders long GFM and filters HTML, untrusted links and automatic image fetches', () => {
  const m = mount();
  const markdown = [
    '# Example', '', '> Review this approach.', '', '| Step | Result |', '| --- | --- |', '| One | Ready |', '', '- [x] Review', '',
    '[Allowed file](./src/one.ts#L42)', '[External](https://example.com/)', '[Unsafe](javascript:alert%281%29)',
    '[Escaped](../secrets.md)', '![Diagram](https://example.com/track.png)', '',
    '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '', '~~~js', '<example>', '~~~', '', 'One &amp; two[^note].', '', '[^note]: A footnote.', '',
    ...Array.from({ length: 350 }, (_, index) => 'Paragraph ' + index + '\n'),
  ].join('\n');
  const resource = { status: 'live', value: { title: 'Example', markdown } };
  const html = renderPlan(m, { resource });
  for (const pattern of [/<h1>Example<\/h1>/, /<table>/, /<blockquote>/, /type="checkbox"/, /<pre tabindex="0"/, /&lt;example&gt;/, /Paragraph 349/, /<button type="button" class="dbp-file-link"[^>]+>Allowed file<\/button>/, /rel="noopener noreferrer"/]) assert.match(html, pattern);
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  assert.match(renderPlan(m, { resource, slotName: 'sidebar.right.pane.tab.title' }), /data-file-glyph="implementation_plan.md"/);
  assert.match(html, /Allowed file<\/button><span class="dbp-file-error" role="status"><\/span>/);
  const plain = renderPlan(m, { resource: { status: 'live', value: { title: 'Plain', markdown: '# Plain\n\n' + 'Text only.\n\n'.repeat(200) } } });
  assert.match(plain, /<section class="dbp-preview" tabindex="0" aria-label="Plain">/);
  assert.match(html, /One &amp; two/);
  const label = html.match(/aria-describedby="(dbp-[^"]+-footnote-label)"/)?.[1];
  assert.ok(label && html.includes('id="' + label + '"'));
  assert.doesNotMatch(html, /<img |<script|href="javascript:|track\.png|onerror=/i);
  assert.equal(m.touchedFiles.length, 0);
  const wrongSession = renderPlan(m, { resource, sessionId: 'different' });
  assert.doesNotMatch(wrongSession, /<button[^>]+>Allowed file/);
  assert.match(renderPlan(m, { address: temp, lang: 'zh', resource }), /此临时预览已过期/);
  assert.match(renderPlan(m, { address: temp, params: { planReview: { markdown: '# Review text', title: 'Review' } } }), /<h1>Review text<\/h1>/);
  assert.match(renderPlan(m, { resource: { status: 'loading' } }), /Loading plan/);
  assert.match(renderPlan(m, { resource: { status: 'failed' } }), /Could not read/);
});

test('renders plain headings and labeled callouts without flattening their Markdown', () => {
  const m = mount();
  const tones = ['note', 'tip', 'important', 'warning', 'caution'];
  const markdown = [
    '## User Review Required', '',
    ...tones.map(tone => '> [!' + tone.toUpperCase() + ']\n> **Check** the result.\n'),
    '> [!CAUTION]', '>', '> 1. Use ' + '\u0060demo.ts\u0060' + '.', '',
    '> [!NOTE] Same line.', '',
    '> [!TIP]  ', '> **Hard break** follows.', '',
    '> Quoted [!WARNING] is not an alert.', '', '> [!UNKNOWN] stays ordinary.',
  ].join('\n');
  // Check callout structure independent of the separately tested source anchors.
  const html = renderPlan(m, { resource: { status: 'live', value: { title: 'Example', markdown } } })
    .replace(/ data-dbp-plan-lines="\d+:\d+"/g, '');
  assert.match(html, /<article class="dbp-document"><h2>User Review Required<\/h2>/);
  assert.doesNotMatch(html, /dbp-(paper|kicker)|(?:radial|linear)-gradient\(/);
  for (const tone of tones) {
    assert.ok(html.includes('<blockquote data-tone="' + tone + '">\n<p class="dbp-callout-label">' + tone.toUpperCase() + '</p>\n<p><strong>Check</strong> the result.</p>'), tone);
  }
  assert.match(html, /<p class="dbp-callout-label">CAUTION<\/p>\s*<ol>\s*<li>Use <code>demo\.ts<\/code>\.<\/li>/);
  assert.match(html, /<p class="dbp-callout-label">NOTE<\/p>\s*<p>Same line\.<\/p>/);
  assert.match(html, /<p class="dbp-callout-label">TIP<\/p>\s*<p><strong>Hard break<\/strong> follows\.<\/p>/);
  assert.doesNotMatch(html, /\[!CAUTION\]/);
  assert.equal((html.match(/<blockquote>/g) ?? []).length, 2);
});
