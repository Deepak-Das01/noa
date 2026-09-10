import { assertEmbeddingVector } from '../embedding.mjs';

export function createOllamaProvider(baseUrl = 'http://127.0.0.1:11434') {
  const normalized = String(baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');

  async function request(path, options = {}) {
    const response = await fetch(`${normalized}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text || `Ollama request failed (${response.status}).`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) message = parsed.error;
      } catch { /* use raw text */ }
      throw new Error(message);
    }
    return response;
  }

  function extractEmbedding(data) {
    if (Array.isArray(data?.embedding) && data.embedding.length) return data.embedding;
    if (Array.isArray(data?.embeddings?.[0]) && data.embeddings[0].length) return data.embeddings[0];
    return null;
  }

  return {
    name: 'ollama',
    baseUrl: normalized,

    async isAvailable() {
      try {
        const response = await fetch(`${normalized}/api/tags`, { method: 'GET' });
        return response.ok;
      } catch {
        return false;
      }
    },

    async getModels() {
      const response = await request('/api/tags');
      const data = await response.json();
      return (data.models || []).map(model => model.name);
    },

    async getModelInfo(model) {
      try {
        const response = await request('/api/show', { method: 'POST', body: JSON.stringify({ name: model }) });
        return await response.json();
      } catch {
        return null;
      }
    },

    async embedText(text, model) {
      const trimmed = String(text || '').trim();
      if (!trimmed) throw new Error('Cannot embed empty text.');

      let data;
      try {
        const response = await request('/api/embed', {
          method: 'POST',
          body: JSON.stringify({ model, input: trimmed }),
        });
        data = await response.json();
      } catch (error) {
        const message = String(error.message || '');
        if (!/not found|404/i.test(message)) {
          try {
            const response = await request('/api/embeddings', {
              method: 'POST',
              body: JSON.stringify({ model, prompt: trimmed }),
            });
            data = await response.json();
          } catch (fallbackError) {
            throw new Error(
              `${fallbackError.message} Use an embedding model such as nomic-embed-text, not a chat model like llama3.2.`,
            );
          }
        } else {
          throw error;
        }
      }

      const embedding = extractEmbedding(data);
      if (!embedding) {
        throw new Error(
          `Embedding model "${model}" returned no vector. Use an embedding model such as nomic-embed-text.`,
        );
      }
      assertEmbeddingVector(embedding, { expectedModel: model, context: 'ollama embed' });
      return embedding;
    },

    async embedBatch(texts, model, { onProgress } = {}) {
      const vectors = [];
      for (let i = 0; i < texts.length; i += 1) {
        vectors.push(await this.embedText(texts[i], model));
        onProgress?.({ current: i + 1, total: texts.length });
      }
      return vectors;
    },

    async smokeTestEmbedding(model, sample = 'services kubernetes cluster ip load balancer') {
      const embedding = await this.embedText(sample, model);
      const info = assertEmbeddingVector(embedding, { expectedModel: model, context: 'smoke test' });
      return { ok: true, dimensions: info.dimensions, model };
    },

    async chat(messages, { model, stream = false, options = {} }) {
      const response = await request('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ model, messages, stream, options }),
      });
      if (!stream) return response.json();
      return response;
    },

    async *streamChat(messages, { model, options = {}, signal }) {
      const response = await this.chat(messages, { model, stream: true, options });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const payload = JSON.parse(line);
            if (payload.message?.content) yield payload.message.content;
            if (payload.done) return;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
