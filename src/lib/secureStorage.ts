const DB_NAME = "the-infinite-game-secrets";
const STORE_NAME = "crypto";
const KEY_ID = "openrouter-aes-key";
const CIPHER_STORAGE_KEY = "the-infinite-game/openrouter-ciphertext";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

async function readStoredCryptoKey(): Promise<CryptoKey | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(KEY_ID);
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
    request.onerror = () => reject(request.error ?? new Error("Failed to read encryption key."));
  });
}

async function writeStoredCryptoKey(key: CryptoKey): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to store encryption key."));
  });
}

async function getOrCreateCryptoKey(): Promise<CryptoKey> {
  const existing = await readStoredCryptoKey();
  if (existing) {
    return existing;
  }

  const key = await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
  await writeStoredCryptoKey(key);
  return key;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer.slice(0);
}

export async function storeEncryptedOpenRouterKey(apiKey: string): Promise<void> {
  const key = await getOrCreateCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(apiKey);
  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encoded,
  );

  localStorage.setItem(
    CIPHER_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(cipherBuffer)),
      updatedAt: Date.now(),
    }),
  );
}

export async function getDecryptedOpenRouterKey(): Promise<string | undefined> {
  const raw = localStorage.getItem(CIPHER_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as {
    iv?: string;
    ciphertext?: string;
  };
  if (!parsed.iv || !parsed.ciphertext) {
    return undefined;
  }

  const key = await getOrCreateCryptoKey();
  const iv = new Uint8Array(fromBase64(parsed.iv));
  const ciphertext = new Uint8Array(fromBase64(parsed.ciphertext));
  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plainBuffer);
}

export function hasEncryptedOpenRouterKey(): boolean {
  return Boolean(localStorage.getItem(CIPHER_STORAGE_KEY));
}

export function clearEncryptedOpenRouterKey(): void {
  localStorage.removeItem(CIPHER_STORAGE_KEY);
}
