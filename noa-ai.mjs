import fs from 'node:fs';
import path from 'node:path';
import { createKnowledgeStore } from './knowledge/store.mjs';
import { parseDocument, isSupportedFile, detectMime } from './knowledge/parsers.mjs';
import { hashFile, hashBuffer } from './knowledge/hash.mjs';
import { chunkDocument, chunkPages } from './knowledge/chunking.mjs';
import { createOllamaProvider } from './ai/providers/ollama.mjs';
import { buildContextBlock } from './ai/prompt.mjs';
import { prepareTurnContext, resolveRetrievalInput, insufficientDocumentsMessage, finalizeAssistantText } from './ai/chat-turn.mjs';
import { resolveRetrievalQuery } from './ai/query.mjs';
import { vectorSearch, vectorToBuffer } from './retrieval/vector.mjs';
import { mergeHybridResults, HYBRID_DEFAULTS } from './retrieval/hybrid.mjs';
import {
  RELEVANCE_CONFIG,
  extractQueryTerms,
  gateCandidates,
  deduplicateChunks,
  hasRelevantSources,
} from './retrieval/relevance.mjs';
import { isLikelyEmbeddingModel, resolveEmbeddingModel, pickEmbeddingModels, pickChatModels } from './ai/embedding.mjs';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const RAG_DEBUG = process.env.NOA_AI_DEBUG === '1';

function logAi(event, details = {}) {
  const safe = { ...details };
  delete safe.content;
  delete safe.text;
  delete safe.prompt;
  delete safe.preview;
  console.log(`[noa-ai] ${event}`, JSON.stringify(safe));
}

function logRag(stage, details = {}) {
  if (!RAG_DEBUG) return;
  logAi(`rag_${stage}`, details);
}

function previewText(text, max = 150) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function resolveKnowledgeScope(store, { knowledgeBaseIds, allEnabled = false }) {
  const bases = store.listKnowledgeBases();
  if (allEnabled) return bases.filter(kb => kb.enabled).map(kb => kb.id);
  const ids = Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds.filter(Boolean) : [];
  if (!ids.length) {
    const enabled = bases.filter(kb => kb.enabled);
    return enabled.length ? [enabled[0].id] : [];
  }
  return ids.filter(id => bases.some(kb => kb.id === id));
}

