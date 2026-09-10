import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_bases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    knowledge_base_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    page_count INTEGER,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    indexed_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(knowledge_base_id)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256)`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    page_number INTEGER,
    section TEXT,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    embedding BLOB,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(knowledge_base_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    knowledge_base_id UNINDEXED,
    document_id UNINDEXED,
    filename,
    section,
    content,
    tokenize='porter unicode61'
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    knowledge_scope TEXT NOT NULL,
    answer_mode TEXT NOT NULL DEFAULT 'documents_only',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)`,
  `CREATE TABLE IF NOT EXISTS message_sources (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    score REAL NOT NULL,
    rank INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

const DEFAULT_AI_SETTINGS = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  llmModel: '',
  embeddingModel: 'nomic-embed-text',
  answerMode: 'documents_only',
  showCitations: true,
  watchFolders: true,
  requireSources: true,
  contextSize: 'auto',
  cpuThreads: 'auto',
  gpuAcceleration: 'auto',
};

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function createKnowledgeStore(dataDir) {
  const aiDir = path.join(dataDir, 'noa-ai');
  const filesDir = path.join(aiDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const dbPath = path.join(aiDir, 'knowledge.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const sql of MIGRATIONS) db.exec(sql);
  const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get();
  if (!version) {
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)`).run(String(SCHEMA_VERSION));
  }

  for (const [key, value] of Object.entries(DEFAULT_AI_SETTINGS)) {
    const row = db.prepare(`SELECT value FROM ai_settings WHERE key = ?`).get(key);
    if (!row) db.prepare(`INSERT INTO ai_settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
  }

  function getSettings() {
    const rows = db.prepare(`SELECT key, value FROM ai_settings`).all();
    const settings = { ...DEFAULT_AI_SETTINGS };
    for (const row of rows) {
      try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
    }
    return settings;
  }

  function setSettings(patch) {
    const allowed = Object.keys(DEFAULT_AI_SETTINGS);
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        db.prepare(`INSERT INTO ai_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(key, JSON.stringify(patch[key]));
      }
    }
    return getSettings();
  }

  function kbStats(kbId) {
    const docs = db.prepare(`SELECT COUNT(*) AS count FROM documents WHERE knowledge_base_id = ?`).get(kbId).count;
    const chunks = db.prepare(`SELECT COUNT(*) AS count FROM chunks WHERE knowledge_base_id = ?`).get(kbId).count;
    const indexing = db.prepare(`SELECT COUNT(*) AS count FROM documents WHERE knowledge_base_id = ? AND status IN ('pending', 'indexing')`).get(kbId).count;
    return { document_count: docs, chunk_count: chunks, indexing_state: indexing > 0 ? 'indexing' : 'idle' };
  }

  function listKnowledgeBases() {
    return db.prepare(`SELECT * FROM knowledge_bases ORDER BY name COLLATE NOCASE`).all().map(row => ({
      ...row,
      enabled: Boolean(row.enabled),
      ...kbStats(row.id),
    }));
  }

  function createKnowledgeBase({ name, description = '' }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Enter a knowledge base name.');
    const id = newId();
    const ts = nowIso();
    db.prepare(`INSERT INTO knowledge_bases (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(id, trimmed.slice(0, 120), String(description || '').slice(0, 500), ts, ts);
    return listKnowledgeBases().find(kb => kb.id === id);
  }

  function updateKnowledgeBase(id, patch) {
    const kb = db.prepare(`SELECT * FROM knowledge_bases WHERE id = ?`).get(id);
    if (!kb) throw new Error('Knowledge base not found.');
    const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 120) : kb.name;
    const description = patch.description !== undefined ? String(patch.description).slice(0, 500) : kb.description;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : kb.enabled;
    db.prepare(`UPDATE knowledge_bases SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?`)
      .run(name, description, enabled, nowIso(), id);
    return listKnowledgeBases().find(item => item.id === id);
  }

  function deleteKnowledgeBase(id) {
    const tx = db.transaction(() => {
      const chunkIds = db.prepare(`SELECT id FROM chunks WHERE knowledge_base_id = ?`).all(id).map(r => r.id);
      for (const chunkId of chunkIds) {
        db.prepare(`DELETE FROM chunks_fts WHERE chunk_id = ?`).run(chunkId);
      }
      db.prepare(`DELETE FROM knowledge_bases WHERE id = ?`).run(id);
      const dir = path.join(filesDir, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });
    tx();
    return { ok: true };
  }

  function listDocuments(kbId) {
    return db.prepare(`SELECT * FROM documents WHERE knowledge_base_id = ? ORDER BY filename COLLATE NOCASE`).all(kbId);
  }

  function documentChunkCount(documentId) {
    return db.prepare(`SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?`).get(documentId).count;
  }

  function listDocumentsWithStats(kbId) {
    return listDocuments(kbId).map(doc => ({
      ...doc,
      chunk_count: documentChunkCount(doc.id),
    }));
  }

  function resetStuckIndexingDocuments() {
    const stuck = db.prepare(`SELECT id, filename FROM documents WHERE status = 'indexing'`).all();
    for (const doc of stuck) {
      db.prepare(`UPDATE documents SET status = 'pending', error_message = ? WHERE id = ?`)
        .run('Indexing was interrupted. Click Re-index to try again.', doc.id);
    }
    return stuck.length;
  }

  function getDocument(id) {
    return db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  }

  function findDocumentByPath(kbId, filePath) {
    return db.prepare(`SELECT * FROM documents WHERE knowledge_base_id = ? AND path = ?`).get(kbId, filePath);
  }

  function deleteDocumentChunks(documentId) {
    const chunkIds = db.prepare(`SELECT id FROM chunks WHERE document_id = ?`).all(documentId).map(r => r.id);
    for (const chunkId of chunkIds) db.prepare(`DELETE FROM chunks_fts WHERE chunk_id = ?`).run(chunkId);
    db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(documentId);
  }

  function deleteDocument(id) {
    const doc = getDocument(id);
    if (!doc) throw new Error('Document not found.');
    deleteDocumentChunks(id);
    db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    return { ok: true };
  }

  function upsertDocument(record) {
    const existing = record.path ? findDocumentByPath(record.knowledge_base_id, record.path) : null;
    const id = existing?.id || record.id || newId();
    const ts = nowIso();
    if (existing) {
      db.prepare(`UPDATE documents SET filename = ?, path = ?, mime_type = ?, sha256 = ?, size = ?, page_count = ?, modified_at = ?, indexed_at = ?, status = ?, error_message = ? WHERE id = ?`)
        .run(record.filename, record.path, record.mime_type, record.sha256, record.size, record.page_count ?? null,
          record.modified_at || ts, record.indexed_at ?? null, record.status || 'pending', record.error_message ?? null, id);
    } else {
      db.prepare(`INSERT INTO documents (id, knowledge_base_id, filename, path, mime_type, sha256, size, page_count, created_at, modified_at, indexed_at, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, record.knowledge_base_id, record.filename, record.path, record.mime_type, record.sha256, record.size,
          record.page_count ?? null, record.created_at || ts, record.modified_at || ts, record.indexed_at ?? null,
          record.status || 'pending', record.error_message ?? null);
    }
    return getDocument(id);
  }

  function insertChunk(chunk) {
    db.prepare(`INSERT INTO chunks (id, document_id, knowledge_base_id, chunk_index, page_number, section, content, token_count, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(chunk.id, chunk.document_id, chunk.knowledge_base_id, chunk.chunk_index, chunk.page_number,
        chunk.section, chunk.content, chunk.token_count, chunk.embedding);
    db.prepare(`INSERT INTO chunks_fts (chunk_id, knowledge_base_id, document_id, filename, section, content)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chunk.id, chunk.knowledge_base_id, chunk.document_id, chunk.filename, chunk.section || '', chunk.content);
  }

  function getChunksForKnowledgeBases(kbIds) {
    if (!kbIds.length) return [];
    const placeholders = kbIds.map(() => '?').join(',');
    return db.prepare(`SELECT c.*, d.filename FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.knowledge_base_id IN (${placeholders}) AND d.status = 'indexed'`).all(...kbIds);
  }

  function getChunkById(id) {
    return db.prepare(`SELECT c.*, d.filename, d.path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`).get(id);
  }

  function keywordSearch(query, kbIds, limit = 25) {
    if (!kbIds.length || !String(query || '').trim()) return [];
    const placeholders = kbIds.map(() => '?').join(',');
    const terms = String(query).trim().toLowerCase()
      .replace(/[^\w\s\-./:+]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2);
    if (!terms.length) return [];

    const stmt = db.prepare(`SELECT chunk_id, bm25(chunks_fts) AS score, filename, section, content, document_id, knowledge_base_id
      FROM chunks_fts WHERE chunks_fts MATCH ? AND knowledge_base_id IN (${placeholders})
      ORDER BY score LIMIT ?`);

    const seen = new Set();
    const results = [];
    const queries = [
      terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR '),
      ...terms.map(t => `"${t.replace(/"/g, '')}"`),
    ];

    for (const match of queries) {
      try {
        const rows = stmt.all(match, ...kbIds, limit);
        for (const row of rows) {
          if (seen.has(row.chunk_id)) continue;
          seen.add(row.chunk_id);
          results.push(row);
        }
      } catch {
        // skip invalid MATCH expressions
      }
      if (results.length >= limit) break;
    }

    return results.slice(0, limit);
  }

  function listConversations() {
    return db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC`).all();
  }

  function getConversation(id) {
    return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  }

  function createConversation({ title, knowledgeScope, answerMode }) {
    const id = newId();
    const ts = nowIso();
    db.prepare(`INSERT INTO conversations (id, title, knowledge_scope, answer_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, title || 'New conversation', JSON.stringify(knowledgeScope || []), answerMode || 'documents_only', ts, ts);
    return getConversation(id);
  }

  function updateConversation(id, patch) {
    const conv = getConversation(id);
    if (!conv) throw new Error('Conversation not found.');
    const title = patch.title !== undefined ? String(patch.title).slice(0, 200) : conv.title;
    const knowledge_scope = patch.knowledgeScope !== undefined ? JSON.stringify(patch.knowledgeScope) : conv.knowledge_scope;
    db.prepare(`UPDATE conversations SET title = ?, knowledge_scope = ?, updated_at = ? WHERE id = ?`)
      .run(title, knowledge_scope, nowIso(), id);
    return getConversation(id);
  }

  function deleteConversation(id) {
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    return { ok: true };
  }

  function listMessages(conversationId) {
    return db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`).all(conversationId);
  }

  function addMessage({ conversationId, role, content }) {
    const id = newId();
    const ts = nowIso();
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, conversationId, role, content, ts);
    db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(ts, conversationId);
    return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  }

  function addMessageSources(messageId, sources) {
    const insert = db.prepare(`INSERT INTO message_sources (id, message_id, chunk_id, score, rank) VALUES (?, ?, ?, ?, ?)`);
    sources.forEach((source, index) => {
      insert.run(newId(), messageId, source.chunk_id, source.score, index + 1);
    });
  }

  function getMessageSources(messageId) {
    return db.prepare(`SELECT ms.*, c.content, c.page_number, c.section, d.filename, d.path
      FROM message_sources ms
      JOIN chunks c ON c.id = ms.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE ms.message_id = ?
      ORDER BY ms.rank ASC`).all(messageId);
  }

  return {
    db,
    aiDir,
    filesDir,
    getSettings,
    setSettings,
    listKnowledgeBases,
    createKnowledgeBase,
    updateKnowledgeBase,
    deleteKnowledgeBase,
    listDocuments,
    listDocumentsWithStats,
    documentChunkCount,
    resetStuckIndexingDocuments,
    getDocument,
    findDocumentByPath,
    deleteDocument,
    deleteDocumentChunks,
    upsertDocument,
    insertChunk,
    getChunksForKnowledgeBases,
    getChunkById,
    keywordSearch,
    listConversations,
    getConversation,
    createConversation,
    updateConversation,
    deleteConversation,
    listMessages,
    addMessage,
    addMessageSources,
    getMessageSources,
    newId,
    nowIso,
  };
}
