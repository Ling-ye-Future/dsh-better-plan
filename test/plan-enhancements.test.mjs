import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Config, apply as applyHost } from '../index.js';
import {
  PLAN_GUIDANCE_SECTION,
  applyPlanGuidance,
  buildPlanGuidance,
  isPlanModeActive,
} from '../src/plan-guidance.js';
import { fileSession, parsePlanAddress, planLink } from '../src/plan-data.js';
import { annotationLimits, normalizePlanRange, readPlanSelection, selectionPopupPosition } from '../src/plan-annotations.js';
import { extractLanguageFromClassName, hasMermaidFence, isMermaidLanguage } from '../src/mermaid-blocks.js';
import { sanitizeSvg } from '../src/mermaid-sanitize.js';
import { acceptFrameMessage, renderMermaidDiagram, resetMermaidFrameForTests, setMermaidFrameRendererForTests } from '../src/mermaid-frame.js';

const require = createRequire(import.meta.url);
const enLocale = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
const zhLocale = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));

async function loadBundledModule(relativePath, { externals, onAsync } = {}) {
  const code = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  let registered;
  const asyncRequests = [];
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry;
      },
    },
  };
  const customRequire = (name) => {
    if (externals && Object.hasOwn(externals, name)) return externals[name];
    throw new Error(`Unexpected external import: ${name}`);
  };
  customRequire.async = (spec) => {
    asyncRequests.push(spec);
    if (onAsync) return onAsync(spec);
    return Promise.reject(new Error(`Unexpected async chunk load: ${spec}`));
  };
  runInNewContext(code, {
    window,
    globalThis: globalThis,
    URL,
    setTimeout,
    clearTimeout,
    console,
  });
  assert.ok(registered, `Bundle ${relativePath} should register via __ModuleLoader__.load`);
  const mod = registered.factory(customRequire);
  return { mod, registered, asyncRequests };
}

