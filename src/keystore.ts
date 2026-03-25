/**
 * Encrypted keyfile persistence for wallet private keys.
 *
 * Uses AES-256-GCM with a key derived from a machine-specific secret
 * (hostname + username + app salt) via PBKDF2. The keyfile lives at
 * ~/.btc-wallet/key.enc and is auto-loaded on server startup.
 *
 * This makes the keyfile non-portable between machines by design —
 * use WALLET_PRIVATE_KEY env var for deployment/migration.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

const KEYSTORE_DIR = join(homedir(), ".btc-wallet");
const KEYFILE_PATH = join(KEYSTORE_DIR, "key.enc");
const APP_SALT = "btc-wallet-mcp-plugin-v1";
const PBKDF2_ITERATIONS = 100_000;

interface KeyfileData {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  encrypted: string;
  network: string;
  createdAt: string;
}

/** Derive an AES-256 key from a machine-specific secret + salt. */
function deriveKey(salt: Buffer): Buffer {
  const machineSecret = `${APP_SALT}:${hostname()}:${userInfo().username}`;
  return pbkdf2Sync(machineSecret, salt, PBKDF2_ITERATIONS, 32, "sha256");
}

/** Encrypt a private key hex string and save to ~/.btc-wallet/key.enc. */
export function saveKey(privateKeyHex: string, network: string): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const key = deriveKey(salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(privateKeyHex, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  const data: KeyfileData = {
    version: 1,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    encrypted,
    network,
    createdAt: new Date().toISOString(),
  };

  mkdirSync(KEYSTORE_DIR, { recursive: true });
  writeFileSync(KEYFILE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });

  return KEYFILE_PATH;
}

/** Load and decrypt the private key from ~/.btc-wallet/key.enc. Returns null if not found. */
export function loadKey(): { privateKeyHex: string; network: string } | null {
  if (!existsSync(KEYFILE_PATH)) {
    return null;
  }

  try {
    const raw = readFileSync(KEYFILE_PATH, "utf8");
    const data: KeyfileData = JSON.parse(raw);

    if (data.version !== 1) {
      return null;
    }

    const salt = Buffer.from(data.salt, "hex");
    const iv = Buffer.from(data.iv, "hex");
    const tag = Buffer.from(data.tag, "hex");
    const key = deriveKey(salt);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(data.encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return { privateKeyHex: decrypted, network: data.network };
  } catch {
    // Corrupted or wrong machine — ignore
    return null;
  }
}

/** Delete the keyfile. */
export function deleteKey(): boolean {
  if (existsSync(KEYFILE_PATH)) {
    unlinkSync(KEYFILE_PATH);
    return true;
  }
  return false;
}

/** Check if a keyfile exists. */
export function hasKey(): boolean {
  return existsSync(KEYFILE_PATH);
}

/** Return the keyfile path (for logging, not the key itself). */
export function getKeyfilePath(): string {
  return KEYFILE_PATH;
}
