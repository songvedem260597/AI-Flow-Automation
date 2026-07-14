import type { PromptAssistantProvider } from '@/lib/promptAssistant'

export interface VideoAgentConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  provider?: PromptAssistantProvider
  sourceCommand?: 'skill-creator' | 'skill-installer'
  createdAt: number
}

export interface VideoAgentConversation {
  id: string
  workflowId: string
  title: string
  messages: VideoAgentConversationMessage[]
  createdAt: number
  updatedAt: number
}

export interface VideoAgentConversationState {
  conversations: VideoAgentConversation[]
  activeConversationId: string | null
}

const DATABASE_NAME = 'ai-flow-video-agent-history'
const DATABASE_VERSION = 1
const CONVERSATION_STORE = 'conversations'
const META_STORE = 'meta'
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
        const store = database.createObjectStore(CONVERSATION_STORE, { keyPath: 'id' })
        store.createIndex('workflowId', 'workflowId', { unique: false })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open AI Idea Agent history.'))
  })
}

function activeMetaKey(workflowId: string): string {
  return `active:${workflowId}`
}

function normalizeMessage(value: unknown): VideoAgentConversationMessage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<VideoAgentConversationMessage>
  if (candidate.role !== 'user' && candidate.role !== 'assistant') return null
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  if (!id || !text.trim()) return null
  const provider = candidate.provider === 'chatgpt' || candidate.provider === 'gemini' || candidate.provider === 'api'
    ? candidate.provider
    : undefined
  const sourceCommand = candidate.sourceCommand === 'skill-creator' || candidate.sourceCommand === 'skill-installer'
    ? candidate.sourceCommand
    : undefined
  return {
    id,
    role: candidate.role,
    text,
    provider,
    sourceCommand,
    createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now(),
  }
}

function normalizeConversation(value: unknown): VideoAgentConversation | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<VideoAgentConversation>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const workflowId = typeof candidate.workflowId === 'string' ? candidate.workflowId.trim() : ''
  if (!id || !workflowId) return null
  const messages = Array.isArray(candidate.messages)
    ? candidate.messages.map(normalizeMessage).filter((message): message is VideoAgentConversationMessage => Boolean(message))
    : []
  const createdAt = Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now()
  const updatedAt = Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : createdAt
  const title = typeof candidate.title === 'string' && candidate.title.trim()
    ? candidate.title.trim().slice(0, 90)
    : 'New conversation'
  return { id, workflowId, title, messages, createdAt, updatedAt }
}

export function createVideoAgentConversation(workflowId: string): VideoAgentConversation {
  const now = Date.now()
  return {
    id: `video-agent-conversation-${now}-${Math.random().toString(36).slice(2, 9)}`,
    workflowId,
    title: 'New conversation',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export async function loadVideoAgentConversationState(workflowId: string): Promise<VideoAgentConversationState> {
  await writeQueue
  const database = await openDatabase()
  try {
    const transaction = database.transaction([CONVERSATION_STORE, META_STORE], 'readonly')
    const completed = transactionDone(transaction)
    const conversationRequest = transaction.objectStore(CONVERSATION_STORE).index('workflowId').getAll(IDBKeyRange.only(workflowId))
    const metaRequest = transaction.objectStore(META_STORE).get(activeMetaKey(workflowId))
    const [rawConversations, meta] = await Promise.all([
      requestResult(conversationRequest),
      requestResult(metaRequest) as Promise<{ conversationId?: unknown } | undefined>,
    ])
    await completed
    const conversations = rawConversations
      .map(normalizeConversation)
      .filter((conversation): conversation is VideoAgentConversation => Boolean(conversation))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const requestedActiveId = typeof meta?.conversationId === 'string' ? meta.conversationId : null
    return {
      conversations,
      activeConversationId: requestedActiveId && conversations.some((conversation) => conversation.id === requestedActiveId)
        ? requestedActiveId
        : conversations[0]?.id || null,
    }
  } finally {
    database.close()
  }
}

export async function saveVideoAgentConversation(conversation: VideoAgentConversation): Promise<VideoAgentConversation> {
  const normalized = normalizeConversation(conversation)
  if (!normalized) throw new Error('Invalid AI Idea Agent conversation.')
  const operation = writeQueue.then(async () => {
    const database = await openDatabase()
    try {
      const transaction = database.transaction([CONVERSATION_STORE, META_STORE], 'readwrite')
      const completed = transactionDone(transaction)
      transaction.objectStore(CONVERSATION_STORE).put(normalized)
      transaction.objectStore(META_STORE).put({
        key: activeMetaKey(normalized.workflowId),
        conversationId: normalized.id,
        updatedAt: Date.now(),
      })
      await completed
    } finally {
      database.close()
    }
  })
  writeQueue = operation.catch(() => undefined)
  await operation
  return normalized
}

export async function deleteVideoAgentConversation(
  workflowId: string,
  conversationId: string,
  nextActiveConversationId: string | null,
): Promise<void> {
  const normalizedWorkflowId = workflowId.trim()
  const normalizedConversationId = conversationId.trim()
  const normalizedNextActiveId = nextActiveConversationId?.trim() || null
  if (!normalizedWorkflowId || !normalizedConversationId) throw new Error('Invalid AI Idea Agent conversation deletion request.')
  const operation = writeQueue.then(async () => {
    const database = await openDatabase()
    try {
      const transaction = database.transaction([CONVERSATION_STORE, META_STORE], 'readwrite')
      const completed = transactionDone(transaction)
      transaction.objectStore(CONVERSATION_STORE).delete(normalizedConversationId)
      if (normalizedNextActiveId) {
        transaction.objectStore(META_STORE).put({
          key: activeMetaKey(normalizedWorkflowId),
          conversationId: normalizedNextActiveId,
          updatedAt: Date.now(),
        })
      } else {
        transaction.objectStore(META_STORE).delete(activeMetaKey(normalizedWorkflowId))
      }
      await completed
    } finally {
      database.close()
    }
  })
  writeQueue = operation.catch(() => undefined)
  await operation
}

export async function setActiveVideoAgentConversation(workflowId: string, conversationId: string): Promise<void> {
  const operation = writeQueue.then(async () => {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(META_STORE, 'readwrite')
      const completed = transactionDone(transaction)
      transaction.objectStore(META_STORE).put({
        key: activeMetaKey(workflowId),
        conversationId,
        updatedAt: Date.now(),
      })
      await completed
    } finally {
      database.close()
    }
  })
  writeQueue = operation.catch(() => undefined)
  await operation
}
