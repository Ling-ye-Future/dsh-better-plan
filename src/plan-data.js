const modeNames = new Set(['one-shot', 'continuable', 'unknown']);

// Match only the two resource shapes already supplied by the native plan plugin.
export function parsePlanAddress(address) {
  if (typeof address !== 'string') return;
  const match = /^dsh-resource:\/\/(plan|plan-review)\/([^?#]+)$/.exec(address);
  if (!match) return;
  let parts;
  try { parts = match[2].split('/').map(decodeURIComponent); }
  catch { return; }
  if (parts.some(part => !part)) return;
  const [first, second, third, fourth, fifth] = parts;
  if (match[1] === 'plan-review') {
    return parts.length === 2 ? { kind: 'review', sessionId: first, requestKey: second } : undefined;
  }
  if (parts.length === 2) return { kind: 'plan', sessionId: first, callId: second };
  if (parts.length === 5 && first === 'subagent' && modeNames.has(fourth)) {
    return { kind: 'plan', parentSessionId: second, childSessionId: third, mode: fourth, callId: fifth };
  }
}

function documentValue(value) {
  if (typeof value?.markdown !== 'string' || !value.markdown.trim()) return;
  return { markdown: value.markdown, title: typeof value.title === 'string' ? value.title.trim() : '' };
}

export function selectPlan(target, resource, params) {
  if (!target) return { state: 'unavailable' };
  if (target.kind === 'review') {
    const document = documentValue(params?.planReview);
    return document ? { state: 'ready', document } : { state: 'expired' };
  }
  if (resource?.status === 'loading') return { state: 'loading' };
  if (resource?.status === 'failed') return { state: 'failed' };
  const document = resource?.status === 'live' ? documentValue(resource.value) : undefined;
  return document ? { state: 'ready', document } : { state: 'unavailable' };
}

export function fileSession(target, seatSessionId) {
  // A child/temporary preview can live in a parent's sidebar. Never guess its cwd.
  return target?.kind === 'plan' && typeof seatSessionId === 'string' && seatSessionId === target.sessionId
    ? seatSessionId : undefined;
}

// No URL scheme, encoded separator, Windows device/stream, or directory traversal.
const windowsDevices = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const forbiddenSegmentChars = /[\x00-\x1f\x7f\\:<>"|*?#%]/;

function parseLineHash(hash) {
  if (!hash) return { line: undefined, lineEnd: undefined };
  const match = /^#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(hash);
  if (!match) return null;
  const line = Number(match[1]);
  const lineEnd = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(line)) return null;
  if (lineEnd !== undefined && (!Number.isSafeInteger(lineEnd) || lineEnd < line)) return null;
  return { line, lineEnd };
}

function validSegments(parts) {
  return !parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
    || forbiddenSegmentChars.test(part) || windowsDevices.test(part));
}

function normalizeAbsPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  const slashed = rawPath.replaceAll('\\', '/');
  let drive = '';
  let rest = '';
  if (/^[a-zA-Z]:(?:\/|$)/.test(slashed)) {
    drive = slashed.slice(0, 2).toLowerCase();
    rest = slashed.slice(2);
  } else if (/^\/(?!\/)/.test(slashed)) {
    rest = slashed;
  } else {
    return null;
  }
  const segments = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (!validSegments(segments)) return null;
  return { drive, segments };
}

function resolveInsideCwd(rawTarget, cwd) {
  const cwdNorm = normalizeAbsPath(cwd);
  const targetNorm = normalizeAbsPath(rawTarget);
  if (!cwdNorm || !targetNorm) return;
  if (cwdNorm.drive !== targetNorm.drive) return;
  if (targetNorm.segments.length <= cwdNorm.segments.length) return;
  const caseInsensitive = cwdNorm.drive !== '';
  for (let index = 0; index < cwdNorm.segments.length; index += 1) {
    const a = cwdNorm.segments[index];
    const b = targetNorm.segments[index];
    if (caseInsensitive ? a.toLowerCase() !== b.toLowerCase() : a !== b) return;
  }
  return targetNorm.segments.slice(cwdNorm.segments.length).join('/');
}

function fileResult(path, lines) {
  return lines.lineEnd === undefined
    ? { kind: 'file', path, line: lines.line }
    : { kind: 'file', path, line: lines.line, lineEnd: lines.lineEnd };
}

export function planLink(href, options) {
  if (typeof href !== 'string' || !href || /[\x00-\x20\x7f\\]/.test(href)) return;
  if (href.startsWith('#')) return { kind: 'fragment', href };
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.hostname && !url.username && !url.password) return { kind: 'external', href: url.href };
    } catch { /* Not a web URL. */ }
    return;
  }

  const cwd = typeof options?.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : undefined;
  if (/^file:\/\//i.test(href)) {
    if (!cwd) return;
    try {
      const url = new URL(href);
      if (url.username || url.password || url.search) return;
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return;
      if (/%2f|%5c|%25/i.test(url.pathname)) return;
      const lines = parseLineHash(url.hash);
      if (!lines) return;
      let decoded = decodeURIComponent(url.pathname);
      if (/[\x00-\x1f\x7f\\]/.test(decoded)) return;
      if (/^\/[a-zA-Z]:\//.test(decoded)) decoded = decoded.slice(1);
      const rel = resolveInsideCwd(decoded, cwd);
      return rel ? fileResult(rel, lines) : undefined;
    } catch {
      return;
    }
  }

  const hashAt = href.indexOf('#');
  const raw = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  if (!raw || raw.includes('?')) return;
  const lines = parseLineHash(hash);
  if (!lines) return;
  if (/%2f|%5c|%25/i.test(raw)) return;

  if (/^(?:\/(?!\/)|[a-zA-Z]:\/)/.test(raw)) {
    if (!cwd) return;
    let decoded;
    try { decoded = decodeURIComponent(raw); }
    catch { return; }
    if (/[\x00-\x1f\x7f\\]/.test(decoded)) return;
    const rel = resolveInsideCwd(decoded, cwd);
    return rel ? fileResult(rel, lines) : undefined;
  }

  if (/^\/\/|^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(raw)) return;
  const explicit = raw.startsWith('./');
  let path;
  try { path = decodeURIComponent(explicit ? raw.slice(2) : raw); }
  catch { return; }
  if (forbiddenSegmentChars.test(path)) return;
  const rawParts = path.split('/');
  if (rawParts.some(part => !part)) return;
  const parts = rawParts.filter(part => part !== '.');
  if (parts.length === 0 || !validSegments(parts)) return;
  const normalized = parts.join('/');
  if (!explicit && parts.length === 1 && !normalized.includes('.')) return;
  return fileResult(normalized, lines);
}
