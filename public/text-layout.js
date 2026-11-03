// Terminal soft wraps can be removed upstream. Explicit line breaks inserted by
// agent TUIs need a separate, reversible reading view; never alter source text.
export function paneDisplayText(text, layout, status) {
  if (layout !== 'reflow') return text;
  if (status === 'working') return 'Working…\n\n完成後會顯示內容。要查看即時過程，請切換「保留分行」或「原始行寬」。';
  // Never hide approval requests or guess which terminal lines are reasoning.
  return reflowText(text);
}

export function reflowText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const output = []; let paragraph = '', fenced = false;
  const flush = () => { if (paragraph) output.push(paragraph); paragraph = ''; };
  const structured = line => /^(?:\s{4}|\t|\s*[-*•●›❯>]\s|\s*\d+[.)]\s|\s*#{1,6}\s|\s*\||\s*[┌┐└┘├┤┬┴┼│─╭╮╰╯]|\s*(?:const|let|var|def|class|import|from|return|function|if|else|for|while)\b|\s*[$#]\s|[^\s]+[$#%]\s)/.test(line) || /[{}]|=>|;\s*$|\s{3,}\S/.test(line);
  const separator = (a, b) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？：；、）]$/u.test(a) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（]/u.test(b) ? '' : ' ';
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); fenced = !fenced; output.push(line); continue; }
    if (fenced || !line.trim() || structured(line) || / {2}$/.test(line)) { flush(); output.push(line); continue; }
    const trimmed = line.trim(); paragraph += paragraph ? separator(paragraph, trimmed) + trimmed : trimmed;
  }
  flush(); return output.join('\n');
}

export function sortPanes(panes, order = 'recent') {
  const rank = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
  return [...panes].sort((a, b) => {
    if (order === 'name') return String(a.title).localeCompare(String(b.title));
    if (order === 'attention') { const delta = (rank[a.status] ?? 4) - (rank[b.status] ?? 4); if (delta) return delta; }
    return (Number(b.lastOutputAt) || 0) - (Number(a.lastOutputAt) || 0) || (Number(b.completionSeq) || 0) - (Number(a.completionSeq) || 0) || a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

// Parse only a live model/effort picker, never model names in conversation history.
export function modelMenu(text, agent) {
  const lines = String(text).split('\n');
  const heading = /select\s+(?:a\s+)?(?:model|reasoning|effort)|reasoning\s+effort|choose\s+(?:a\s+)?model/i;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (heading.test(lines[i]) && !/←|→/.test(lines[i])) start = i;
    if (agent === 'devin' && /\/\s*Type to search/i.test(lines[i])) start = i;
  }
  if (start < 0) return { options: [], selected: -1, text: String(text), active: false };
  const options = [];
  let selected = -1;
  for (const line of lines.slice(start + 1)) {
    if (/enter.*(?:select|default)|esc.*(?:back|cancel)|↑↓.*select/i.test(line)) break;
    const numbered = line.match(/^\s*([›❯❭>↓]?)\s*(\d+)\.\s+(.+?)\s*$/u);
    let label, marker;
    if (numbered) { marker = numbered[1]; label = numbered[3]; }
    else if (agent === 'devin') {
      const row = line.match(/^\s*([❭›❯>]?)\s*((?:Claude|GPT-|Grok|Gemini|Adaptive|Auto|Fusion|DeepSeek|Kimi|MiniMax|GLM)[^\n]*)$/iu);
      if (!row) continue;
      marker = row[1]; label = row[2].trim();
    } else continue;
    if (/[›❯❭>]/u.test(marker)) selected = options.length;
    options.push({ label, id: label.replace(/[←→]/g, '').replace(/\s+/g, ' ').trim(), index: options.length });
  }
  return { options, selected, text: lines.slice(start).join('\n'), active: options.length > 0 && selected >= 0 };
}