export function createNoaAI(dataDir) {
  const store = createKnowledgeStore(dataDir);
  let indexingJob = null;
  let chatAbort = null;

  const resetCount = store.resetStuckIndexingDocuments();
  if (resetCount) logAi('reset_stuck_indexing', { count: resetCount });

  (async () => {
    try {
      const settings = store.getSettings();
      if (!isLikelyEmbeddingModel(settings.embeddingModel)) {
        const provider = getProvider();
        const models = await provider.getModels();
        const fixed = resolveEmbeddingModel('', models);
        if (fixed && fixed !== settings.embeddingModel) {
          store.setSettings({ embeddingModel: fixed });
          logAi('fixed_embedding_model', { from: settings.embeddingModel, to: fixed });
        }
      }
    } catch { /* Ollama may be offline at startup */ }
  })();

  function getProvider() {
    const settings = store.getSettings();
    return createOllamaProvider(settings.ollamaBaseUrl);
  }

  function resolveEmbedModel(models) {
    const settings = store.getSettings();
    const resolved = resolveEmbeddingModel(settings.embeddingModel, models);
    if (!resolved || !isLikelyEmbeddingModel(resolved)) {
      throw new Error(
        'Select an embedding model such as nomic-embed-text in Settings → Noa AI. Chat models like llama3.2 cannot embed documents.',
      );
    }
    return resolved;
  }

  async function getStatus() {
    const settings = store.getSettings();
    const provider = getProvider();
    const available = await provider.isAvailable();
    let models = [];
    if (available) {
      try { models = await provider.getModels(); } catch { models = []; }
    }
    const embeddingModels = pickEmbeddingModels(models);
    const chatModels = pickChatModels(models);
    const resolvedEmbed = resolveEmbeddingModel(settings.embeddingModel, models);
    const llmInstalled = settings.llmModel ? models.includes(settings.llmModel) : false;
    const embedInstalled = resolvedEmbed ? models.includes(resolvedEmbed) : false;
    const embedModelValid = Boolean(resolvedEmbed && isLikelyEmbeddingModel(resolvedEmbed));
    let embeddingSmokeTest = null;
    if (available && embedModelValid) {
      try {
        embeddingSmokeTest = await provider.smokeTestEmbedding(resolvedEmbed);
      } catch (error) {
        embeddingSmokeTest = { ok: false, error: error.message };
      }
    }
    return {
      engine: 'local',
      provider: 'ollama',
      ollamaAvailable: available,
      models,
      chatModels,
      embeddingModels,
      llmModel: settings.llmModel,
      embeddingModel: settings.embeddingModel,
      resolvedEmbeddingModel: resolvedEmbed,
      embedModelValid,
      llmInstalled,
      embedInstalled,
      embeddingSmokeTest,
      dataLocation: store.aiDir,
      indexing: indexingJob ? { ...indexingJob.publicState } : null,
      cloudAi: false,
      internetRequired: false,
    };
  }

  async function retrieveDetailed(query, kbIds, options = {}) {
    const provider = getProvider();
    const scope = resolveKnowledgeScope(store, { knowledgeBaseIds: kbIds });
    const retrievalQuery = String(query || '').trim();
    const originalQuery = String(options.originalQuery || retrievalQuery).trim();
    const queryTerms = extractQueryTerms(originalQuery);

    const diagnostic = {
      query: originalQuery,
      retrievalQuery,
      queryTerms,
      knowledgeBaseIds: scope,
      chunksInScope: 0,
      queryEmbeddingDimensions: null,
      vectorCandidates: [],
      ftsCandidates: [],
      mergedCandidates: [],
      postFilter: [],
      finalSources: [],
      errors: [],
    };

    if (!scope.length) {
      diagnostic.errors.push('No knowledge base selected for retrieval.');
      return { results: [], diagnostic };
    }

    const chunks = store.getChunksForKnowledgeBases(scope);
    diagnostic.chunksInScope = chunks.length;
    logRag('retrieve_start', { query: previewText(originalQuery), retrievalQuery: previewText(retrievalQuery), kbIds: scope, chunks: chunks.length });

    let vectorResults = [];
    let embedModel = null;
    try {
      embedModel = resolveEmbedModel(await provider.getModels().catch(() => []));
    } catch (error) {
      diagnostic.errors.push(error.message);
    }
    if (embedModel && chunks.some(c => c.embedding)) {
      try {
        const queryEmbedding = await provider.embedText(retrievalQuery, embedModel);
        diagnostic.queryEmbeddingDimensions = queryEmbedding.length;
        const queryVector = new Float32Array(queryEmbedding);
        vectorResults = vectorSearch(chunks, queryVector, RELEVANCE_CONFIG.vectorCandidateLimit, { minScore: 0 });
      } catch (error) {
        diagnostic.errors.push(error.message);
        logAi('embed_query_failed', { error: error.message });
      }
    } else {
      diagnostic.errors.push('No embedded chunks found in the selected knowledge base. Re-index documents with a valid embedding model.');
    }

    const keywordResults = store.keywordSearch(retrievalQuery, scope, RELEVANCE_CONFIG.ftsCandidateLimit);
    const vectorRank = new Map(vectorResults.map((item, index) => [item.chunk_id || item.id, index + 1]));
    const ftsRank = new Map(keywordResults.map((item, index) => [item.chunk_id, index + 1]));

    diagnostic.vectorCandidates = vectorResults.map((item, index) => {
      const evaluation = gateCandidates([{
        ...item,
        chunk_id: item.chunk_id || item.id,
        vector_score: item.score,
        keyword_score: 0,
      }], queryTerms).evaluated[0]?.relevance;
      return {
        rank: index + 1,
        chunkId: item.chunk_id || item.id,
        file: item.filename,
        cosine: item.score,
        ftsRank: ftsRank.get(item.chunk_id || item.id) || null,
        lexicalOverlap: evaluation?.overlap?.matchedTerms ?? 0,
        accepted: evaluation?.accepted ?? false,
        rejectReason: evaluation?.rejectReason || null,
        preview: previewText(item.content, 100),
      };
    });

    diagnostic.ftsCandidates = keywordResults.map((item, index) => {
      const evaluation = gateCandidates([{
        ...item,
        chunk_id: item.chunk_id,
        vector_score: 0,
        keyword_score: Math.abs(item.score || 0),
      }], queryTerms).evaluated[0]?.relevance;
      return {
        rank: index + 1,
        chunkId: item.chunk_id,
        bm25: item.score,
        vectorRank: vectorRank.get(item.chunk_id) || null,
        lexicalOverlap: evaluation?.overlap?.matchedTerms ?? 0,
        accepted: evaluation?.accepted ?? false,
        rejectReason: evaluation?.rejectReason || null,
        preview: previewText(item.content, 100),
      };
    });

    const merged = mergeHybridResults({
      vectorResults,
      keywordResults,
      limit: RELEVANCE_CONFIG.mergePoolLimit,
    });

    diagnostic.mergedCandidates = merged.map((item, index) => ({
      rank: index + 1,
      chunkId: item.chunk_id || item.id,
      file: item.filename,
      vectorRank: vectorRank.get(item.chunk_id || item.id) || null,
      ftsRank: ftsRank.get(item.chunk_id || item.id) || null,
      rrf: item.rrf,
      cosine: item.vector_score,
      bm25: item.keyword_score,
    }));

    const { evaluated, accepted } = gateCandidates(merged, queryTerms);
    diagnostic.postFilter = evaluated.map(item => ({
      chunkId: item.chunk_id || item.id,
      file: item.filename,
      cosine: item.relevance.vectorScore,
      lexicalOverlap: item.relevance.overlap?.matchedTerms ?? 0,
      accepted: item.relevance.accepted,
      rejectReason: item.relevance.rejectReason || item.relevance.acceptReason || null,
    }));

    const deduped = deduplicateChunks(accepted).slice(0, RELEVANCE_CONFIG.finalContextLimit);
    const results = deduped.map(item => {
      const doc = item.document_id ? store.getDocument(item.document_id) : null;
      return {
        chunk_id: item.chunk_id || item.id,
        score: item.relevance?.vectorScore || item.vector_score || 0,
        content: item.content,
        filename: item.filename,
        section: item.section,
        page_number: item.page_number,
        document_id: item.document_id,
        knowledge_base_id: item.knowledge_base_id,
        relevance: item.relevance,
        file_modified_at: doc?.modified_at || null,
        indexed_at: doc?.indexed_at || null,
      };
    });

    diagnostic.finalSources = results.map(item => ({
      chunkId: item.chunk_id,
      file: item.filename,
      cosine: item.score,
      lexicalOverlap: item.relevance?.overlap?.matchedTerms ?? 0,
      preview: previewText(item.content, 100),
    }));

    logRag('retrieve_done', {
      query: previewText(originalQuery),
      retrievalQuery: previewText(retrievalQuery),
      candidateCount: merged.length,
      acceptedCount: accepted.length,
      finalCount: results.length,
      topCosine: diagnostic.vectorCandidates[0]?.cosine ?? null,
    });

    return { results, diagnostic };
  }

  async function retrieve(query, kbIds, options = {}) {
    const { results } = await retrieveDetailed(query, kbIds, options);
    return results;
  }

  async function retrieveForTurn(currentQuestion, knowledgeBaseIds, priorMessages) {
    const { currentQuestion: question, retrievalQuery } = resolveRetrievalInput(currentQuestion, priorMessages);
    const { results, diagnostic } = await retrieveDetailed(retrievalQuery, knowledgeBaseIds, {
      originalQuery: question,
    });
    return { currentQuestion: question, retrievalQuery, results, diagnostic };
  }

  function validateLocalPath(inputPath) {
    const resolved = path.resolve(String(inputPath || '').trim());
    if (!path.isAbsolute(resolved)) throw new Error('Enter a full path on this computer.');
    if (!fs.existsSync(resolved)) throw new Error('Path not found.');
    return resolved;
  }

  function collectFilesFromPath(targetPath) {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return isSupportedFile(targetPath) ? [targetPath] : [];
    if (!stat.isDirectory()) return [];
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && isSupportedFile(full)) files.push(full);
      }
    };
    walk(targetPath);
    return files;
  }

  function copyToStore(kbId, docId, sourcePath) {
    const filename = path.basename(sourcePath);
    const destDir = path.join(store.filesDir, kbId, docId);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, filename);
    fs.copyFileSync(sourcePath, dest);
    return dest;
  }

  async function indexDocument(doc, { onProgress, signal }) {
    if (signal?.aborted) throw new Error('Indexing cancelled.');
    const sourcePath = doc.path;
    const stat = fs.statSync(sourcePath);
    const sha256 = hashFile(sourcePath);
    const fileType = detectMime(doc.filename);

    logRag('file_received', {
      documentId: doc.id,
      filename: doc.filename,
      path: sourcePath,
      size: stat.size,
      fileType,
      knowledgeBaseId: doc.knowledge_base_id,
    });

    if (doc.sha256 === sha256 && doc.status === 'indexed' && store.documentChunkCount(doc.id) > 0) {
      logAi('index_skip_unchanged', { documentId: doc.id, filename: doc.filename });
      return doc;
    }

    store.deleteDocumentChunks(doc.id);
    store.upsertDocument({ ...doc, sha256, size: stat.size, modified_at: stat.mtime.toISOString(), status: 'indexing', error_message: null });

    let parsed;
    try {
      parsed = await parseDocument(sourcePath);
    } catch (error) {
      store.upsertDocument({ ...doc, sha256, size: stat.size, status: 'error', error_message: error.message });
      logAi('parse_failed', { documentId: doc.id, error: error.message });
      throw error;
    }

    const extractedChars = String(parsed.text || '').length;
    logRag('parsed', {
      documentId: doc.id,
      extractedChars,
      preview: previewText(parsed.text),
      pageCount: parsed.page_count ?? null,
      status: parsed.status || 'indexed',
    });

    if (parsed.status === 'scanned_ocr_required') {
      store.upsertDocument({
        ...doc, sha256, size: stat.size, page_count: parsed.page_count, status: 'scanned_ocr_required',
        error_message: 'Scanned document — OCR required',
        indexed_at: store.nowIso(),
      });
      return store.getDocument(doc.id);
    }

    const chunks = parsed.pages?.length
      ? chunkPages(parsed.pages)
      : chunkDocument(parsed.text || '', { page: null });

    logRag('chunked', { documentId: doc.id, chunkCount: chunks.length });
    onProgress?.({ phase: 'chunks', current: 0, total: chunks.length, filename: doc.filename });

    if (!chunks.length) {
      const message = 'No searchable text chunks were created from this document.';
      store.upsertDocument({ ...doc, sha256, size: stat.size, status: 'error', error_message: message });
      throw new Error(message);
    }

    const provider = getProvider();
    const models = await provider.getModels();
    const embedModel = resolveEmbedModel(models);

    const texts = chunks.map(c => c.content);
    let embeddings;
    try {
      embeddings = await provider.embedBatch(texts, embedModel, {
        onProgress: ({ current, total }) => onProgress?.({ phase: 'embeddings', current, total, filename: doc.filename }),
        signal,
      });
    } catch (error) {
      store.upsertDocument({ ...doc, sha256, size: stat.size, status: 'error', error_message: error.message });
      logAi('embed_failed', { documentId: doc.id, model: embedModel, error: error.message });
      throw error;
    }

    logRag('embedded', {
      documentId: doc.id,
      embeddingRequests: embeddings.length,
      embeddingDimensions: embeddings[0]?.length ?? 0,
      model: embedModel,
    });

    const tx = store.db.transaction(() => {
      for (let i = 0; i < chunks.length; i += 1) {
        if (signal?.aborted) throw new Error('Indexing cancelled.');
        const chunk = chunks[i];
        store.insertChunk({
          id: store.newId(),
          document_id: doc.id,
          knowledge_base_id: doc.knowledge_base_id,
          chunk_index: chunk.chunk_index,
          page_number: chunk.page_number,
          section: chunk.section,
          content: chunk.content,
          token_count: chunk.token_count,
          embedding: vectorToBuffer(embeddings[i]),
          filename: doc.filename,
        });
      }
    });
    tx();

    store.upsertDocument({
      ...doc,
      sha256,
      size: stat.size,
      page_count: parsed.page_count ?? null,
      status: 'indexed',
      indexed_at: store.nowIso(),
      error_message: null,
    });
    logAi('index_complete', {
      documentId: doc.id,
      chunks: chunks.length,
      ftsRows: store.documentChunkCount(doc.id),
      embeddingDimensions: embeddings[0]?.length ?? 0,
    });
    return store.getDocument(doc.id);
  }

  async function runIndexing({ kbId, documentIds, reindexAll = false }, handlers = {}) {
    if (indexingJob?.running) throw new Error('Indexing already in progress.');
    const abort = new AbortController();
    const docs = reindexAll
      ? store.listDocuments(kbId)
      : store.listDocuments(kbId).filter(doc => documentIds?.includes(doc.id));

    indexingJob = {
      running: true,
      kbId,
      cancel: () => abort.abort(),
      publicState: { kbId, phase: 'starting', current: 0, total: docs.length, filename: '' },
    };

    try {
      for (let i = 0; i < docs.length; i += 1) {
        if (abort.signal.aborted) break;
        const doc = docs[i];
        indexingJob.publicState = { kbId, phase: 'reading', current: i + 1, total: docs.length, filename: doc.filename };
        handlers.onProgress?.(indexingJob.publicState);
        try {
          await indexDocument(doc, {
            signal: abort.signal,
            onProgress: (detail) => {
              indexingJob.publicState = { kbId, ...detail, current: i + 1, total: docs.length };
              handlers.onProgress?.(indexingJob.publicState);
            },
          });
        } catch (error) {
          logAi('index_document_failed', { documentId: doc.id, filename: doc.filename, error: error.message });
          if (!abort.signal.aborted) {
            store.upsertDocument({
              ...store.getDocument(doc.id),
              status: 'error',
              error_message: error.message,
            });
          }
        }
      }
    } finally {
      indexingJob.running = false;
      indexingJob = null;
    }
    return { indexed: docs.length, cancelled: abort.signal.aborted };
  }

  function registerDocumentFromPath(kbId, sourcePath) {
    const resolved = validateLocalPath(sourcePath);
    const stat = fs.statSync(resolved);
    const sha256 = hashFile(resolved);
    const existing = store.findDocumentByPath(kbId, resolved);
    if (existing && existing.sha256 === sha256 && existing.status === 'indexed') return existing;

    const docId = existing?.id || store.newId();
    const storedPath = copyToStore(kbId, docId, resolved);
    const doc = store.upsertDocument({
      id: docId,
      knowledge_base_id: kbId,
      filename: path.basename(resolved),
      path: storedPath,
      mime_type: detectMime(resolved),
      sha256,
      size: stat.size,
      created_at: existing?.created_at || store.nowIso(),
      modified_at: stat.mtime.toISOString(),
      status: existing?.sha256 === sha256 ? existing.status : 'pending',
    });
    return doc;
  }

  function registerUploadedFile(kbId, filename, buffer) {
    if (Buffer.byteLength(buffer) > MAX_UPLOAD_BYTES) throw new Error('File is too large (max 50 MB).');
    if (!isSupportedFile(filename)) throw new Error('Unsupported file type.');
    const docId = store.newId();
    const destDir = path.join(store.filesDir, kbId, docId);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(filename));
    fs.writeFileSync(dest, buffer);
    const sha256 = hashBuffer(buffer);
    const stat = fs.statSync(dest);
    return store.upsertDocument({
      id: docId,
      knowledge_base_id: kbId,
      filename: path.basename(filename),
      path: dest,
      mime_type: detectMime(filename),
      sha256,
      size: stat.size,
      created_at: store.nowIso(),
      modified_at: stat.mtime.toISOString(),
      status: 'pending',
    });
  }

  async function chat({ conversationId, message, knowledgeBaseIds, answerMode, temporaryContext }) {
    const settings = store.getSettings();
    const mode = answerMode || settings.answerMode || 'documents_only';
    if (!settings.llmModel) throw new Error('A local AI model is required before Noa can answer questions.');

    let conversation = conversationId ? store.getConversation(conversationId) : null;
    if (!conversation) {
      conversation = store.createConversation({
        title: message.slice(0, 80) || 'New conversation',
        knowledgeScope: knowledgeBaseIds || [],
        answerMode: mode,
      });
    }

    const priorMessages = store.listMessages(conversation.id);
    store.addMessage({ conversationId: conversation.id, role: 'user', content: message });
    const { currentQuestion, retrievalQuery, results, diagnostic } = await retrieveForTurn(message, knowledgeBaseIds, priorMessages);
    const turn = prepareTurnContext({
      currentQuestion,
      priorMessages,
      answerMode: mode,
      relevantSources: results,
      temporaryContext,
    });

    logRag('chat_turn', {
      conversationId: conversation.id,
      answerMode: mode,
      retrievalCount: turn.retrievalCount,
      groundingMode: turn.groundingMode,
      groundingBadge: turn.groundingBadge,
      freshnessSensitive: turn.freshnessSensitive,
      skipLlm: turn.skipLlm,
      currentQuestion: previewText(currentQuestion),
      retrievalQuery: previewText(retrievalQuery),
    });

    if (mode === 'documents_only' && turn.groundingMode === 'insufficient') {
      const assistantText = insufficientDocumentsMessage();
      const assistant = store.addMessage({ conversationId: conversation.id, role: 'assistant', content: assistantText });
      return {
        conversationId: conversation.id,
        message: assistant,
        sources: [],
        groundingMode: turn.groundingMode,
        groundingBadge: turn.groundingBadge,
        freshnessSensitive: turn.freshnessSensitive,
        usedSourceIds: [],
        diagnostic,
        streamed: false,
      };
    }

    if (turn.skipLlm && turn.deterministicResponse) {
      const assistant = store.addMessage({ conversationId: conversation.id, role: 'assistant', content: turn.deterministicResponse });
      return {
        conversationId: conversation.id,
        message: assistant,
        sources: [],
        groundingMode: turn.groundingMode,
        groundingBadge: turn.groundingBadge,
        freshnessSensitive: turn.freshnessSensitive,
        usedSourceIds: [],
        diagnostic,
        streamed: false,
      };
    }

    const provider = getProvider();
    if (!(await provider.isAvailable())) throw new Error('Local AI engine is unavailable.');

    let fullText = '';
    chatAbort = new AbortController();
    for await (const token of provider.streamChat(turn.messages, { model: settings.llmModel, signal: chatAbort.signal })) {
      fullText += token;
    }
    chatAbort = null;

    fullText = finalizeAssistantText(fullText, turn.usedSourceIds);
    const assistant = store.addMessage({ conversationId: conversation.id, role: 'assistant', content: fullText });
    if (turn.contextSources.length) {
      store.addMessageSources(assistant.id, turn.contextSources.map((source, index) => ({
        chunk_id: source.chunk_id,
        score: source.score,
        rank: index + 1,
      })));
    }

    return {
      conversationId: conversation.id,
      message: assistant,
      sources: turn.contextSources.length ? store.getMessageSources(assistant.id) : [],
      groundingMode: turn.groundingMode,
      groundingBadge: turn.groundingBadge,
      freshnessSensitive: turn.freshnessSensitive,
      usedSourceIds: turn.usedSourceIds,
      diagnostic,
      streamed: true,
    };
  }

  async function streamChat(req, res, payload) {
    const settings = store.getSettings();
    const mode = payload.answerMode || settings.answerMode || 'documents_only';
    if (!settings.llmModel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A local AI model is required before Noa can answer questions.' }));
      return;
    }

    const message = String(payload.message || '').trim();
    if (!message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Enter a question.' }));
      return;
    }

    let conversation = payload.conversationId ? store.getConversation(payload.conversationId) : null;
    if (!conversation) {
      conversation = store.createConversation({
        title: message.slice(0, 80),
        knowledgeScope: payload.knowledgeBaseIds || [],
        answerMode: mode,
      });
    }
    const priorMessages = store.listMessages(conversation.id);
    store.addMessage({ conversationId: conversation.id, role: 'user', content: message });

    const { currentQuestion, retrievalQuery, results, diagnostic } = await retrieveForTurn(
      message,
      payload.knowledgeBaseIds,
      priorMessages,
    );
    const turn = prepareTurnContext({
      currentQuestion,
      priorMessages,
      answerMode: mode,
      relevantSources: results,
      temporaryContext: payload.temporaryContext,
    });

    logRag('chat_turn', {
      conversationId: conversation.id,
      answerMode: mode,
      retrievalCount: turn.retrievalCount,
      groundingMode: turn.groundingMode,
      groundingBadge: turn.groundingBadge,
      freshnessSensitive: turn.freshnessSensitive,
      skipLlm: turn.skipLlm,
      currentQuestion: previewText(currentQuestion),
      retrievalQuery: previewText(retrievalQuery),
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (mode === 'documents_only' && turn.groundingMode === 'insufficient') {
      const text = insufficientDocumentsMessage();
      const assistant = store.addMessage({ conversationId: conversation.id, role: 'assistant', content: text });
      send('meta', {
        conversationId: conversation.id,
        messageId: assistant.id,
        sources: [],
        groundingMode: turn.groundingMode,
        groundingBadge: turn.groundingBadge,
        freshnessSensitive: turn.freshnessSensitive,
        usedSourceIds: [],
        retrievalQuery,
      });
      send('token', { text });
      send('done', { ok: true, groundingMode: turn.groundingMode, groundingBadge: turn.groundingBadge, usedSourceIds: [] });
      res.end();
      return;
    }

    if (turn.skipLlm && turn.deterministicResponse) {
      const assistant = store.addMessage({ conversationId: conversation.id, role: 'assistant', content: turn.deterministicResponse });
      send('meta', {
        conversationId: conversation.id,
        messageId: assistant.id,
        sources: [],
        groundingMode: turn.groundingMode,
        groundingBadge: turn.groundingBadge,
        freshnessSensitive: turn.freshnessSensitive,
        usedSourceIds: [],
        retrievalQuery,
      });
      send('token', { text: turn.deterministicResponse });
      send('done', {
        ok: true,
        conversationId: conversation.id,
        messageId: assistant.id,
        sources: [],
        groundingMode: turn.groundingMode,
        groundingBadge: turn.groundingBadge,
        freshnessSensitive: turn.freshnessSensitive,
        usedSourceIds: [],
      });
      res.end();
      return;
    }

    const provider = getProvider();
    if (!(await provider.isAvailable())) {
      send('error', { error: 'Local AI engine is unavailable.' });
      res.end();
      return;
    }

    let fullText = '';
    chatAbort = new AbortController();
    send('meta', {
      conversationId: conversation.id,
      sources: turn.contextSources,
      groundingMode: turn.groundingMode,
      groundingBadge: turn.groundingBadge,
      freshnessSensitive: turn.freshnessSensitive,
      possiblyStale: turn.possiblyStale,
      usedSourceIds: turn.usedSourceIds,
      retrievalQuery,
      diagnostic: RAG_DEBUG ? diagnostic : undefined,
    });
    logRag('prompt_context', {
      conversationId: conversation.id,
      groundingMode: turn.groundingMode,
      sourceCount: turn.contextSources.length,
      contextChars: turn.contextSources.length ? buildContextBlock(turn.contextSources).length : 0,
      currentQuestion: previewText(currentQuestion),
    });

    try {
      for await (const token of provider.streamChat(turn.messages, { model: settings.llmModel, signal: chatAbort.signal })) {
        fullText += token;
        send('token', { text: token });
      }
    } catch (error) {
      send('error', { error: error.message || 'Generation failed.' });
      res.end();
      return;
    } finally {
      chatAbort = null;
    }

    fullText = finalizeAssistantText(fullText, turn.usedSourceIds);
    const assistant = store.addMessage({ conversationId: conversation.id, role: 'assistant', content: fullText });
    if (turn.contextSources.length) {
      store.addMessageSources(assistant.id, turn.contextSources.map((source, index) => ({
        chunk_id: source.chunk_id,
        score: source.score,
        rank: index + 1,
      })));
    }
    send('done', {
      conversationId: conversation.id,
      messageId: assistant.id,
      sources: turn.contextSources.length ? store.getMessageSources(assistant.id) : [],
      groundingMode: turn.groundingMode,
      groundingBadge: turn.groundingBadge,
      freshnessSensitive: turn.freshnessSensitive,
      possiblyStale: turn.possiblyStale,
      usedSourceIds: turn.usedSourceIds,
    });
    res.end();
  }

  function cancelChat() {
    chatAbort?.abort();
    chatAbort = null;
  }

  function cancelIndexing() {
    indexingJob?.cancel();
  }

  async function readJsonBody(req, maxBytes = 1024 * 1024) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) throw new Error('Request too large.');
    }
    return body ? JSON.parse(body) : {};
  }

  async function handleApi(url, req, res, json) {
    const pathname = url.pathname;

    if (pathname === '/api/ai/status' && req.method === 'GET') {
      json(200, await getStatus());
      return true;
    }
    if (pathname === '/api/ai/settings' && req.method === 'GET') {
      json(200, { ...store.getSettings(), dataLocation: store.aiDir });
      return true;
    }
    if (pathname === '/api/ai/settings' && req.method === 'PUT') {
      try {
        const payload = await readJsonBody(req, 8192);
        if (payload.embeddingModel && !isLikelyEmbeddingModel(payload.embeddingModel)) {
          json(400, { error: 'Choose an embedding model such as nomic-embed-text. Chat models like llama3.2 cannot create document embeddings.' });
          return true;
        }
        if (payload.llmModel && isLikelyEmbeddingModel(payload.llmModel)) {
          json(400, { error: 'Choose a chat model such as llama3.2 for answers, not an embedding model.' });
          return true;
        }
        const saved = store.setSettings(payload);
        json(200, { ...saved, dataLocation: store.aiDir });
      } catch (error) {
        json(400, { error: error.message || 'Could not save AI settings.' });
      }
      return true;
    }
    if (pathname === '/api/ai/knowledge' && req.method === 'GET') {
      json(200, { knowledgeBases: store.listKnowledgeBases() });
      return true;
    }
    if (pathname === '/api/ai/knowledge' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        json(201, store.createKnowledgeBase(payload));
      } catch (error) {
        json(400, { error: error.message || 'Could not create knowledge base.' });
      }
      return true;
    }

    const kbMatch = pathname.match(/^\/api\/ai\/knowledge\/([^/]+)$/);
    if (kbMatch) {
      const kbId = kbMatch[1];
      if (req.method === 'PATCH') {
        try {
          const payload = await readJsonBody(req);
          json(200, store.updateKnowledgeBase(kbId, payload));
        } catch (error) {
          json(400, { error: error.message || 'Could not update knowledge base.' });
        }
        return true;
      }
      if (req.method === 'DELETE') {
        try {
          json(200, store.deleteKnowledgeBase(kbId));
        } catch (error) {
          json(400, { error: error.message || 'Could not delete knowledge base.' });
        }
        return true;
      }
    }

    const kbDocsMatch = pathname.match(/^\/api\/ai\/knowledge\/([^/]+)\/documents$/);
    if (kbDocsMatch && req.method === 'GET') {
      const settings = store.getSettings();
      json(200, {
        documents: store.listDocumentsWithStats(kbDocsMatch[1]),
        embeddingModel: settings.embeddingModel,
      });
      return true;
    }
    if (kbDocsMatch && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req, 1024 * 1024);
        const kbId = kbDocsMatch[1];
        const added = [];
        if (payload.path) {
          for (const filePath of collectFilesFromPath(validateLocalPath(payload.path))) {
            added.push(registerDocumentFromPath(kbId, filePath));
          }
        }
        if (payload.paths?.length) {
          for (const item of payload.paths) {
            for (const filePath of collectFilesFromPath(validateLocalPath(item))) {
              added.push(registerDocumentFromPath(kbId, filePath));
            }
          }
        }
        if (payload.files?.length) {
          for (const file of payload.files) {
            const buffer = Buffer.from(file.data, 'base64');
            added.push(registerUploadedFile(kbId, file.name, buffer));
          }
        }
        const docIds = added.map(doc => doc.id);
        if (docIds.length && !indexingJob?.running) {
          setImmediate(() => {
            runIndexing({ kbId, documentIds: docIds }).catch(error => logAi('index_failed', { error: error.message }));
          });
        }
        json(201, { documents: added, indexing: Boolean(docIds.length) });
      } catch (error) {
        json(400, { error: error.message || 'Could not add documents.' });
      }
      return true;
    }

    const indexMatch = pathname.match(/^\/api\/ai\/knowledge\/([^/]+)\/index$/);
    if (indexMatch && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        const kbId = indexMatch[1];
        if (indexingJob?.running) {
          json(409, { error: 'Indexing already in progress.' });
          return true;
        }
        setImmediate(() => {
          runIndexing({
            kbId,
            documentIds: payload.documentIds,
            reindexAll: Boolean(payload.reindexAll),
          }).catch(error => logAi('index_failed', { error: error.message }));
        });
        json(202, { started: true });
      } catch (error) {
        json(400, { error: error.message || 'Could not start indexing.' });
      }
      return true;
    }

    const reindexMatch = pathname.match(/^\/api\/ai\/knowledge\/([^/]+)\/reindex$/);
    if (reindexMatch && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        const result = await runIndexing({
          kbId: reindexMatch[1],
          documentIds: payload.documentIds,
          reindexAll: Boolean(payload.reindexAll),
        });
        json(200, result);
      } catch (error) {
        json(400, { error: error.message || 'Indexing failed.' });
      }
      return true;
    }

    const docMatch = pathname.match(/^\/api\/ai\/documents\/([^/]+)$/);
    if (docMatch && req.method === 'DELETE') {
      try {
        json(200, store.deleteDocument(docMatch[1]));
      } catch (error) {
        json(400, { error: error.message || 'Could not delete document.' });
      }
      return true;
    }

    if (pathname === '/api/ai/indexing/status' && req.method === 'GET') {
      json(200, { indexing: indexingJob ? { ...indexingJob.publicState, running: indexingJob.running } : null });
      return true;
    }
    if (pathname === '/api/ai/indexing/cancel' && req.method === 'POST') {
      cancelIndexing();
      json(200, { ok: true });
      return true;
    }

    if (pathname === '/api/ai/conversations' && req.method === 'GET') {
      json(200, { conversations: store.listConversations() });
      return true;
    }
    if (pathname === '/api/ai/conversations' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        json(201, store.createConversation(payload));
      } catch (error) {
        json(400, { error: error.message || 'Could not create conversation.' });
      }
      return true;
    }

    const convMatch = pathname.match(/^\/api\/ai\/conversations\/([^/]+)$/);
    if (convMatch) {
      const convId = convMatch[1];
      if (req.method === 'GET') {
        const conversation = store.getConversation(convId);
        if (!conversation) { json(404, { error: 'Conversation not found.' }); return true; }
        const messages = store.listMessages(convId).map(message => ({
          ...message,
          sources: message.role === 'assistant' ? store.getMessageSources(message.id) : [],
        }));
        json(200, { conversation, messages });
        return true;
      }
      if (req.method === 'PATCH') {
        try {
          const payload = await readJsonBody(req);
          json(200, store.updateConversation(convId, payload));
        } catch (error) {
          json(400, { error: error.message || 'Could not update conversation.' });
        }
        return true;
      }
      if (req.method === 'DELETE') {
        json(200, store.deleteConversation(convId));
        return true;
      }
    }

    if (pathname === '/api/ai/search' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        const { results, diagnostic } = await retrieveDetailed(payload.query, payload.knowledgeBaseIds);
        json(200, { results, diagnostic: RAG_DEBUG ? diagnostic : undefined });
      } catch (error) {
        json(400, { error: error.message || 'Search failed.' });
      }
      return true;
    }

    if (pathname === '/api/ai/debug/retrieve' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        const kbIds = payload.knowledgeBaseId ? [payload.knowledgeBaseId] : payload.knowledgeBaseIds;
        const priorMessages = Array.isArray(payload.priorMessages) ? payload.priorMessages : [];
        const { retrievalQuery } = resolveRetrievalInput(payload.query, priorMessages);
        const { results, diagnostic } = await retrieveDetailed(retrievalQuery, kbIds, {
          originalQuery: payload.query,
        });
        const scope = resolveKnowledgeScope(store, { knowledgeBaseIds: kbIds });
        json(200, {
          ...diagnostic,
          documents: scope.flatMap(id => store.listDocumentsWithStats(id)),
          finalSources: results,
        });
      } catch (error) {
        json(400, { error: error.message || 'Retrieval debug failed.' });
      }
      return true;
    }

    if (pathname === '/api/ai/chat' && req.method === 'POST') {
      try {
        const payload = await readJsonBody(req, 256 * 1024);
        if (payload.stream) {
          await streamChat(req, res, payload);
          return true;
        }
        const result = await chat(payload);
        json(200, result);
      } catch (error) {
        json(400, { error: error.message || 'Chat failed.' });
      }
      return true;
    }

    if (pathname === '/api/ai/chat/cancel' && req.method === 'POST') {
      cancelChat();
      json(200, { ok: true });
      return true;
    }

    const chunkMatch = pathname.match(/^\/api\/ai\/chunks\/([^/]+)$/);
    if (chunkMatch && req.method === 'GET') {
      const chunk = store.getChunkById(chunkMatch[1]);
      if (!chunk) { json(404, { error: 'Chunk not found.' }); return true; }
      json(200, { chunk });
      return true;
    }

    return false;
  }

  return {
    store,
    getStatus,
    retrieve,
    retrieveDetailed,
    runIndexing,
    chat,
    streamChat,
    cancelChat,
    cancelIndexing,
    handleApi,
    registerDocumentFromPath,
    registerUploadedFile,
  };
}
