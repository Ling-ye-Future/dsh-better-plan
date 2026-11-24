export function isMermaidLanguage(language) {
  if (typeof language !== 'string') return false;
  const word = language.trim().toLowerCase();
  return word === 'mermaid' || word === 'mermaidjs' || word === 'mmd';
}

export function extractLanguageFromClassName(className) {
  if (typeof className !== 'string') return '';
  for (const token of className.split(/\s+/)) {
    if (token.startsWith('language-') && token.length > 9) {
      return token.slice(9);
    }
  }
  return '';
}

export function hasMermaidFence(markdown) {
  if (typeof markdown !== 'string' || !markdown) return false;
  return /^ {0,3}(?:`{3,}|~{3,})[ \t]*(?:mermaidjs|mermaid|mmd)(?:[\s{]|$)/im.test(markdown);
}
