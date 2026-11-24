const STRIP_ELEMENTS = new Set([
  'foreignobject',
  'script',
  'img',
  'image',
  'feimage',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'input',
  'button',
  'form',
  'link',
  'meta',
  'base',
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
]);

function decodeCssEscapes(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6}[ \t\r\n\f]?|[^\r\n\f0-9a-fA-F])/g, (_, seq) => {
    if (/^[0-9a-fA-F]/.test(seq)) {
      const code = Number.parseInt(seq, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return seq;
  });
}

function sanitizeStyleText(cssText) {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@([a-zA-Z0-9_\\-]+)\b[^;]*(?:;|$)/g, (full, keyword) => (
      decodeCssEscapes(keyword).toLowerCase() === 'import' ? '' : full
    ))
    .replace(/([a-zA-Z0-9_\\-]+)\s*\(\s*(['"]?)([^)]*?)\2\s*\)/g, (full, fn, quote, inner) => {
      const name = decodeCssEscapes(fn).toLowerCase();
      if (name === 'expression') return 'none';
      if (name !== 'url') return full;
      const trimmed = inner.trim();
      return /^#[A-Za-z0-9_.:-]+$/.test(trimmed) ? `url(${quote}${trimmed}${quote})` : 'none';
    });
}

export function sanitizeSvg(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return '';
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  } catch {
    return '';
  }
  if (doc.querySelector('parsererror') !== null) return '';
  if (doc.documentElement === null || doc.documentElement.localName !== 'svg') return '';
  doc.querySelectorAll('*').forEach((node) => {
    const tag = node.localName.toLowerCase();
    if (STRIP_ELEMENTS.has(tag)) {
      node.remove();
      return;
    }
    if (tag === 'style' && node.textContent) {
      node.textContent = sanitizeStyleText(node.textContent);
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name;
      const normalized = name.toLowerCase();
      if (normalized.startsWith('@') || normalized.startsWith('on')) {
        node.removeAttribute(name);
        continue;
      }
      if (normalized === 'href' || normalized === 'xlink:href') {
        node.removeAttribute(name);
        continue;
      }
      if (normalized === 'style' && attribute.value) {
        node.setAttribute(name, sanitizeStyleText(attribute.value));
      }
    }
  });
  return new XMLSerializer().serializeToString(doc.documentElement);
}