function createMockMount({ lang = 'en', sessions, tabOverrides = {} } = {}) {
  const slots = new Map();
  const dictionaries = new Map();
  let registeredTab;
  const disposers = [];
  const localeMap = lang === 'zh' ? zhLocale.ui : enLocale.ui;

  const betterSidebar = {
    version: '0.32.1',
    fileIcon: (name) => `icon:${name}`,
    openFileCalls: [],
    openFile(scope, path, title, opts) {
      this.openFileCalls.push({ scope, path, title, opts });
    },
  };

  const scope = {
    betterSidebar,
    sessions,
    uiSession: {},
    get(key) {
      return key === 'sessions' ? sessions : undefined;
    },
    locale: {
      register(ns, map) {
        dictionaries.set(ns, map);
        return () => dictionaries.delete(ns);
      },
      bind(ns) {
        return (key) => dictionaries.get(ns)?.[lang]?.[key] ?? localeMap[key] ?? key;
      },
    },
    slots: {
      inject(slotName, factory) {
        const entry = factory();
        slots.set(slotName, entry);
        return () => slots.delete(slotName);
      },
      register(meta, Component) {
        return { meta, Component };
      },
    },
    sidebarRightTabs: {
      get: (kind) => (kind === 'plan' ? { id: '@deepseek-ai/dsh-client-ui-plan' } : undefined),
      subscribe: () => () => {},
      register(def) {
        registeredTab = def;
        return () => { registeredTab = undefined; };
      },
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  return {
    scope,
    slots,
    dictionaries,
    getRegisteredTab: () => registeredTab,
    betterSidebar,
    render({ markdown, title = 'Plan', address = 'dsh-resource://plan/session-1/call-1', seatSessionId = 'session-1', params } = {}) {
      const bodyEntry = slots.get('sidebar.right.pane.tab');
      const titleEntry = slots.get('sidebar.right.pane.tab.title');
      assert.ok(bodyEntry && titleEntry, 'Body and title slots must be registered');
      const t = scope.locale.bind('betterPlan');
      const hooks = {
        useTabInfo: () => ({
          tab: {
            title,
            navigation: { address, params },
            ...tabOverrides,
          },
        }),
        useResource: (reqAddr) => (
          reqAddr
            ? { status: 'live', value: { title, markdown } }
            : { status: 'idle' }
        ),
      };
      const bodyProps = {
        ...hooks,
        t,
        ...bodyEntry.meta.inject(seatSessionId),
      };
      const titleProps = {
        ...hooks,
        t,
        ...titleEntry.meta.inject(seatSessionId),
      };
      return {
        bodyHtml: renderToStaticMarkup(React.createElement(bodyEntry.Component, bodyProps)),
        titleHtml: renderToStaticMarkup(React.createElement(titleEntry.Component, titleProps)),
      };
    },
  };
}

test('planLink resolves workspace-contained file:// URLs, absolute paths, and line ranges safely', () => {
  const winCwd = 'D:\\work\\repo';
  const posixCwd = '/srv/projects/repo';

  assert.deepEqual(
    planLink('file:///d:/work/repo/src/auth.ts#L12-L34', { cwd: winCwd }),
    { kind: 'file', path: 'src/auth.ts', line: 12, lineEnd: 34 },
  );
  assert.deepEqual(
    planLink('file://localhost/D:/work/repo/README.md#L5', { cwd: winCwd }),
    { kind: 'file', path: 'README.md', line: 5 },
  );
  assert.deepEqual(
    planLink('D:/work/repo/src/index.js#L1-L9', { cwd: winCwd }),
    { kind: 'file', path: 'src/index.js', line: 1, lineEnd: 9 },
  );
  assert.deepEqual(
    planLink('/srv/projects/repo/cmd/main.go#L40-L88', { cwd: posixCwd }),
    { kind: 'file', path: 'cmd/main.go', line: 40, lineEnd: 88 },
  );
  assert.deepEqual(
    planLink('src/app.ts#L7-L15'),
    { kind: 'file', path: 'src/app.ts', line: 7, lineEnd: 15 },
  );
  assert.deepEqual(
    planLink('././src/app.ts#L3'),
    { kind: 'file', path: 'src/app.ts', line: 3 },
  );
  assert.deepEqual(
    planLink('src/./app.ts#L3'),
    { kind: 'file', path: 'src/app.ts', line: 3 },
  );
  assert.equal(planLink('./'), undefined);
  assert.equal(planLink('src/'), undefined);

  // Security rejections: reversed lines, outside cwd, prefix spoofing, remote host, smuggling, devices.
  assert.equal(planLink('src/app.ts#L15-L7'), undefined);
  assert.equal(planLink('src/app.ts#L0-L7'), undefined);
  assert.equal(planLink('file:///d:/work/other/secret.ts', { cwd: winCwd }), undefined);
  assert.equal(planLink('file:///d:/work/repo2/secret.ts', { cwd: winCwd }), undefined);
  assert.equal(planLink('file:///d:/work/repo', { cwd: winCwd }), undefined);
  assert.equal(planLink('file:///d:/work/repo/../other/a.ts', { cwd: winCwd }), undefined);
  assert.equal(planLink('file://attacker/d:/work/repo/a.ts', { cwd: winCwd }), undefined);
  assert.equal(planLink('file:///d:/work/repo/a%2Fb.ts', { cwd: winCwd }), undefined);
  assert.equal(planLink('file:///d:/work/repo/CON.txt', { cwd: winCwd }), undefined);
  assert.equal(planLink('/srv/projects/other/main.go', { cwd: posixCwd }), undefined);
  assert.equal(planLink('file:///d:/work/repo/src/auth.ts'), undefined);
});

test('host plugin injects tiered Antigravity structure guidance only while Plan Mode is active', () => {
  const defaultConfig = Config();
  assert.equal(defaultConfig.planGuidance.get(), true);
  assert.equal(defaultConfig.customGuidance.get(), '');

  // Inactive when plan:policy is absent or blank.
  assert.equal(isPlanModeActive({ sections: [{ name: 'core:identity', text: 'hi' }] }), false);
  assert.equal(isPlanModeActive({ sections: [{ name: 'plan:policy', text: '   \n ' }] }), false);

  const nonPlanAssembly = { sections: [{ name: 'core:identity', text: 'hello' }] };
  assert.equal(applyPlanGuidance(nonPlanAssembly, { enabled: true }), false);
  assert.equal(nonPlanAssembly.sections.length, 1);

  // Active host hook with volatile toggle + custom guidance.
  let enabled = true;
  let custom = 'Always list rollback commands.';
  let listener;
  let disposed = false;

  const ctx = {
    inject(deps, cb) {
      assert.deepEqual(deps, ['systemPrompt']);
      cb({
        on(event, fn) {
          assert.equal(event, 'system-prompt/assemble');
          listener = fn;
          return () => { disposed = true; };
        },
        effect(factory) {
          return factory();
        },
      });
    },
  };

  applyHost(ctx, {
    planGuidance: { get: () => enabled },
    customGuidance: { get: () => custom },
  });
  assert.ok(listener, 'Host plugin should subscribe to system-prompt/assemble');

  const planAssembly = {
    sections: [
      { name: 'core:identity', text: 'DSH' },
      { name: 'plan:policy', text: 'Plan mode policy rules' },
      { name: 'tools:list', text: 'Tools' },
    ],
  };

  let nextCalled = false;
  listener(planAssembly, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(planAssembly.sections.length, 4);
  assert.equal(planAssembly.sections[2].name, PLAN_GUIDANCE_SECTION);
  assert.match(planAssembly.sections[2].text, /L0/);
  assert.match(planAssembly.sections[2].text, /L1\/L2/);
  assert.match(planAssembly.sections[2].text, /Goal Description/);
  assert.match(planAssembly.sections[2].text, /\[NEW\]/);
  assert.match(planAssembly.sections[2].text, /Verification Plan/);
  assert.match(planAssembly.sections[2].text, /Always list rollback commands\./);

  // Idempotent on repeated pass.
  listener(planAssembly, {}, () => {});
  assert.equal(planAssembly.sections.length, 4);

  // Disabled via volatile config toggle does not inject on fresh assemblies.
  enabled = false;
  const disabledAssembly = { sections: [{ name: 'plan:policy', text: 'Plan mode active' }] };
  listener(disabledAssembly, {}, () => {});
  assert.equal(disabledAssembly.sections.length, 1);

  // Build output truncation check.
  const built = buildPlanGuidance('   ');
  assert.equal(built.includes('Project-specific'), false);
  assert.equal(disposed, false);
});

test('client renders action badges, syntax highlighting, KaTeX formulas, and workspace cwd links', async () => {
  const { mod, asyncRequests } = await loadBundledModule('../lib/client.js', {
    externals: { react: React, 'react/jsx-runtime': JsxRuntime },
  });

  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          'session-1': { cwd: 'D:\\work\\repo' },
        },
      }),
    },
  };

  const mounted = createMockMount({ lang: 'en', sessions });
  mod.apply({
    inject: (_deps, fn) => fn(mounted.scope),
  });

  const md = [
    '# [NEW] Implement Planner Renderer',
    '',
    '[MODIFY] Update [handler](file:///d:/work/repo/src/handler.ts#L10-L24), [upper](FILE:///d:/work/repo/src/upper.ts#L2), and [docs](D:/work/repo/README.md#L3).',
    '',
    '[DELETE] Keep inline literal `[DELETE]` unbadged, block [escape](file:///d:/outside/secret.ts).',
    '',
    'Inline formula $E = mc^2$ and CJK $\\text{延迟} < 10\\text{ms}$.',
    '',
    '$$',
    '\\sum_{i=1}^{n} x_i = S_n',
    '$$',
    '',
    '```ts',
    'export function greet(name: string) {',
    '  return `hi ${name}`;',
    '}',
    '```',
    '',
    '```',
    'plain block',
    '```',
  ].join('\n');

  const { bodyHtml, titleHtml } = mounted.render({ markdown: md, title: 'Demo Plan' });

  // Title preserves Better Sidebar fileIcon integration.
  assert.match(titleHtml, /Demo Plan/);

  // Non-Mermaid plan never touches mermaid chunk loader.
  assert.equal(asyncRequests.length, 0);

  // Action badges render cleanly while inline code literal stays plain code.
  assert.match(bodyHtml, /<span class="dbp-action-badge" data-action="new">NEW<\/span>/);
  assert.match(bodyHtml, /<span class="dbp-action-badge" data-action="modify">MODIFY<\/span>/);
  assert.match(bodyHtml, /<span class="dbp-action-badge" data-action="delete">DELETE<\/span>/);
  assert.match(bodyHtml, /<code>\[DELETE\]<\/code>/);

  // Syntax highlighting + code header UI.
  assert.match(bodyHtml, /class="dbp-code-block"/);
  assert.match(bodyHtml, /<span class="dbp-code-lang">ts<\/span>/);
  assert.match(bodyHtml, /class="hljs-keyword"/);
  assert.match(bodyHtml, />Wrap<\/button>/);
  assert.match(bodyHtml, />Copy<\/button>/);
  assert.match(bodyHtml, /<span class="dbp-code-lang">Code<\/span>/);

  // KaTeX math rendering + scoped CSS woff2 embedding.
  assert.match(bodyHtml, /class="katex"/);
  assert.match(bodyHtml, /class="katex-display"/);
  assert.doesNotMatch(bodyHtml, /class="katex-error"/);
  assert.match(bodyHtml, /data:font\/woff2;base64,/);
  assert.match(bodyHtml, /\.dbp-preview\{counter-reset:katexEqnNo mmlEqnNo\}/);
  assert.doesNotMatch(bodyHtml, /format\("woff"\)|format\("truetype"\)/);
  assert.doesNotMatch(bodyHtml, /(?:^|\})body\{/);

  // Workspace-contained file:// & absolute links become buttons, escapes become inert spans.
  assert.match(bodyHtml, /<button type="button" class="dbp-file-link" title="src\/handler\.ts#L10-L24">handler<\/button>/);
  assert.match(bodyHtml, /<button type="button" class="dbp-file-link" title="src\/upper\.ts#L2">upper<\/button>/);
  assert.match(bodyHtml, /<button type="button" class="dbp-file-link" title="README\.md#L3">docs<\/button>/);
  assert.match(bodyHtml, /<span>escape<\/span>/);

  // Subagent & temporary plan-review tabs never use session cwd even if sessions store has cwd.
  const reviewRender = mounted.render({
    address: 'dsh-resource://plan-review/session-1/req-1',
    params: { planReview: { title: 'Review', markdown: '[handler](file:///d:/work/repo/src/handler.ts#L1)' } },
  });
  assert.match(reviewRender.bodyHtml, /<span>handler<\/span>/);

  const subagentRender = mounted.render({
    address: 'dsh-resource://plan/subagent/session-1/child-1/one-shot/call-2',
    markdown: '[handler](file:///d:/work/repo/src/handler.ts#L1)',
  });
  assert.match(subagentRender.bodyHtml, /<span>handler<\/span>/);
});

