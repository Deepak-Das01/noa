const EMBED_NAME_PATTERN = /embed/i;

export function isLikelyEmbeddingModel(modelName) {
  return EMBED_NAME_PATTERN.test(String(modelName || ''));
}

export function pickEmbeddingModels(modelNames = []) {
  return modelNames.filter(isLikelyEmbeddingModel);
}

export function pickChatModels(modelNames = []) {
  return modelNames.filter(name => !isLikelyEmbeddingModel(name));
}

export function resolveEmbeddingModel(requested, available = []) {
  const names = available.filter(Boolean);
  if (requested && isLikelyEmbeddingModel(requested) && names.includes(requested)) return requested;
  const embedModels = pickEmbeddingModels(names);
  if (embedModels.length) return embedModels[0];
  return requested || '';
}

export function assertEmbeddingVector(vector, { expectedModel, context } = {}) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    throw new Error(`Embedding failed${context ? ` (${context})` : ''}: response is not a numeric vector.`);
  }
  if (!vector.length) {
    throw new Error(`Embedding failed${context ? ` (${context})` : ''}: empty vector returned.`);
  }
  if (!vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`Embedding failed${context ? ` (${context})` : ''}: vector contains non-numeric values.`);
  }
  return { dimensions: vector.length, model: expectedModel };
}
