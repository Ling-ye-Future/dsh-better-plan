const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?=\s|$)/i;
const ACTION_RE = /^\[(NEW|MODIFY|DELETE|RENAME|MOVE)\](?=\s|$)/i;

export function remarkPlanAlerts() {
  return function visit(node) {
    const paragraph = node.type === 'blockquote' ? node.children?.[0] : undefined;
    const lead = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
    const marker = lead?.type === 'text' && ALERT_RE.exec(lead.value);
    if (marker) {
      const label = marker[1].toUpperCase();
      lead.value = lead.value.slice(marker[0].length).trimStart();
      if (!lead.value) {
        paragraph.children.shift();
        if (paragraph.children[0]?.type === 'break') paragraph.children.shift();
      }
      node.data = { hProperties: { 'data-tone': label.toLowerCase() } };
      node.children.splice(0, paragraph.children.length ? 0 : 1, {
        type: 'paragraph',
        data: { hProperties: { className: ['dbp-callout-label'] } },
        children: [{ type: 'text', value: label }],
      });
    }
    node.children?.forEach(visit);
  };
}

export function remarkPlanBadges() {
  return function visit(node) {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if ((node.type === 'heading' || node.type === 'paragraph') && Array.isArray(node.children)) {
      const lead = node.children[0];
      const match = lead?.type === 'text' ? ACTION_RE.exec(lead.value) : null;
      if (match) {
        const action = match[1].toUpperCase();
        const rest = lead.value.slice(match[0].length).replace(/^[ \t]+/, '');
        const badge = {
          type: 'planActionBadge',
          data: {
            hName: 'span',
            hProperties: { className: ['dbp-action-badge'], 'data-action': action.toLowerCase() },
          },
          children: [{ type: 'text', value: action }],
        };
        if (rest) {
          lead.value = ' ' + rest;
          node.children.unshift(badge);
        } else if (node.children.length > 1) {
          lead.value = ' ';
          node.children.unshift(badge);
        } else {
          node.children[0] = badge;
        }
      }
    }
    node.children?.forEach(visit);
  };
}