test('Mermaid blocks stay lazy-loaded in client.js and render cleanly via client.mermaid.js chunk', async () => {
  const { mod: clientMod, asyncRequests } = await loadBundledModule('../lib/client.js', {
    externals: { react: React, 'react/jsx-runtime': JsxRuntime },
  });
  const mounted = createMockMount({ lang: 'zh' });
  clientMod.apply({ inject: (_deps, fn) => fn(mounted.scope) });

  const mermaidMd = [
    '```mermaid',
    'graph TD',
    '  Start --> Done',
    '```',
  ].join('\n');

  // Without sync test seam, SSR leaves pending card and never eagerly fetches chunk during SSR.
  const pending = mounted.render({ markdown: mermaidMd });
  assert.match(pending.bodyHtml, /class="dbp-mermaid-card"/);
  assert.match(pending.bodyHtml, /正在渲染图表/);
  assert.match(pending.bodyHtml, /Start --&gt; Done/);
  assert.equal(asyncRequests.length, 0);

  // Verify real lazy chunk `lib/client.mermaid.js` registers cleanly with chunk metadata & ReactDOM external.
  const { mod: mermaidMod, registered } = await loadBundledModule('../lib/client.mermaid.js', {
    externals: { react: React, 'react/jsx-runtime': JsxRuntime, 'react-dom': ReactDom },
  });
  assert.equal(registered.chunk, 'client.mermaid.js');
  assert.equal(typeof mermaidMod.MermaidBlock, 'function');

  // Verify inlined Mermaid iframe HTML inside client.mermaid.js contains no unescaped </script> breakouts.
  const mermaidBundleSource = await readFile(new URL('../lib/client.mermaid.js', import.meta.url), 'utf8');
  assert.match(mermaidBundleSource, /mermaid-frame-ready/);
  assert.doesNotMatch(mermaidBundleSource, /<script>[\s\S]*<\/script>[\s\S]*<\/script><\/body>/);

  // Mount MermaidBlock through client's test seam and verify full zh-CN Mermaid UI renders.
  globalThis.__dshBetterPlanTestMermaid = mermaidMod;
  try {
    const active = mounted.render({ markdown: mermaidMd });
    assert.match(active.bodyHtml, /data-mermaid-block/);
    assert.match(active.bodyHtml, />图形<\/button>/);
    assert.match(active.bodyHtml, />源码<\/button>/);
    assert.match(active.bodyHtml, />复制<\/button>/);
  } finally {
    delete globalThis.__dshBetterPlanTestMermaid;
  }

  // Verify helpers for Mermaid detection, frame message validation, and SVG sanitization.
  assert.equal(isMermaidLanguage('mermaid'), true);
  assert.equal(isMermaidLanguage('MERMAIDJS'), true);
  assert.equal(isMermaidLanguage('mmd'), true);
  assert.equal(isMermaidLanguage('typescript'), false);
  assert.equal(extractLanguageFromClassName('hljs language-mermaid'), 'mermaid');
  assert.equal(hasMermaidFence('```mmd\nA-->B\n```'), true);
  assert.equal(hasMermaidFence('```ts\nconst mermaid = 1;\n```'), false);

  const fakeWin = { postMessage() {} };
  assert.deepEqual(
    acceptFrameMessage({ source: fakeWin, origin: 'null', data: { type: 'mermaid-result', id: 1, svg: '<svg/>' } }, fakeWin),
    { kind: 'result', id: 1, svg: '<svg/>' },
  );
  assert.equal(
    acceptFrameMessage({ source: fakeWin, origin: 'https://evil.example', data: { type: 'mermaid-result', id: 1, svg: '<svg/>' } }, fakeWin),
    null,
  );

  // Test renderMermaidDiagram seam + clean up.
  setMermaidFrameRendererForTests((code, theme) => `<svg data-theme="${theme}"><text>${code}</text></svg>`);
  try {
    const out = await renderMermaidDiagram('A-->B', 'dark');
    assert.match(out, /data-theme="dark"/);
  } finally {
    resetMermaidFrameForTests();
  }

  // Verify concurrent frame failure recovery and no permanent lockup after transient failures.
  const prevGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    html: globalThis.__MERMAID_FRAME_HTML__,
  };
  const listeners = new Set();
  let frameSeq = 0;
  let forceTimeoutOnce = true;
  const dispatchMessage = (event) => {
    for (const fn of [...listeners]) fn(event);
  };
  globalThis.__MERMAID_FRAME_HTML__ = '<html></html>';
  globalThis.Blob = class MockBlob {};
  globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };
  globalThis.window = {
    setTimeout(fn, delay) {
      if (delay >= 30_000 && forceTimeoutOnce) {
        forceTimeoutOnce = false;
        return setTimeout(fn, 0);
      }
      return setTimeout(fn, delay);
    },
    clearTimeout,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
  };
  globalThis.document = {
    body: {
      appendChild(iframe) {
        const mySeq = ++frameSeq;
        const win = {
          postMessage(msg) {
            // Keep mySeq 1 silent for the first request so its render timer fires while request 2 is also pending.
            if (mySeq === 1) return;
            queueMicrotask(() => {
              dispatchMessage({ source: win, origin: 'null', data: { type: 'mermaid-result', id: msg.id, svg: `<svg data-seq="${mySeq}">${msg.code}</svg>` } });
            });
          },
        };
        iframe.contentWindow = win;
        queueMicrotask(() => {
          dispatchMessage({ source: win, origin: 'null', data: { type: 'mermaid-frame-ready' } });
        });
      },
    },
    createElement() {
      return { setAttribute() {}, remove() {}, style: {} };
    },
  };
  try {
    const [r1, r2] = await Promise.all([
      renderMermaidDiagram('A-->B', 'default'),
      renderMermaidDiagram('C-->D', 'default'),
    ]);
    assert.match(r1, /<svg data-seq="2">A-->B<\/svg>/);
    assert.match(r2, /<svg data-seq="2">C-->D<\/svg>/);
    assert.equal(frameSeq, 2);

    // Exhaust retries for one call, then verify a later call still recovers cleanly.
    resetMermaidFrameForTests();
    const origAppend = globalThis.document.body.appendChild;
    let blockFrame = true;
    globalThis.document.body.appendChild = (iframe) => {
      if (!blockFrame) return origAppend(iframe);
      const win = {};
      iframe.contentWindow = win;
      queueMicrotask(() => {
        dispatchMessage({ source: win, origin: 'null', data: { type: 'mermaid-frame-ready' } });
        iframe.contentWindow = null;
      });
    };
    await assert.rejects(() => renderMermaidDiagram('X-->Y', 'default'), /mermaid frame unavailable/);
    blockFrame = false;
    const recovered = await renderMermaidDiagram('E-->F', 'default');
    assert.match(recovered, /<svg[^>]*>E-->F<\/svg>/);
  } finally {
    resetMermaidFrameForTests();
    globalThis.window = prevGlobals.window;
    globalThis.document = prevGlobals.document;
    globalThis.Blob = prevGlobals.Blob;
    globalThis.URL = prevGlobals.URL;
    globalThis.__MERMAID_FRAME_HTML__ = prevGlobals.html;
  }
});

