import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const json = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
const manifest = await json('package.json');

async function buildKatexCss() {
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
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
  return { katexCssPath, css: inlined };
}

function createPlanCssPlugin() {
  return {
    name: 'better-plan-css',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /[\\/]src[\\/]plan\.css$/ }, async (args) => {
        const [{ css: katexCss, katexCssPath }, planCss] = await Promise.all([
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

const notices = ['Third-party notices for the bundled Better Plan Preview client and host.'];
for (const directory of [...directories].sort()) {
  const pkg = await json(path.join(directory, 'package.json'));
  const available = await readdir(directory);
  const licenses = available.filter(name => /^(?:licen[sc]e|notice|copying)(?:\.[\w.-]+)?$/i.test(name)).sort();
  let bodies;
  if (licenses.length) {
    bodies = await Promise.all(licenses.map(async (name) => (await readFile(path.join(directory, name), 'utf8')).trim()));
  } else {
    if (!pkg.license) throw new Error('Missing bundled license notice: ' + pkg.name);
    const readmeName = available.find(name => /^readme(?:\.[\w.-]+)?$/i.test(name));
    const readme = readmeName ? await readFile(path.join(directory, readmeName), 'utf8') : '';
    const section = /(?:^|\n)##+\s+licen[sc]e\b([\s\S]*?)(?=\n##+\s|\n<!--|$)/i.exec(readme)?.[1]?.trim();
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    bodies = [[
      `License: ${pkg.license} (declared in package.json; standalone license file omitted in monorepo tarball)`,
      author ? `Author: ${author}` : null,
      repo ? `Repository: ${repo}` : null,
      section || null,
    ].filter(Boolean).join('\n')];
  }
  notices.push(pkg.name + '@' + pkg.version + ' (' + pkg.license + ')\n\n' + bodies.join('\n\n'));
}
await writeFile('lib/THIRD-PARTY-NOTICES.txt', notices.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n');
