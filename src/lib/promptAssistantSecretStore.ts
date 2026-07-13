const VAULT_DB_NAME = 'ai-flow-secret-vault'
const VAULT_DB_VERSION = 1
const VAULT_KEY_STORE = 'crypto-keys'
const API_KEY_ID = 'prompt-assistant-api-key'
const API_SECRET_STORAGE_KEY = 'ai-flow-prompt-assistant-api-secret-v1'
const SETTINGS_STORAGE_KEY = 'ai-flow-settings'

interface EncryptedSecretRecord {
  version: 1
  iv: string
  ciphertext: string
}

let writeQueue: Promise<void> = Promise.resolve()

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'))
  })
}

function openVaultDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(VAULT_KEY_STORE)) {
        database.createObjectStore(VAULT_KEY_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open the local secret vault.'))
  })
}

async function readEncryptionKey(): Promise<CryptoKey | null> {
  const database = await openVaultDatabase()
  try {
    const transaction = database.transaction(VAULT_KEY_STORE, 'readonly')
    const completed = transactionDone(transaction)
    const result = await requestResult(transaction.objectStore(VAULT_KEY_STORE).get(API_KEY_ID))
    await completed
    return result instanceof CryptoKey ? result : null
  } finally {
    database.close()
  }
}

async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  const existing = await readEncryptionKey()
  if (existing) return existing

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const database = await openVaultDatabase()
  try {
    const transaction = database.transaction(VAULT_KEY_STORE, 'readwrite')
    const completed = transactionDone(transaction)
    transaction.objectStore(VAULT_KEY_STORE).put(key, API_KEY_ID)
    await completed
  } finally {
    database.close()
  }
  return key
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function parseStoredSettings(raw: unknown): { parsed: any; wasString: boolean } | null {
  try {
    const wasString = typeof raw === 'string'
    const parsed = wasString ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' ? { parsed, wasString } : null
  } catch {
    return null
  }
}

async function readLegacyPlaintextApiKey(): Promise<string> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const settings = parseStoredSettings(stored[SETTINGS_STORAGE_KEY])
  const apiKey = settings?.parsed?.state?.apiProvider?.apiKey
  return typeof apiKey === 'string' ? apiKey : ''
}

export function sanitizePersistedSettings(value: string): string {
  const settings = parseStoredSettings(value)
  if (!settings?.parsed?.state?.apiProvider) return value
  settings.parsed.state.apiProvider.apiKey = ''
  return JSON.stringify(settings.parsed)
}

async function scrubLegacyPlaintextApiKey(): Promise<void> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  const raw = stored[SETTINGS_STORAGE_KEY]
  const settings = parseStoredSettings(raw)
  if (!settings?.parsed?.state?.apiProvider || !settings.parsed.state.apiProvider.apiKey) return

  settings.parsed.state.apiProvider.apiKey = ''
  const sanitized = settings.wasString ? JSON.stringify(settings.parsed) : settings.parsed
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: sanitized })
}

async function writeEncryptedApiKey(apiKey: string): Promise<void> {
  if (!apiKey) {
    await chrome.storage.local.remove(API_SECRET_STORAGE_KEY)
    await scrubLegacyPlaintextApiKey()
    return
  }

  const key = await getOrCreateEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(apiKey)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const record: EncryptedSecretRecord = {
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  }
  await chrome.storage.local.set({ [API_SECRET_STORAGE_KEY]: record })
  await scrubLegacyPlaintextApiKey()
}

export function savePromptAssistantApiKey(apiKey: string): Promise<void> {
  const operation = writeQueue.then(() => writeEncryptedApiKey(apiKey))
  writeQueue = operation.catch(() => undefined)
  return operation
}

export async function loadPromptAssistantApiKey(): Promise<string> {
  await writeQueue
  const stored = await chrome.storage.local.get(API_SECRET_STORAGE_KEY)
  const record = stored[API_SECRET_STORAGE_KEY] as EncryptedSecretRecord | undefined

  if (record?.version === 1 && record.iv && record.ciphertext) {
    const key = await readEncryptionKey()
    if (!key) {
      throw new Error('The encrypted API key can no longer be decrypted. Re-enter it in Settings.')
    }
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
        key,
        base64ToBytes(record.ciphertext),
      )
      await scrubLegacyPlaintextApiKey()
      return new TextDecoder().decode(decrypted)
    } catch {
      throw new Error('The encrypted API key is invalid. Re-enter it in Settings.')
    }
  }

  const legacyApiKey = await readLegacyPlaintextApiKey()
  if (!legacyApiKey) return ''
  await savePromptAssistantApiKey(legacyApiKey)
  return legacyApiKey
}

export async function migrateLegacyPromptAssistantApiKey(): Promise<void> {
  await loadPromptAssistantApiKey()
}