test('sanitizeSvg fails closed without XML DOM and strips active content with XML DOM', () => {
  // Without DOMParser/XMLSerializer (bare SSR), sanitizeSvg fails closed.
  assert.equal(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>Safe</text></svg>'), '');

  const buildMockDom = () => {
    class MockEl {
      constructor(localName, attributes = {}, children = [], textContent = '') {
        this.localName = localName;
        this._attrs = new Map(Object.entries(attributes));
        this.children = children;
        this.textContent = textContent;
        this.parent = null;
        for (const child of children) child.parent = this;
      }
      get attributes() {
        return [...this._attrs.entries()].map(([name, value]) => ({ name, value }));
      }
      removeAttribute(name) { this._attrs.delete(name); }
      setAttribute(name, value) { this._attrs.set(name, String(value)); }
      remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(c => c !== this);
      }
      walk(out = []) {
        out.push(this);
        for (const child of this.children) child.walk(out);
        return out;
      }
      serialize() {
        const attrs = [...this._attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join('');
        const inner = this.children.length ? this.children.map(c => c.serialize()).join('') : this.textContent;
        return `<${this.localName}${attrs}>${inner}</${this.localName}>`;
      }
    }

    const prevParser = globalThis.DOMParser;
    const prevSerializer = globalThis.XMLSerializer;
    globalThis.DOMParser = class {
      parseFromString(input) {
        if (!input.includes('<svg')) {
          const root = new MockEl('div');
          return { documentElement: root, querySelector: () => null, querySelectorAll: () => root.walk() };
        }
        const styleEl = new MockEl('style', {}, [], '/*c*/@\\69mport "https://evil.test/x.css"; .a { background: u\\72l(https://evil.test/p.png); marker-end: url(#arrow); } #id\\:1 { fill: red; }');
        const scriptEl = new MockEl('script', {}, [], 'alert(1)');
        const foreignEl = new MockEl('foreignObject', { width: '10' }, [new MockEl('div', {}, [], 'xss')]);
        const imageEl = new MockEl('image', { href: 'https://evil.test/i.png' });
        const setEl = new MockEl('set', { attributeName: 'href', to: 'javascript:alert(3)' });
        const pathEl = new MockEl('path', { d: 'M0 0L10 10', style: 'background:url(http://evil.test/1)' });
        const linkEl = new MockEl('a', { href: 'javascript:alert(2)', 'xlink:href': 'https://evil.test/' }, [pathEl]);
        const rectEl = new MockEl('rect', { width: '10', onclick: 'steal()' });
        const textEl = new MockEl('text', {}, [], 'Safe');
        const gEl = new MockEl('g', {}, [rectEl, textEl]);
        const root = new MockEl('svg', { xmlns: 'http://www.w3.org/2000/svg', onload: 'alert(1)' }, [styleEl, scriptEl, foreignEl, imageEl, setEl, linkEl, gEl]);
        return {
          documentElement: root,
          querySelector: () => null,
          querySelectorAll: () => root.walk(),
        };
      }
    };
    globalThis.XMLSerializer = class {
      serializeToString(el) { return el.serialize(); }
    };
    return () => {
      globalThis.DOMParser = prevParser;
      globalThis.XMLSerializer = prevSerializer;
    };
  };

  const restore = buildMockDom();
  try {
    const cleaned = sanitizeSvg('<svg><rect/></svg>');
    assert.ok(cleaned.startsWith('<svg'));
    assert.doesNotMatch(cleaned, /<script|foreignObject|<image\b|<set\b|onload=|onclick=|javascript:|evil\.test|@import|@\\69mport/i);
    assert.match(cleaned, /url\(#arrow\)/);
    assert.match(cleaned, /#id\\:1/);
    assert.match(cleaned, /<text>Safe<\/text>/);
    assert.equal(sanitizeSvg('<div>not svg</div>'), '');
  } finally {
    restore();
  }
});

test('distribution files, manifest, and third-party notices match offline bundle contract', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/schemastery']);
  for (const requiredFile of ['index.js', 'lib/index.js', 'lib/client.js', 'lib/client.mermaid.js', 'lib/THIRD-PARTY-NOTICES.txt']) {
    assert.ok(pkg.files.includes(requiredFile), `package.json files missing ${requiredFile}`);
  }
  const notices = await readFile(new URL('../lib/THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');
  for (const dep of ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex', 'katex', 'rehype-highlight', 'lowlight', 'mermaid']) {
    assert.ok(notices.includes(dep + '@'), `THIRD-PARTY-NOTICES.txt missing ${dep}`);
  }
  assert.equal(parsePlanAddress('dsh-resource://plan/s1/c1')?.kind, 'plan');
  assert.equal(fileSession(parsePlanAddress('dsh-resource://plan/s1/c1'), 's1'), 's1');
});

function createFakeDomHarness() {
  class FakeNode extends EventTarget {
    constructor(nodeType, ownerDocument) {
      super();
      this.nodeType = nodeType;
      this.ownerDocument = ownerDocument;
      this.childNodes = [];
      this.parentNode = null;
    }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
    }
    get previousSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const idx = this.childNodes.indexOf(ref);
      child.parentNode = this;
      this.childNodes.splice(idx < 0 ? this.childNodes.length : idx, 0, child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) this.childNodes.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
    contains(node) {
      let cur = node;
      while (cur) { if (cur === this) return true; cur = cur.parentNode; }
      return false;
    }
    compareDocumentPosition(other) {
      if (this === other) return 0;
      if (other.contains?.(this)) return 10;
      if (this.contains(other)) return 20;
      let root = this;
      while (root.parentNode) root = root.parentNode;
      const order = [];
      const walk = (n) => { order.push(n); for (const c of n.childNodes) walk(c); };
      walk(root);
      const a = order.indexOf(this);
      const b = order.indexOf(other);
      if (a < 0 || b < 0) return 1;
      return a < b ? 4 : 2;
    }
  }

  class FakeText extends FakeNode {
    constructor(text, doc) { super(3, doc); this.nodeValue = String(text); }
    get length() { return this.nodeValue.length; }
  }

  class FakeElement extends FakeNode {
    constructor(tagName, doc) {
      super(1, doc);
      this.tagName = tagName.toUpperCase();
      this.localName = tagName.toLowerCase();
      this.attributesMap = new Map();
      this.style = {};
      this.dataset = {};
      this.tabIndex = 0;
      this.clientLeft = 0;
      this.clientTop = 0;
    }
    setAttribute(k, v) {
      this.attributesMap.set(k, String(v));
      if (k.startsWith('data-')) {
        this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
      }
    }
    getAttribute(k) { return this.attributesMap.get(k) ?? null; }
    removeAttribute(k) {
      this.attributesMap.delete(k);
      if (k.startsWith('data-')) {
        delete this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      }
    }
    set className(v) { this.setAttribute('class', v); }
    get className() { return this.getAttribute('class') ?? ''; }
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = v ? [new FakeText(v, this.ownerDocument)] : [];
      if (this.childNodes[0]) this.childNodes[0].parentNode = this;
    }
    get textContent() { return this.childNodes.map(c => c.nodeType === 3 ? c.nodeValue : (c.textContent ?? '')).join(''); }
    get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    get clientWidth() { return this.className.includes('dbp-preview') ? 380 : 0; }
    get clientHeight() { return this.className.includes('dbp-preview') ? 600 : 0; }
    matchesSimple(part) {
      let rest = part;
      const tagMatch = rest.match(/^[a-z0-9]+/i);
      if (tagMatch) {
        if (this.localName !== tagMatch[0].toLowerCase()) return false;
        rest = rest.slice(tagMatch[0].length);
      }
      if (rest.includes('[data-dbp-plan-lines]')) {
        if (this.dataset.dbpPlanLines === undefined) return false;
        rest = rest.replace('[data-dbp-plan-lines]', '');
      }
      if (rest.includes(':not(:empty)')) {
        if (this.textContent === '') return false;
        rest = rest.replace(':not(:empty)', '');
      }
      const classes = rest.match(/\.[a-z0-9_-]+/gi) ?? [];
      rest = rest.replace(/\.[a-z0-9_-]+/gi, '');
      if (rest !== '') return false;
      const own = this.className.split(/\s+/);
      return classes.every(c => own.includes(c.slice(1)));
    }
    matches(selector) {
      return selector.split(',').some(raw => {
        const parts = raw.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0 || !this.matchesSimple(parts[parts.length - 1])) return false;
        let cur = this.parentElement;
        for (let i = parts.length - 2; i >= 0; i--) {
          while (cur && !cur.matchesSimple(parts[i])) cur = cur.parentElement;
          if (!cur) return false;
          cur = cur.parentElement;
        }
        return true;
      });
    }
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) { if (cur.matches(selector)) return cur; cur = cur.parentElement; }
      return null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 1) { if (c.matches(selector)) out.push(c); walk(c); }
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() {
      if (this._rect) return this._rect;
      if (this.className.includes('dbp-preview')) return { left: 0, top: 0, right: 380, bottom: 600, width: 380, height: 600 };
      if (this.className.includes('dbp-annotations')) return { left: 0, top: 0, right: 380, bottom: 72, width: 380, height: 72 };
      if (this.className.includes('dbp-annotation-at-selection')) return { left: 0, top: 0, right: 120, bottom: 28, width: 120, height: 28 };
      return { left: 16, top: 120, right: 240, bottom: 140, width: 224, height: 20 };
    }
    focus() {}
    click() { this.dispatchEvent(Object.assign(new Event('click', { bubbles: true }), { button: 0 })); }
  }

  class FakeDoc extends EventTarget {
    constructor() {
      super();
      this.nodeType = 9;
      this._selection = null;
      this.defaultView = new EventTarget();
      this.defaultView.innerWidth = 400;
      this.defaultView.innerHeight = 600;
      this.defaultView.document = this;
      this.defaultView.Node = FakeNode;
      this.defaultView.Element = FakeElement;
      this.defaultView.HTMLElement = FakeElement;
      this.defaultView.HTMLIFrameElement = class HTMLIFrameElement extends FakeElement {};
      this.body = new FakeElement('body', this);
    }
    createElement(tag) { return new FakeElement(tag, this); }
    createTextNode(t) { return new FakeText(t, this); }
    createElementNS(_ns, tag) { return new FakeElement(tag, this); }
    getSelection() { return this._selection; }
  }

  function makeRange(startContainer, startOffset, endContainer, endOffset, { rects = [{ left: 20, top: 140, right: 190, bottom: 160, width: 170, height: 20 }], intersects } = {}) {
    const build = (sN, sO, eN, eO) => ({
      startContainer: sN, startOffset: sO, endContainer: eN, endOffset: eO,
      get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
      setStart(n, o) { this.startContainer = n; this.startOffset = o; },
      setStartBefore(n) { this.startContainer = n.parentNode; this.startOffset = n.parentNode.childNodes.indexOf(n); },
      setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
      setEndAfter(n) { this.endContainer = n.parentNode; this.endOffset = n.parentNode.childNodes.indexOf(n) + 1; },
      cloneRange() { return build(this.startContainer, this.startOffset, this.endContainer, this.endOffset); },
      toString() {
        const s = this.startContainer, so = this.startOffset, e = this.endContainer, eo = this.endOffset;
        if (s === e) {
          if (s.nodeType === 3) return s.nodeValue.slice(so, eo);
          return s.childNodes.slice(so, eo).map(c => c.nodeType === 3 ? c.nodeValue : c.textContent).join('');
        }
        let out = '';
        let root = s;
        while (root.parentNode) root = root.parentNode;
        let started = false;
        const walk = (node) => {
          if (node === s) {
            started = true;
            if (node.nodeType === 3) { out += node.nodeValue.slice(so); return false; }
          }
          if (node === e) {
            if (node.nodeType === 3 && started) out += node.nodeValue.slice(0, eo);
            return true;
          }
          if (node.nodeType === 3 && started) out += node.nodeValue;
          for (let i = (node === s ? so : 0); i < node.childNodes.length; i++) {
            if (node === e && i >= eo) return true;
            if (walk(node.childNodes[i])) return true;
          }
          return false;
        };
        walk(root);
        return out;
      },
      intersectsNode(node) {
        if (intersects) return intersects(node, this);
        const startRel = this.startContainer.compareDocumentPosition(node);
        const endRel = this.endContainer.compareDocumentPosition(node);
        const nodeContainsStart = node.contains(this.startContainer);
        const nodeContainsEnd = node.contains(this.endContainer);
        if (nodeContainsStart || nodeContainsEnd) return !(this.endContainer === node && this.endOffset === 0);
        return Boolean(startRel & 4) && Boolean(endRel & 2);
      },
      getClientRects: () => rects,
      getBoundingClientRect: () => rects[0] ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    });
    return build(startContainer, startOffset, endContainer, endOffset);
  }

  return { FakeDoc, FakeElement, FakeText, makeRange };
}

