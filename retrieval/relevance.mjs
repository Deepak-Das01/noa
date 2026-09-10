export const RELEVANCE_CONFIG = {
  vectorCandidateLimit: 20,
  ftsCandidateLimit: 20,
  mergePoolLimit: 20,
  finalContextLimit: 5,
  maxChunksPerDocument: 3,
  /** Calibrated with nomic-embed-text on services-test corpus */
  minVectorRelevance: 0.52,
  strongVectorRelevance: 0.68,
  absoluteVectorFloor: 0.45,
  minLexicalMatches: 1,
  strongLexicalMatches: 2,
  contentDedupeOverlap: 0.82,
};

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'what', 'who', 'how', 'does', 'do', 'did', 'about', 'of', 'in', 'on', 'at', 'to', 'for',
  'and', 'or', 'this', 'that', 'these', 'those', 'tell', 'me', 'more', 'with', 'from',
  'it', 'its', 'as', 'by', 'if', 'not', 'can', 'you', 'your', 'my', 'our', 'their',
  'say', 'said', 'mention', 'mentioned', 'describe', 'described', 'documentation', 'document',
]);

function normalizeToken(token) {
  return String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractQueryTerms(query) {
  const normalized = String(query || '')
    .toLowerCase()
    .replace(/\bred\s*hat\b/g, 'redhat')
    .replace(/\bred-hat\b/g, 'redhat');

  const terms = [];
  const seen = new Set();
  for (const raw of normalized.split(/\s+/)) {
    const token = normalizeToken(raw);
    if (!token || token.length < 2 || STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

function chunkTokenSet(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\bred\s*hat\b/g, 'redhat')
    .replace(/\bred-hat\b/g, 'redhat')
    .replace(/[^a-z0-9\s]/g, ' ');
  const set = new Set();
  for (const token of normalized.split(/\s+/)) {
    const value = normalizeToken(token);
    if (value) set.add(value);
  }
  return set;
}

function termMatchesChunk(term, chunkTokens, chunkText) {
  if (chunkTokens.has(term)) return true;
  if (term.endsWith('s') && term.length > 4 && chunkTokens.has(term.slice(0, -1))) return true;
  if (chunkTokens.has(`${term}s`)) return true;
  if (term === 'redhat' && /\bred\s*hat\b|\bredhat\b/i.test(chunkText)) return true;
  if (term === 'service' && (chunkTokens.has('services') || chunkTokens.has('service'))) return true;
  if (term === 'services' && chunkTokens.has('service')) return true;
  return false;
}

export function lexicalOverlap(queryTerms, chunkText) {
  const chunkTokens = chunkTokenSet(chunkText);
  const matched = [];
  for (const term of queryTerms) {
    if (termMatchesChunk(term, chunkTokens, chunkText)) matched.push(term);
  }
  return {
    matchedTerms: matched.length,
    matched,
    queryTerms: queryTerms.length,
    ratio: queryTerms.length ? matched.length / queryTerms.length : 0,
  };
}

export function evaluateChunkRelevance(candidate, queryTerms, { vectorScore = 0, keywordScore = 0 } = {}) {
  const overlap = lexicalOverlap(queryTerms, candidate.content || '');
  const lexicalMatches = overlap.matchedTerms;
  const hasKeyword = keywordScore > 0;

  if (vectorScore > 0 && vectorScore < RELEVANCE_CONFIG.absoluteVectorFloor && lexicalMatches === 0 && !hasKeyword) {
    return {
      accepted: false,
      rejectReason: 'below absolute vector floor with no lexical evidence',
      overlap,
      vectorScore,
      keywordScore,
    };
  }

  if (hasKeyword && lexicalMatches >= RELEVANCE_CONFIG.minLexicalMatches) {
    return { accepted: true, acceptReason: 'fts+lexical', overlap, vectorScore, keywordScore };
  }

  if (vectorScore >= RELEVANCE_CONFIG.strongVectorRelevance) {
    if (lexicalMatches >= RELEVANCE_CONFIG.minLexicalMatches || vectorScore >= 0.75) {
      return { accepted: true, acceptReason: 'strong-vector', overlap, vectorScore, keywordScore };
    }
  }

  if (vectorScore >= RELEVANCE_CONFIG.minVectorRelevance && lexicalMatches >= RELEVANCE_CONFIG.minLexicalMatches) {
    return { accepted: true, acceptReason: 'vector+lexical', overlap, vectorScore, keywordScore };
  }

  if (lexicalMatches >= RELEVANCE_CONFIG.strongLexicalMatches) {
    return { accepted: true, acceptReason: 'strong-lexical', overlap, vectorScore, keywordScore };
  }

  if (vectorScore >= RELEVANCE_CONFIG.minVectorRelevance && lexicalMatches === 0) {
    return {
      accepted: false,
      rejectReason: 'vector score without lexical support',
      overlap,
      vectorScore,
      keywordScore,
    };
  }

  return {
    accepted: false,
    rejectReason: lexicalMatches === 0 ? 'zero lexical overlap' : 'insufficient combined evidence',
    overlap,
    vectorScore,
    keywordScore,
  };
}

function contentOverlapRatio(a, b) {
  const wordsA = new Set(String(a || '').toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(String(b || '').toLowerCase().split(/\s+/).filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;
  let intersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) intersection += 1;
  return intersection / Math.min(wordsA.size, wordsB.size);
}

export function deduplicateChunks(chunks, options = {}) {
  const config = { ...RELEVANCE_CONFIG, ...options };
  const selected = [];
  const perDocument = new Map();

  for (const chunk of chunks) {
    const docId = chunk.document_id || chunk.filename || 'unknown';
    const docCount = perDocument.get(docId) || 0;
    if (docCount >= config.maxChunksPerDocument) continue;

    const duplicate = selected.some(existing => {
      if ((existing.document_id || existing.filename) !== (chunk.document_id || chunk.filename)) return false;
      return contentOverlapRatio(existing.content, chunk.content) >= config.contentDedupeOverlap;
    });
    if (duplicate) continue;

    selected.push(chunk);
    perDocument.set(docId, docCount + 1);
  }
  return selected;
}

export function gateCandidates(candidates, queryTerms) {
  const evaluated = candidates.map(candidate => {
    const evaluation = evaluateChunkRelevance(candidate, queryTerms, {
      vectorScore: candidate.vector_score || candidate.score || 0,
      keywordScore: candidate.keyword_score || 0,
    });
    return { ...candidate, relevance: evaluation };
  });

  const accepted = evaluated
    .filter(item => item.relevance.accepted)
    .sort((a, b) => {
      const scoreA = (a.relevance.vectorScore || 0) + (a.relevance.overlap?.matchedTerms || 0) * 0.05 + (a.rrf || 0);
      const scoreB = (b.relevance.vectorScore || 0) + (b.relevance.overlap?.matchedTerms || 0) * 0.05 + (b.rrf || 0);
      return scoreB - scoreA;
    });

  return { evaluated, accepted };
}

export function hasRelevantSources(sources) {
  return Array.isArray(sources) && sources.some(item => item?.content && item.relevance?.accepted !== false);
}
