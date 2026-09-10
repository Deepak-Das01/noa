const DEFAULTS = {
  targetTokens: 700,
  overlapTokens: 125,
  minChunkTokens: 1,
};

export function estimateTokens(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.max(1, Math.ceil(words * 1.3));
}

function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let current = { header: '', lines: [] };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (current.lines.length || current.header) sections.push(current);
      current = { header: heading[2].trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length || current.header) sections.push(current);
  return sections;
}

function paragraphsFromSection(section) {
  const body = section.lines.join('\n').trim();
  if (!body) return [];
  return body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

function takeOverlapTail(text, overlapTokens) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const count = Math.max(1, Math.ceil(overlapTokens / 1.3));
  return words.slice(-count).join(' ');
}

export function chunkDocument(text, meta = {}, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const sections = splitSections(text);
  const chunks = [];
  let buffer = '';
  let bufferMeta = { section: '', page: meta.page ?? null };

  const flush = (force = false) => {
    const content = buffer.trim();
    if (!content) return;
    if (!force && estimateTokens(content) < config.minChunkTokens) return;
    chunks.push({
      content,
      section: bufferMeta.section || null,
      page_number: bufferMeta.page ?? null,
      chunk_index: chunks.length,
      token_count: estimateTokens(content),
    });
    const overlap = takeOverlapTail(content, config.overlapTokens);
    buffer = overlap ? `${overlap}\n\n` : '';
  };

  for (const section of sections) {
    const sectionName = section.header || null;
    for (const paragraph of paragraphsFromSection(section)) {
      const candidate = buffer ? `${buffer}${paragraph}` : paragraph;
      if (estimateTokens(candidate) > config.targetTokens && buffer.trim()) {
        flush();
        buffer = paragraph;
        bufferMeta = { section: sectionName, page: meta.page ?? null };
      } else {
        buffer = candidate;
        bufferMeta = { section: sectionName, page: meta.page ?? null };
      }
    }
    if (buffer.trim() && estimateTokens(buffer) >= config.targetTokens) flush();
  }
  if (buffer.trim()) flush(true);
  return chunks.map((chunk, index) => ({ ...chunk, chunk_index: index }));
}

export function chunkPages(pages, options = {}) {
  const all = [];
  for (const page of pages) {
    const pageChunks = chunkDocument(page.text, { page: page.page }, options);
    for (const chunk of pageChunks) all.push(chunk);
  }
  return all.map((chunk, index) => ({ ...chunk, chunk_index: index }));
}