function withFakeBrowserGlobals(doc, fn) {
  const keys = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const prev = Object.fromEntries(keys.map(k => [k, globalThis[k]]));
  const proto = doc.body.constructor.prototype;
  const nodeProto = Object.getPrototypeOf(proto);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = doc.defaultView;
  globalThis.document = doc;
  globalThis.Node = nodeProto.constructor;
  globalThis.Element = proto.constructor;
  globalThis.HTMLElement = proto.constructor;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete globalThis[k];
      else globalThis[k] = prev[k];
    }
  }
}

test('normalizePlanRange, readPlanSelection, and selectionPopupPosition handle Chromium boundaries and clipped panes', () => {
  const { FakeDoc, makeRange } = createFakeDomHarness();
  const doc = new FakeDoc();
  const article = doc.createElement('article');
  const h1 = doc.createElement('h1');
  h1.textContent = 'Plan';
  const p0 = doc.createElement('p');
  p0.setAttribute('data-dbp-plan-lines', '2:2');
  const p0Text = doc.createTextNode('Clean paragraph.');
  p0.appendChild(p0Text);
  const nl0 = doc.createTextNode('\n');
  const h2 = doc.createElement('h2');
  const h2Text = doc.createTextNode('Section Two');
  h2.appendChild(h2Text);
  const p1 = doc.createElement('p');
  p1.setAttribute('data-dbp-plan-lines', '3:4');
  const p1Text = doc.createTextNode('First paragraph ');
  const katex = doc.createElement('span');
  katex.className = 'katex';
  const katexText = doc.createTextNode('x+1');
  katex.appendChild(katexText);
  p1.appendChild(p1Text);
  p1.appendChild(katex);
  const nl1 = doc.createTextNode('\n');
  const nl2 = doc.createTextNode('\n');
  const p2 = doc.createElement('p');
  p2.setAttribute('data-dbp-plan-lines', '8:8');
  const p2Text = doc.createTextNode('Second paragraph');
  p2.appendChild(p2Text);
  const pAfterClean = doc.createElement('p');
  pAfterClean.setAttribute('data-dbp-plan-lines', '9:9');
  const pAfterText = doc.createTextNode('Tail paragraph.');
  pAfterClean.appendChild(pAfterText);
  const pre = doc.createElement('pre');
  pre.textContent = 'const a = 1;';
  for (const child of [h1, p0, nl0, h2, p1, nl1, nl2, p2, pAfterClean, pre]) article.appendChild(child);

  const sel = range => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range });
  // Chromium triple-click / block-boundary endOffset === 0 ending at following heading, newline, or next block.
  for (const [endNode, endOffset] of [[h2, 0], [h2Text, 0], [nl0, 0]]) {
    assert.deepEqual(readPlanSelection(article, sel(makeRange(p0Text, 0, endNode, endOffset))),
      { anchor: { lineStart: 2, lineEnd: 2, quote: 'Clean paragraph.' } });
  }
  assert.deepEqual(readPlanSelection(article, sel(makeRange(p1Text, 0, katexText, 0))),
    { anchor: { lineStart: 3, lineEnd: 4, quote: 'First paragraph' } });
  // Selecting past p1 across embedded .katex to end at nl1 stays rejected.
  assert.equal(readPlanSelection(article, sel(makeRange(p1Text, 0, nl1, 0))).error, 'annotationSelectionInvalid');
  // Element boundary (article, index) and trailing startOffset === length both resolve cleanly.
  assert.deepEqual(readPlanSelection(article, sel(makeRange(nl2, 0, p2Text, 6))), { anchor: { lineStart: 8, lineEnd: 8, quote: 'Second' } });
  assert.deepEqual(readPlanSelection(article, sel(makeRange(p2Text, p2Text.length, pAfterText, 4))), { anchor: { lineStart: 9, lineEnd: 9, quote: 'Tail' } });
  assert.deepEqual(readPlanSelection(article, sel(makeRange(article, 7, article, 8))), { anchor: { lineStart: 8, lineEnd: 8, quote: 'Second paragraph' } });

  // Actual cross-block, heading, code-block, and formula intersections remain rejected.
  assert.equal(readPlanSelection(article, sel(makeRange(p1Text, 0, h2Text, 3))).error, 'annotationSelectionInvalid');
  assert.equal(readPlanSelection(article, sel(makeRange(p1Text, 0, p2Text, 2))).error, 'annotationSelectionInvalid');
  assert.equal(readPlanSelection(article, sel(makeRange(h1.firstChild, 0, h1.firstChild, 4))).error, 'annotationSelectionInvalid');
  assert.equal(readPlanSelection(article, sel(makeRange(pre.firstChild, 0, pre.firstChild, 5))).error, 'annotationSelectionInvalid');
  assert.equal(readPlanSelection(article, sel(makeRange(katexText, 0, katexText, 3))).error, 'annotationSelectionInvalid');
  assert.equal(typeof normalizePlanRange, 'function');

  // selectionPopupPosition clips scrolled multi-line selections and clamps viewport-filling boxes.
  const view = { left: 100, right: 390, top: 160, bottom: 520 };
  const btn = { width: 115, height: 30 };
  const multi = [
    { left: 120, right: 360, top: 120, bottom: 150, width: 240, height: 30 }, // scrolled under header
    { left: 120, right: 260, top: 180, bottom: 205, width: 140, height: 25 },
  ];
  assert.deepEqual(selectionPopupPosition(multi, view, btn), { left: 145, top: 211 });
  assert.deepEqual(selectionPopupPosition([{ left: 120, right: 350, top: 165, bottom: 515, width: 230, height: 350 }], view, btn), { left: 235, top: 484 });
  assert.equal(selectionPopupPosition([{ left: 120, right: 260, top: 110, bottom: 158, width: 140, height: 48 }], view, btn), undefined);
  assert.equal(selectionPopupPosition(multi, { ...view, right: 220 }, btn), undefined);
});

