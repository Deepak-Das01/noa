const FRESHNESS_PATTERNS = [
  /\bcurrent(?:ly)?\b/i,
  /\blatest\b/i,
  /\btoday\b/i,
  /\bnow\b/i,
  /\brecent(?:ly)?\b/i,
  /\bnewest\b/i,
  /\bpresent\b/i,
  /\bceo\b/i,
  /\bpresident\b/i,
  /\bchair(?:man|woman|person)?\b/i,
  /\bstock price\b/i,
  /\bprice of\b/i,
  /\bversion\b/i,
  /\brelease\b/i,
  /\bsupport lifecycle\b/i,
  /\beol\b/i,
  /\beos\b/i,
  /\bmaintainer\b/i,
  /\bowner\b/i,
  /\bleadership\b/i,
  /\bavailability\b/i,
  /\bwho is\b/i,
  /\bwho's\b/i,
];

const STALE_FILENAME_YEAR = /\b(19|20)\d{2}\b/;
const MAX_SOURCE_AGE_DAYS = 365;

export function isFreshnessSensitive(query) {
  const text = String(query || '').trim();
  if (!text) return false;
  return FRESHNESS_PATTERNS.some(pattern => pattern.test(text));
}

export function extractYearFromFilename(filename) {
  const match = String(filename || '').match(STALE_FILENAME_YEAR);
  return match ? Number(match[0]) : null;
}

export function evaluateSourceFreshness(sources, { freshnessSensitive } = {}) {
  if (!freshnessSensitive || !sources?.length) {
    return { possiblyStale: false, warnings: [], sources };
  }

  const currentYear = new Date().getFullYear();
  const warnings = [];

  for (const source of sources) {
    let possiblyStale = false;
    const fileYear = extractYearFromFilename(source.filename);
    if (fileYear && fileYear < currentYear - 1) {
      possiblyStale = true;
      warnings.push({
        chunk_id: source.chunk_id,
        filename: source.filename,
        reason: `filename suggests ${fileYear}`,
      });
    }

    const modifiedAt = source.file_modified_at || source.modified_at;
    if (modifiedAt) {
      const ageDays = (Date.now() - new Date(modifiedAt).getTime()) / 86400000;
      if (ageDays > MAX_SOURCE_AGE_DAYS) {
        possiblyStale = true;
        warnings.push({
          chunk_id: source.chunk_id,
          filename: source.filename,
          reason: 'file modified more than 12 months ago',
        });
      }
    }

    source.possiblyStale = possiblyStale;
  }

  return {
    possiblyStale: warnings.length > 0,
    warnings,
    sources,
  };
}

export function resolveGroundingBadge({ groundingMode, freshnessSensitive, possiblyStale }) {
  if (groundingMode === 'insufficient') {
    return { badge: 'INSUFFICIENT', label: 'No matching local sources were found.' };
  }
  if (groundingMode === 'documents') {
    if (freshnessSensitive && possiblyStale) {
      return {
        badge: 'DOCUMENTS',
        label: 'Answer from documents — source may be outdated.',
        possiblyStale: true,
      };
    }
    return { badge: 'DOCUMENTS', label: 'Answer supported by indexed documents.' };
  }
  if (groundingMode === 'documents+model') {
    return { badge: 'DOCUMENTS + MODEL', label: 'Documents with optional model supplement.' };
  }
  if (groundingMode === 'model-only' && freshnessSensitive) {
    return {
      badge: 'UNVERIFIED',
      label: 'Current information not verified.',
      freshnessWarning: true,
    };
  }
  return { badge: 'MODEL KNOWLEDGE', label: 'No matching local sources were used.' };
}

export function shouldUseDeterministicUnverifiedResponse({ groundingMode, freshnessSensitive }) {
  return groundingMode === 'model-only' && freshnessSensitive;
}

export function buildUnverifiedFreshnessResponse() {
  return "I don't have a recent local source to verify that answer. My built-in model knowledge may be outdated. If you add a recent document on this topic to your knowledge base, I can answer from your local sources.";
}

export function buildSystemMetadataBlock({
  groundingMode,
  freshnessSensitive,
  possiblyStale,
  recentSupportingSources,
}) {
  return [
    'SYSTEM METADATA:',
    `Grounding mode: ${groundingMode}`,
    `Freshness-sensitive query: ${freshnessSensitive ? 'true' : 'false'}`,
    `Recent supporting sources: ${recentSupportingSources}`,
    possiblyStale ? 'Source freshness warning: at least one source may be outdated.' : null,
    freshnessSensitive
      ? 'Instruction: Do not describe any model-memory answer as current, verified, or up to date.'
      : null,
  ].filter(Boolean).join('\n');
}
