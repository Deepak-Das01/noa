import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashText } from './knowledge/hash.mjs';
import { chunkDocument } from './knowledge/chunking.mjs';
import { mergeHybridResults } from './retrieval/hybrid.mjs';
import {
  extractQueryTerms,
  lexicalOverlap,
  evaluateChunkRelevance,
  gateCandidates,
  deduplicateChunks,
  hasRelevantSources,
} from './retrieval/relevance.mjs';
import { cosineSimilarity, vectorSearch, vectorToBuffer } from './retrieval/vector.mjs';
import { createKnowledgeStore } from './knowledge/store.mjs';
import { sanitizeCitations } from './ai/prompt.mjs';
import { resolveEmbeddingModel, isLikelyEmbeddingModel } from './ai/embedding.mjs';
import { resolveRetrievalQuery, isIndependentQuery } from './ai/query.mjs';
import { prepareTurnContext, resolveRetrievalInput } from './ai/chat-turn.mjs';
import {
  isFreshnessSensitive,
  evaluateSourceFreshness,
  resolveGroundingBadge,
  shouldUseDeterministicUnverifiedResponse,
  buildUnverifiedFreshnessResponse,
} from './ai/freshness.mjs';

const SERVICES_DOC = `Kubernetes Services provide a stable network endpoint for a set of Pods.
Service types include ClusterIP, NodePort, LoadBalancer, and ExternalName.
ClusterIP exposes a Service internally within the cluster.
NodePort exposes a Service on each node at a static port.`;

function createServicesTestStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noa-ai-test-'));
  const store = createKnowledgeStore(dir);
  const kb = store.createKnowledgeBase({ name: 'Test' });
  const doc = store.upsertDocument({
    knowledge_base_id: kb.id,
    filename: 'services-test.txt',
    path: path.join(dir, 'services-test.txt'),
    mime_type: 'text/plain',
    sha256: hashText(SERVICES_DOC),
    size: SERVICES_DOC.length,
    created_at: store.nowIso(),
    modified_at: store.nowIso(),
    status: 'indexed',
  });
  const chunks = chunkDocument(SERVICES_DOC, {}, { minChunkTokens: 1 });
  chunks.forEach((chunk, index) => {
    store.insertChunk({
      id: store.newId(),
      document_id: doc.id,
      knowledge_base_id: kb.id,
      chunk_index: index,
      page_number: null,
      section: chunk.section,
      content: chunk.content,
      token_count: chunk.token_count,
      embedding: null,
      filename: 'services-test.txt',
    });
  });
  return { store, kb, doc, dir };
}

test('lexical overlap rejects unrelated CEO query against services doc', () => {
  const terms = extractQueryTerms('ceo of redhat');
  assert.deepEqual(terms, ['ceo', 'redhat']);
  const overlap = lexicalOverlap(terms, SERVICES_DOC);
  assert.equal(overlap.matchedTerms, 0);
});

test('relevance gate accepts service-related queries and rejects CEO query', () => {
  const serviceTerms = extractQueryTerms('What Service types are mentioned?');
  const ceoTerms = extractQueryTerms('Who is the CEO of Red Hat?');
  const serviceChunk = { chunk_id: 's1', content: 'Service types include ClusterIP, NodePort, LoadBalancer, and ExternalName.', filename: 'services-test.txt' };
  const ceoChunk = { chunk_id: 's1', content: SERVICES_DOC, filename: 'services-test.txt' };

  const serviceEval = evaluateChunkRelevance(serviceChunk, serviceTerms, { vectorScore: 0.724, keywordScore: 0 });
  assert.equal(serviceEval.accepted, true);

  const nodeportEval = evaluateChunkRelevance(
    { chunk_id: 's2', content: 'NodePort exposes a Service on each node at a static port.', filename: 'services-test.txt' },
    extractQueryTerms('How does NodePort work?'),
    { vectorScore: 0.81, keywordScore: 0 },
  );
  assert.equal(nodeportEval.accepted, true);

  const ceoEval = evaluateChunkRelevance(ceoChunk, ceoTerms, { vectorScore: 0.3865, keywordScore: 0 });
  assert.equal(ceoEval.accepted, false);
  assert.match(ceoEval.rejectReason, /lexical|vector|evidence/i);
});