test('PlanBody binds the injected live session status and shows drag-stable floating prompts', async () => {
  const { mod } = await loadBundledModule('../lib/client.js', {
    externals: { react: React, 'react/jsx-runtime': JsxRuntime },
  });
  const markdown = '# Plan title\n\nAlpha paragraph.\n\n## Beta heading\n\n```js\nconst x = 1;\n```\n\nOmega paragraph.';
  const targetAddress = 'dsh-resource://plan/session-1/call%3A1';
  let cardState = { channel: 'waterfall', closed: false };
  const cardListeners = new Set();
  const pending = {
    kind: 'plan-review', key: 'req-key-1', sessionId: 'session-1',
    questions: [{ id: 'plan-review', detail: markdown, intent: { kind: 'plan-review', approve: 'Approve', callId: 'call:1' },
      options: [{ label: 'Approve' }, { label: 'Keep planning' }] }],
    subscribe: fn => { cardListeners.add(fn); return () => cardListeners.delete(fn); },
    snapshot: () => cardState,
    answer: async () => {},
  };
  let statusMap = new Map();
  const listeners = new Set();
  const sessionStatus = {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => statusMap,
  };
  const scope = {
    betterSidebar: { version: '0.32.1', fileIcon: () => 'file', openFile: () => {} },
    get uiSession() {
      // Cordis checks the exported service inject list, not the package manifest.
      if (!mod.inject.includes('uiSession')) throw new Error('cannot get property "uiSession" without inject');
      return { sessionStatus };
    },
    get: key => key === 'uiSession' ? { sessionStatus } : undefined,
    sidebarRightTabs: {
      get: k => k === 'plan' ? { id: '@deepseek-ai/dsh-client-ui-plan' } : undefined,
      subscribe: () => () => {},
      register: () => () => {},
    },
    locale: { register: () => () => {}, bind: () => key => key },
    effect: fn => fn(),
    inject: (_deps, fn) => fn(scope),
    slots: {
      slots: new Map(),
      inject: (_name, fn) => fn(),
      register(def, Comp) { this.slots.set(def.name, { def, Comp }); return () => this.slots.delete(def.name); },
    },
  };
  mod.apply(scope);
  const { def, Comp } = scope.slots.slots.get('sidebar.right.pane.tab');
  const injectedProps = def.inject('session-1');
  assert.equal(injectedProps.sessionStatus, sessionStatus);

  const { FakeDoc, makeRange } = createFakeDomHarness();
  const doc = new FakeDoc();
  withFakeBrowserGlobals(doc, () => {
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container);
    const commonProps = {
      ...injectedProps,
      useTabInfo: () => ({ tab: { title: 'Plan', visible: true, navigation: { address: targetAddress } } }),
      useResource: () => ({ status: 'live', value: { title: 'Plan title', markdown } }),
      t: key => enLocale.ui[key] ?? key,
    };

    // The preview may already be mounted before its review is published.
    act(() => { root.render(React.createElement(Comp, commonProps)); });
    const initialArticle = container.querySelector('.dbp-document');
    assert.ok(initialArticle);
    assert.equal(container.querySelector('.dbp-annotations'), null);

    act(() => {
      statusMap = new Map([['session-1', { pendingInteraction: pending }]]);
      for (const listener of [...listeners]) listener();
    });
    assert.equal(container.querySelector('.dbp-document'), initialArticle);
    assert.ok(container.querySelector('.dbp-annotations'), 'Toolbar follows the published review without remounting the plan');

    const article = container.querySelector('.dbp-document');
    const paras = article.querySelectorAll('p');
    const h2 = article.querySelector('h2');
    const pre = article.querySelector('pre');
    const alphaText = paras[0].firstChild;

    // 2. Drag deferral: selectionchange during active drag does not pop quote/button until pointerup.
    act(() => {
      article.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
      doc._selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => makeRange(alphaText, 0, alphaText, 5) };
      doc.dispatchEvent(new Event('selectionchange'));
    });
    assert.equal(container.querySelector('.dbp-annotation-at-selection'), null);
    assert.equal(container.querySelector('.dbp-annotation-quote'), null);

    act(() => { doc.dispatchEvent(Object.assign(new Event('pointerup', { bubbles: true }), { button: 0 })); });
    const addBtn = container.querySelector('button.dbp-annotation-at-selection');
    assert.ok(addBtn, 'Add annotation button should appear beside valid selection after pointerup');
    assert.equal(addBtn.textContent, enLocale.ui.annotationAdd);
    assert.ok(addBtn.style.left?.endsWith('px') && addBtn.style.top?.endsWith('px'));
    assert.equal(container.querySelector('.dbp-annotation-quote blockquote')?.textContent, 'Alpha');

    // 3. Invalid region selection (heading, code block, cross-paragraph) renders floating non-interactive reason tooltip.
    for (const badRange of [
      makeRange(h2.firstChild, 0, h2.firstChild, 4),
      makeRange(pre.firstChild, 0, pre.firstChild, 5),
      makeRange(alphaText, 0, paras[paras.length - 1].firstChild, 5),
    ]) {
      act(() => {
        doc._selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => badRange };
        doc.dispatchEvent(new Event('selectionchange'));
      });
      const hintEl = container.querySelector('.dbp-annotation-at-selection.dbp-annotation-at-selection-hint');
      assert.equal(container.querySelector('button.dbp-annotation-at-selection'), null);
      assert.ok(hintEl, 'Floating invalid-selection reason hint should render beside unsupported selection');
      assert.equal(hintEl.textContent, enLocale.ui.annotationSelectionInvalid);
      assert.ok(hintEl.style.left?.endsWith('px'));
    }

    // 4. Over-length quote and count-limit selections render corresponding floating hints.
    const longRange = makeRange(alphaText, 0, alphaText, alphaText.length);
    longRange.toString = () => 'x'.repeat(annotationLimits.quote + 1);
    act(() => {
      doc._selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => longRange };
      doc.dispatchEvent(new Event('selectionchange'));
    });
    assert.equal(container.querySelector('.dbp-annotation-at-selection-hint')?.textContent, enLocale.ui.annotationQuoteLimit);

    const draft = injectedProps.getAnnotationDraft(pending);
    act(() => {
      for (let i = 0; i < annotationLimits.count; i++) draft.save({ lineStart: 3, lineEnd: 3, quote: `q${i}` }, `note ${i}`);
      doc._selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => makeRange(alphaText, 0, alphaText, 5) };
      doc.dispatchEvent(new Event('selectionchange'));
    });
    assert.equal(container.querySelector('.dbp-annotation-at-selection-hint')?.textContent, enLocale.ui.annotationCountLimit);

    // A settlement can close the card before the session registry withdraws it.
    act(() => {
      cardState = { channel: 'waterfall', closed: true };
      for (const listener of [...cardListeners]) listener();
    });
    assert.equal(container.querySelector('.dbp-annotations'), null);
    assert.equal(container.querySelector('.dbp-document'), initialArticle);
    act(() => { root.unmount(); });
    assert.equal(listeners.size, 0);
    assert.equal(cardListeners.size, 0);
  });
});
