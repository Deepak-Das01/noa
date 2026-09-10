const DEFAULTS = {
  vectorLimit: 20,
  keywordLimit: 20,
  mergePoolLimit: 20,
  finalLimit: 5,
};

function reciprocalRank(rank, k = 60) {
  return 1 / (k + rank);
}

/** Rank-merge only. Does NOT establish absolute relevance. */
export function mergeHybridResults({ vectorResults = [], keywordResults = [], limit = DEFAULTS.mergePoolLimit }) {
  const map = new Map();

  vectorResults.forEach((item, index) => {
    const id = item.chunk_id || item.id;
    const entry = map.get(id) || { chunk_id: id, ...item, vector_score: 0, keyword_score: 0, rrf: 0 };
    entry.vector_score = item.score || 0;
    entry.rrf += reciprocalRank(index + 1);
    entry.content = item.content || entry.content;
    entry.filename = item.filename || entry.filename;
    entry.section = item.section || entry.section;
    entry.page_number = item.page_number ?? entry.page_number;
    entry.document_id = item.document_id || entry.document_id;
    entry.knowledge_base_id = item.knowledge_base_id || entry.knowledge_base_id;
    map.set(id, entry);
  });

  keywordResults.forEach((item, index) => {
    const id = item.chunk_id;
    const entry = map.get(id) || { chunk_id: id, ...item, vector_score: 0, keyword_score: 0, rrf: 0 };
    entry.keyword_score = Math.abs(item.score || 0);
    entry.rrf += reciprocalRank(index + 1);
    entry.content = item.content || entry.content;
    entry.filename = item.filename || entry.filename;
    entry.section = item.section || entry.section;
    entry.document_id = item.document_id || entry.document_id;
    entry.knowledge_base_id = item.knowledge_base_id || entry.knowledge_base_id;
    map.set(id, entry);
  });

  return [...map.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit);
}

export { DEFAULTS as HYBRID_DEFAULTS };