test('TEST C: CEO query produces zero gated sources from services corpus', () => {
  const { store, kb } = createServicesTestStore();
  const chunks = store.getChunksForKnowledgeBases([kb.id]);
  const queryTerms = extractQueryTerms('Who is the CEO of Red Hat?');
  const candidates = chunks.map((chunk, index) => ({
    ...chunk,
    chunk_id: chunk.id,
    vector_score: 0.39 - index * 0.01,
    keyword_score: 0,
    rrf: 1 / (index + 61),
  }));
  const { accepted } = gateCandidates(candidates, queryTerms);
  assert.equal(accepted.length, 0);
  store.db.close();
});

test('TEST A and B: FTS finds service-related chunks', () => {
  const { store, kb } = createServicesTestStore();
  const types = store.keywordSearch('What Service types are mentioned?', [kb.id], 5);
  assert.ok(types.length >= 1);
  assert.match(types[0].content, /ClusterIP|NodePort|LoadBalancer/);

  const nodeport = store.keywordSearch('How does NodePort work?', [kb.id], 5);
  assert.ok(nodeport.length >= 1);
  assert.match(nodeport[0].content, /NodePort/);
  store.db.close();
});

test('TEST D: independent follow-up query is not rewritten to previous question', () => {
  const prior = [
    { role: 'user', content: 'What Service types are mentioned?' },
    { role: 'assistant', content: 'ClusterIP, NodePort, LoadBalancer, and ExternalName.' },
  ];
  const { retrievalQuery, currentQuestion } = resolveRetrievalInput('ceo of redhat', prior);
  assert.equal(currentQuestion, 'ceo of redhat');
  assert.equal(retrievalQuery, 'ceo of redhat');
  assert.equal(isIndependentQuery('ceo of redhat'), true);
});

test('TEST E: contextual follow-up expands retrieval query', () => {
  const prior = [
    { role: 'user', content: 'What Service types are mentioned?' },
    { role: 'assistant', content: 'ClusterIP, NodePort, LoadBalancer, and ExternalName.' },
  ];
  const rewritten = resolveRetrievalQuery('What about NodePort?', prior);
  assert.match(rewritten, /NodePort/i);
  assert.match(rewritten, /Service types/i);
});

test('prepareTurnContext routes freshness-sensitive CEO query to unverified model-only', () => {
  const turn = prepareTurnContext({
    currentQuestion: 'ceo of redhat',
    priorMessages: [],
    answerMode: 'documents_plus_model',
    relevantSources: [],
  });
  assert.equal(turn.groundingMode, 'model-only');
  assert.equal(turn.freshnessSensitive, true);
  assert.equal(turn.skipLlm, true);
  assert.equal(turn.groundingBadge, 'UNVERIFIED');
  assert.ok(turn.deterministicResponse);
  assert.equal(turn.messages.length, 0);
});

test('freshness Test A: stable TCP question is not freshness-sensitive', () => {
  assert.equal(isFreshnessSensitive('What is TCP?'), false);
  const turn = prepareTurnContext({
    currentQuestion: 'What is TCP?',
    priorMessages: [],
    answerMode: 'documents_plus_model',
    relevantSources: [],
  });
  assert.equal(turn.freshnessSensitive, false);
  assert.equal(turn.skipLlm, false);
  assert.equal(turn.groundingBadge, 'MODEL KNOWLEDGE');
  assert.ok(turn.messages.length > 0);
});

test('freshness Test B: current CEO with no sources is unverified', () => {
  assert.equal(isFreshnessSensitive('Who is the current CEO of Red Hat?'), true);
  const turn = prepareTurnContext({
    currentQuestion: 'Who is the current CEO of Red Hat?',
    priorMessages: [],
    answerMode: 'documents_plus_model',
    relevantSources: [],
  });
  assert.equal(turn.groundingMode, 'model-only');
  assert.equal(turn.skipLlm, true);
  assert.equal(turn.groundingBadge, 'UNVERIFIED');
  const response = buildUnverifiedFreshnessResponse();
  assert.match(response, /recent local source/i);
  assert.doesNotMatch(response, /Paul Cormier/i);
});

test('freshness Test C: latest OpenShift version without sources warns unverified', () => {
  assert.equal(isFreshnessSensitive('What is the latest OpenShift version?'), true);
  assert.equal(
    shouldUseDeterministicUnverifiedResponse({ groundingMode: 'model-only', freshnessSensitive: true }),
    true,
  );
  const badge = resolveGroundingBadge({ groundingMode: 'model-only', freshnessSensitive: true });
  assert.equal(badge.badge, 'UNVERIFIED');
  assert.equal(badge.freshnessWarning, true);
});

