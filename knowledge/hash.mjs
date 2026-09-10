import crypto from 'node:crypto';
import fs from 'node:fs';

export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return hashBuffer(data);
}

export function hashText(text) {
  return hashBuffer(Buffer.from(String(text), 'utf8'));
}
