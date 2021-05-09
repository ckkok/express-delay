import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getJsonData = filename => {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', filename), 'utf-8'));
}