test('freshness Test D: recent leadership document grounds CEO answer', () => {
  const sources = [{
    chunk_id: 'c1',
    content: 'Matt Hicks is President and CEO of Red Hat as of 2026.',
    filename: 'leadership-2026.txt',
    relevance: { accepted: true },
    file_modified_at: new Date().toISOString(),
  }];
  const turn = prepareTurnContext({
    currentQuestion: 'Who is the current CEO of Red Hat?',
    priorMessages: [],
    answerMode: 'documents_plus_model',
    relevantSources: sources,
  });
  assert.equal(turn.groundingMode, 'documents+model');
  assert.equal(turn.skipLlm, false);
  assert.equal(turn.groundingBadge, 'DOCUMENTS + MODEL');
  assert.equal(turn.possiblyStale, false);
  assert.ok(turn.messages.length > 0);
  assert.match(turn.messages.at(-1).content, /CURRENT SOURCES/);
});

test('freshness Test E: old leadership document flags possibly stale source', () => {
  const sources = [{
    chunk_id: 'c1',
    content: 'Paul Cormier is CEO of Red Hat.',
    filename: 'redhat-leadership-2020.txt',
    relevance: { accepted: true },
    file_modified_at: '2020-06-01T00:00:00.000Z',
  }];
  const freshness = evaluateSourceFreshness(sources, { freshnessSensitive: true });
  assert.equal(freshness.possiblyStale, true);
  const turn = prepareTurnContext({
    currentQuestion: 'Who is the current CEO of Red Hat?',
    priorMessages: [],
    answerMode: 'documents_only',
    relevantSources: sources,
  });
  assert.equal(turn.groundingMode, 'documents');
  assert.equal(turn.possiblyStale, true);
  assert.match(turn.messages[0].content, /outdated/i);
});

test('answer mode consistency: documents only with no sources is insufficient', () => {
  const turn = prepareTurnContext({
    currentQuestion: 'ceo of redhat',
    priorMessages: [],
    answerMode: 'documents_only',
    relevantSources: [],
  });
  assert.equal(turn.groundingMode, 'insufficient');
  assert.equal(turn.groundingBadge, 'INSUFFICIENT');
});

test('deduplicateChunks limits overlapping passages per document', () => {
  const chunks = [
    { chunk_id: '1', document_id: 'd1', filename: 'a.txt', content: 'NodePort exposes a Service on each node at a static port for access.' },
    { chunk_id: '2', document_id: 'd1', filename: 'a.txt', content: 'NodePort exposes a Service on each node at a static port for external access.' },
    { chunk_id: '3', document_id: 'd1', filename: 'a.txt', content: 'ClusterIP exposes a Service internally within the cluster only.' },
  ];
  const deduped = deduplicateChunks(chunks, { maxChunksPerDocument: 3, contentDedupeOverlap: 0.7 });
  assert.equal(deduped.length, 2);
});

test('vector search ranks by cosine similarity and validates dimensions', () => {
  const query = new Float32Array([1, 0, 0]);
  const chunks = [
    { id: 'near', embedding: vectorToBuffer([0.9, 0.1, 0]) },
    { id: 'far', embedding: vectorToBuffer([0, 1, 0]) },
  ];
  const results = vectorSearch(chunks, query, 2);
  assert.equal(results[0].id, 'near');
  assert.ok(cosineSimilarity(query, new Float32Array([1, 0, 0])) > 0.99);
  assert.throws(() => vectorSearch(chunks, new Float32Array([1, 0]), 2));
});

test('embedding model resolver rejects chat models', () => {
  const models = ['llama3.2:latest', 'nomic-embed-text:latest'];
  assert.equal(isLikelyEmbeddingModel('llama3.2:latest'), false);
  assert.equal(resolveEmbeddingModel('llama3.2:latest', models), 'nomic-embed-text:latest');
});

test('hasRelevantSources requires accepted relevance', () => {
  assert.equal(hasRelevantSources([]), false);
  assert.equal(hasRelevantSources([{ content: 'x', relevance: { accepted: false } }]), false);
  assert.equal(hasRelevantSources([{ content: 'x', relevance: { accepted: true } }]), true);
});

test('citation sanitizer removes invalid source ids', () => {
  const cleaned = sanitizeCitations('See S1 and S9', ['S1']);
  assert.match(cleaned, /S1/);
  assert.doesNotMatch(cleaned, /S9/);
});
