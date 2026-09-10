import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.xml',
  '.ps1', '.bat', '.cmd', '.sh', '.py', '.go', '.rs', '.java', '.cs',
  '.sql', '.ini', '.cfg', '.conf', '.toml', '.env.example',
]);

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function detectMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.json': 'application/json',
    '.yaml': 'application/x-yaml',
    '.yml': 'application/x-yaml',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
  };
  return map[ext] || 'text/plain';
}

export function isSupportedFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.pdf' || ext === '.docx' || TEXT_EXTENSIONS.has(ext);
}

function meaningfulText(text) {
  const stripped = String(text || '').replace(/\s+/g, '');
  return stripped.length >= 32;
}

async function parseTextFile(filePath, ext) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (ext === '.json') {
    try {
      return { text: JSON.stringify(JSON.parse(raw), null, 2), page_count: null };
    } catch {
      return { text: raw, page_count: null };
    }
  }
  if (ext === '.yaml' || ext === '.yml') {
    try {
      return { text: dumpYaml(loadYaml(raw), { lineWidth: 120 }), page_count: null };
    } catch {
      return { text: raw, page_count: null };
    }
  }
  return { text: raw, page_count: null };
}

async function parsePdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  await parser.destroy();
  const pages = (parsed.pages || []).map(page => ({ page: page.num, text: String(page.text || '').trim() }));
  const text = String(parsed.text || '').trim();
  const pageCount = parsed.total || pages.length || null;
  if (!meaningfulText(text)) {
    return { text: '', pages: [], page_count: pageCount, status: 'scanned_ocr_required' };
  }
  return { text, pages, page_count: pageCount, status: 'indexed' };
}

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = String(result.value || '').trim();
  return { text, pages: [], page_count: null, status: meaningfulText(text) ? 'indexed' : 'empty' };
}

export async function parseDocument(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Not a file.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large (max 50 MB).');
  const ext = path.extname(filePath).toLowerCase();
  if (!isSupportedFile(filePath)) throw new Error('Unsupported file type.');

  if (ext === '.pdf') return parsePdf(filePath);
  if (ext === '.docx') return parseDocx(filePath);
  return parseTextFile(filePath, ext);
}
