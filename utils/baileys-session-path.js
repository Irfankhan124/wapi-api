import fs from 'fs';
import path from 'path';

const configuredRoot = () => {
  const explicit = String(process.env.BAILEYS_SESSION_DIR || '').trim();
  if (explicit) return path.resolve(explicit);

  const dataDir = String(process.env.DATA_DIR || '').trim();
  if (dataDir) return path.resolve(dataDir, 'baileys-sessions');

  return path.join(process.cwd(), 'storage', 'sessions', 'baileys');
};

export const getBaileysSessionRoot = () => {
  const root = configuredRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
};

export const getBaileysSessionDir = (wabaId) => {
  const id = String(wabaId || '').trim();
  if (!id) throw new Error('WABA ID is required for a Baileys session path');
  return path.join(getBaileysSessionRoot(), id);
};
