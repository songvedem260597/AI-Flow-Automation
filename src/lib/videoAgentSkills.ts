export interface VideoAgentSkill {
  id: string
  name: string
  instruction: string
  createdAt: number
  updatedAt: number
}

export interface VideoAgentSkillLibrary {
  skills: VideoAgentSkill[]
  selectedSkillId: string | null
}

const VIDEO_AGENT_SKILLS_STORAGE_KEY = 'ai-flow-video-agent-skills-v1'
const MAX_SKILLS = 50
const MAX_SKILL_NAME_LENGTH = 64
const MAX_SKILL_INSTRUCTION_LENGTH = 12000
let saveQueue: Promise<void> = Promise.resolve()

export const EMPTY_VIDEO_AGENT_SKILL_LIBRARY: VideoAgentSkillLibrary = {
  skills: [],
  selectedSkillId: null,
}

function normalizeSkill(value: unknown): VideoAgentSkill | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<VideoAgentSkill>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const name = typeof candidate.name === 'string'
    ? candidate.name.trim().slice(0, MAX_SKILL_NAME_LENGTH)
    : ''
  const instruction = typeof candidate.instruction === 'string'
    ? candidate.instruction.trim().slice(0, MAX_SKILL_INSTRUCTION_LENGTH)
    : ''
  if (!id || !name || !instruction) return null
  const createdAt = Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now()
  const updatedAt = Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : createdAt
  return { id, name, instruction, createdAt, updatedAt }
}

function normalizeLibrary(value: unknown): VideoAgentSkillLibrary {
  if (!value || typeof value !== 'object') return { ...EMPTY_VIDEO_AGENT_SKILL_LIBRARY }
  const candidate = value as Partial<VideoAgentSkillLibrary>
  const skills = Array.isArray(candidate.skills)
    ? candidate.skills.map(normalizeSkill).filter((skill): skill is VideoAgentSkill => Boolean(skill)).slice(0, MAX_SKILLS)
    : []
  const requestedSelection = typeof candidate.selectedSkillId === 'string' ? candidate.selectedSkillId : null
  return {
    skills,
    selectedSkillId: requestedSelection && skills.some((skill) => skill.id === requestedSelection)
      ? requestedSelection
      : null,
  }
}

export async function loadVideoAgentSkillLibrary(): Promise<VideoAgentSkillLibrary> {
  await saveQueue
  const stored = await chrome.storage.local.get(VIDEO_AGENT_SKILLS_STORAGE_KEY)
  return normalizeLibrary(stored[VIDEO_AGENT_SKILLS_STORAGE_KEY])
}

export async function saveVideoAgentSkillLibrary(library: VideoAgentSkillLibrary): Promise<VideoAgentSkillLibrary> {
  const normalized = normalizeLibrary(library)
  const operation = saveQueue.then(() => chrome.storage.local.set({ [VIDEO_AGENT_SKILLS_STORAGE_KEY]: normalized }))
  saveQueue = operation.catch(() => undefined)
  await operation
  return normalized
}
