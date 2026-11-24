import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const json = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
const manifest = await json('package.json');
const katexCssPath = require.resolve('katex/dist/katex.min.css');

async function buildKatexCss() {
  const katexDir = path.dirname(katexCssPath);
  const raw = await readFile(katexCssPath, 'utf8');
  const stripped = raw
    .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, '')
    .replace(/(^|[}\s])body\{/g, '$1.dbp-preview{');

  const fontCache = new Map();
  const fontMatches = [...stripped.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)];
  for (const match of fontMatches) {
    const rel = match[1];
    if (fontCache.has(rel)) continue;
    const fontPath = path.join(katexDir, rel);
    const bytes = await readFile(fontPath);
    fontCache.set(rel, `data:font/woff2;base64,${bytes.toString('base64')}`);
  }
  const inlined = stripped.replace(/url\((fonts\/[^)]+\.woff2)\)/g, (_, rel) => `url("${fontCache.get(rel)}")`);
  if (/url\((?!["']?data:)/i.test(inlined)) {
    throw new Error('Unexpected external url() remaining in bundled KaTeX CSS');
  }
  return inlined;
}

function createPlanCssPlugin() {
  return {
    name: 'better-plan-css',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /[\\/]src[\\/]plan\.css$/ }, async (args) => {
        const [katexCss, planCss] = await Promise.all([
          buildKatexCss(),
          readFile(args.path, 'utf8'),
        ]);
        return {
          contents: `${katexCss}\n${planCss}`,
          loader: 'text',
          watchFiles: [args.path, katexCssPath],
        };
      });
    },
  };
}

// 1. Host entry bundle (`lib/index.js`). `@deepseek-ai/schemastery` stays external
// as a host peer so Settings schema identity matches the running DSH host.
const hostResult = await build({
  entryPoints: ['src/host.js'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['node:*', '@deepseek-ai/schemastery'],
  metafile: true,
  legalComments: 'eof',
});

// 2. Isolated Mermaid iframe bundle (inlined into `lib/client.mermaid.js`).
const frameResult = await build({
  entryPoints: ['src/mermaid-iframe-entry.js'],
  write: false,
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: true,
  metafile: true,
  legalComments: 'none',
});
const frameScript = frameResult.outputFiles[0].text.replace(/<\/script/gi, '\\x3C/script');
const frameHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;}</style></head><body><script>${frameScript}</script></body></html>`;

// 3. Lazy-loaded Mermaid UI chunk (`lib/client.mermaid.js`).
const mermaidChunkResult = await build({
  entryPoints: ['src/client.mermaid.jsx'],
  outfile: 'lib/client.mermaid.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  define: {
    __MERMAID_FRAME_HTML__: JSON.stringify(frameHtml),
  },
  minify: true,
  metafile: true,
  legalComments: 'eof',
  banner: {
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},chunk:"client.mermaid.js",factory(require){const module={exports:{}};const exports=module.exports;`,
  },
  footer: { js: 'return module.exports;}});' },
});

// 4. Primary client plugin bundle (`lib/client.js`).
const decodeNamedRef = require.resolve('decode-named-character-reference');
const fromHtmlPure = require.resolve('hast-util-from-html-isomorphic');
const clientResult = await build({
  entryPoints: ['src/client.jsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [createPlanCssPlugin()],
  // Use the pure-JS branches instead of browser branches' eager DOM calls so SSR/VM tests work cleanly.
  alias: {
    'decode-named-character-reference': decodeNamedRef,
    'hast-util-from-html-isomorphic': fromHtmlPure,
  },
  minify: true,
  metafile: true,
  legalComments: 'eof',
  banner: {
    js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){const __dshLoadChunk=typeof require?.async==="function"?s=>require.async(s):undefined;const module={exports:{}};const exports=module.exports;`,
  },
  footer: { js: 'return module.exports;}});' },
});

const directories = new Set();
for (const result of [hostResult, frameResult, mermaidChunkResult, clientResult]) {
  for (const file of Object.keys(result.metafile.inputs)) {
    const asPosix = file.replaceAll('\\', '/');
    const matches = Array.from(asPosix.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g));
    const last = matches.at(-1);
    if (last) directories.add(asPosix.slice(0, last.index + last[0].length));
  }
}

// These npm tarballs omit their full license. Keep the source and version explicit.
const upstreamLicenses = new Map([
  ['rehype-katex@7.0.1', 'remark-math-MIT.txt'],
  ['remark-math@6.0.0', 'remark-math-MIT.txt'],
]);
const noticeText = async (filename) => (await readFile(filename, 'utf8')).trim();
const upstreamNotice = (name) => noticeText(new URL(`../third-party/${name}`, import.meta.url));

const notices = ['Third-party notices for the bundled Better Plan Preview client and host.'];
for (const directory of [...directories].sort()) {
  const pkg = await json(path.join(directory, 'package.json'));
  const identity = `${pkg.name}@${pkg.version}`;
  const available = (await readdir(directory)).sort();
  const readInPackage = (name) => noticeText(path.join(directory, name));
  const licenses = available.filter(name => /^(?:licen[sc]e|copying)(?:\.[\w.-]+)?$/i.test(name));
  const bodies = (await Promise.all(licenses.map(readInPackage))).filter(Boolean);
  if (!bodies.length) {
    const upstream = upstreamLicenses.get(identity);
    const text = upstream && await upstreamNotice(upstream);
    if (!text) throw new Error(`Missing bundled license text: ${identity}`);
    bodies.push(text);
  }
  const supplemental = available.filter(name => /^notice(?:\.[\w.-]+)?$/i.test(name));
  bodies.push(...(await Promise.all(supplemental.map(readInPackage))).filter(Boolean));
  notices.push(`${identity} (${pkg.license})\n\n${bodies.join('\n\n')}`);
}

const katexFontVersion = (await json(path.join(path.dirname(katexCssPath), '..', 'package.json'))).version;
const fontLicense = await upstreamNotice(`katex-fonts-${katexFontVersion}.txt`);
if (!fontLicense) throw new Error('Missing bundled KaTeX font license text');
notices.push(`KaTeX ${katexFontVersion} fonts (OFL-1.1)\n\n${fontLicense}`);
await writeFile('lib/THIRD-PARTY-NOTICES.txt', notices.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n');
