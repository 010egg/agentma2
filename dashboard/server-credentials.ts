import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const ENVELOPE_VERSION = 1;

type CredentialEnvelope = {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  tag: string;
  data: string;
};

function decodeConfiguredKey(value: string) {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64').replace(/=+$/, '') !== value.trim().replace(/=+$/, '')) {
    throw new Error('AGENTMA_A2A_CREDENTIAL_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

export function loadCredentialMasterKey(options: { dataDir?: string; envKey?: string } = {}) {
  if (options.envKey) return decodeConfiguredKey(options.envKey);
  const dataDir = options.dataDir
    || process.env.AGENTMA_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'agentma2');
  const keyPath = path.join(dataDir, 'a2a-credential-key');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const stored = fs.readFileSync(keyPath);
    if (stored.length !== KEY_BYTES) throw new Error('stored A2A credential key must contain exactly 32 bytes');
    fs.chmodSync(keyPath, 0o600);
    return stored;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  return key;
}

export function createCredentialCipher(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('credential key must contain exactly 32 bytes');
  return {
    encrypt(plaintext: string) {
      if (typeof plaintext !== 'string' || !plaintext.length) throw new Error('credential secret must not be empty');
      const iv = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const envelope: CredentialEnvelope = {
        v: ENVELOPE_VERSION,
        alg: 'A256GCM',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      };
      return JSON.stringify(envelope);
    },
    decrypt(ciphertext: string) {
      let envelope: CredentialEnvelope;
      try {
        envelope = JSON.parse(ciphertext) as CredentialEnvelope;
      } catch {
        throw new Error('invalid credential ciphertext envelope');
      }
      if (envelope?.v !== ENVELOPE_VERSION || envelope.alg !== 'A256GCM') {
        throw new Error('unsupported credential ciphertext envelope');
      }
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(envelope.data, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error('credential ciphertext authentication failed');
      }
    },
  };
}

let defaultCipher: ReturnType<typeof createCredentialCipher> | null = null;

export function getCredentialCipher() {
  if (!defaultCipher) {
    defaultCipher = createCredentialCipher(loadCredentialMasterKey({ envKey: process.env.AGENTMA_A2A_CREDENTIAL_KEY }));
  }
  return defaultCipher;
}
