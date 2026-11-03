// Small text helpers: HTML escaping, a tiny Markdown renderer for answers, and the chat export.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Paragraphs, "-", "*" or "1." lists, **bold**, *italic* and `code`. Everything else is escaped text.
export function renderMarkdown(text) {
  const out = [];
  let list = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const kind = /^\d/.test(line) ? 'ol' : 'ul';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
    } else if (!line) {
      close();
    } else {
      close();
      out.push(`<p>${inline(line.replace(/^#{1,6}\s+/, ''))}</p>`);
    }
  }
  close();
  return out.join('');
}

export function toMarkdownExport(session, modeLabels = {}) {
  const started = new Date(session.startedAt);
  const lines = [
    `# IntervQ · ${modeLabels[session.mode] || session.mode}`,
    '',
    `Started ${started.toLocaleString()}`,
    '',
  ];
  for (const t of session.turns.filter((x) => x.answer)) {
    lines.push(`## ${t.label ? `${t.label}: ` : ''}${t.question || '(question not captured)'}`, '', t.answer, '');
  }
  return lines.join('\n');
}
