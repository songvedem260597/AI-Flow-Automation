import {
  completeProjectTask,
  createEmptyFilmProject,
  normalizeFilmProject,
  type FilmBrief,
  type FilmCharacter,
  type FilmLocation,
  type FilmProject,
  type FilmScene,
  type FilmShot,
  type FilmShotStatus,
  type StyleBible,
} from '@/agent/schemas/filmProjectSchemas'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.trim().slice(0, 20_000) : fallback

const stringArray = (value: unknown): string[] => Array.isArray(value)
  ? Array.from(new Set(value.map((item) => stringValue(item)).filter(Boolean))).slice(0, 100)
  : []

const completeTaskTypes = (project: FilmProject, types: Parameters<typeof completeProjectTask>[1][]): FilmProject =>
  types.reduce((current, type) => completeProjectTask(current, type), project)

export const createFilmProjectFromTool = (
  workflowId: string,
  args: Record<string, unknown>,
  existing: FilmProject | null,
): FilmProject => {
  const title = stringValue(args.title, existing?.title || 'Untitled Film')
  const project = existing || createEmptyFilmProject(workflowId, title)
  const next = normalizeFilmProject({
    ...project,
    title,
    status: 'planning',
    updatedAt: Date.now(),
  })
  if (!next) throw new Error('film.create_project produced an invalid FilmProject.')
  return next
}

export const updateFilmBriefFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  const briefPatch = asRecord(args.brief || args)
  const stylePatch = asRecord(args.styleBible)
  const aspectRatio = stringValue(briefPatch.aspectRatio, project.brief.aspectRatio)
  const nextBrief: FilmBrief = {
    ...project.brief,
    ...(stringValue(briefPatch.logline) ? { logline: stringValue(briefPatch.logline) } : {}),
    ...(stringValue(briefPatch.genre) ? { genre: stringValue(briefPatch.genre) } : {}),
    ...(stringValue(briefPatch.audience) ? { audience: stringValue(briefPatch.audience) } : {}),
    targetDurationSec: Number.isFinite(Number(briefPatch.targetDurationSec))
      ? Math.min(7_200, Math.max(1, Number(briefPatch.targetDurationSec)))
      : project.brief.targetDurationSec,
    aspectRatio: aspectRatio === '16:9' || aspectRatio === '1:1' ? aspectRatio : '9:16',
    ...(stringValue(briefPatch.visualStyle) ? { visualStyle: stringValue(briefPatch.visualStyle) } : {}),
    ...(stringValue(briefPatch.language) ? { language: stringValue(briefPatch.language) } : {}),
    ...(stringValue(briefPatch.platform) ? { platform: stringValue(briefPatch.platform) } : {}),
    constraints: Array.isArray(briefPatch.constraints) ? stringArray(briefPatch.constraints) : project.brief.constraints,
  }
  const nextStyle: StyleBible = {
    ...project.styleBible,
    ...(stringValue(stylePatch.visualIdentity) ? { visualIdentity: stringValue(stylePatch.visualIdentity) } : {}),
    palette: Array.isArray(stylePatch.palette) ? stringArray(stylePatch.palette) : project.styleBible.palette,
    ...(stringValue(stylePatch.lighting) ? { lighting: stringValue(stylePatch.lighting) } : {}),
    ...(stringValue(stylePatch.cameraLanguage) ? { cameraLanguage: stringValue(stylePatch.cameraLanguage) } : {}),
    ...(stringValue(stylePatch.renderStyle) ? { renderStyle: stringValue(stylePatch.renderStyle) } : {}),
    lockedRules: Array.isArray(stylePatch.lockedRules) ? stringArray(stylePatch.lockedRules) : project.styleBible.lockedRules,
  }
  const next = completeProjectTask({ ...project, brief: nextBrief, styleBible: nextStyle, updatedAt: Date.now() }, 'brief')
  return Object.keys(stylePatch).length > 0 ? completeProjectTask(next, 'world') : next
}

const assertLockedCharacterTraits = (existing: FilmCharacter, incoming: Partial<FilmCharacter>): void => {
  for (const lockedTrait of existing.lockedTraits) {
    const key = lockedTrait.toLowerCase().replace(/[^a-z]/g, '')
    const field = key.includes('hair') ? 'hair'
      : key.includes('cloth') || key.includes('wardrobe') ? 'clothing'
        : key.includes('appearance') || key.includes('face') ? 'appearance'
          : key.includes('age') ? 'age'
            : null
    if (!field) continue
    const before = existing[field]
    const after = incoming[field]
    if (typeof after === 'string' && typeof before === 'string' && after.trim() !== before.trim()) {
      throw new Error(`Character trait "${field}" is locked for ${existing.name}. Ask the user before changing it.`)
    }
  }
}

export const upsertCharacterFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  const raw = asRecord(args.character || args)
  const id = stringValue(raw.id)
  if (!id) throw new Error('film.upsert_character requires character.id.')
  const existing = project.characters.find((character) => character.id === id)
  const incoming: FilmCharacter = {
    id,
    name: stringValue(raw.name, existing?.name || 'Character'),
    role: stringValue(raw.role, existing?.role || ''),
    ...(stringValue(raw.age, existing?.age) ? { age: stringValue(raw.age, existing?.age) } : {}),
    appearance: stringValue(raw.appearance, existing?.appearance || ''),
    ...(stringValue(raw.hair, existing?.hair) ? { hair: stringValue(raw.hair, existing?.hair) } : {}),
    ...(stringValue(raw.clothing, existing?.clothing) ? { clothing: stringValue(raw.clothing, existing?.clothing) } : {}),
    ...(stringValue(raw.personality, existing?.personality) ? { personality: stringValue(raw.personality, existing?.personality) } : {}),
    lockedTraits: Array.isArray(raw.lockedTraits) ? stringArray(raw.lockedTraits) : existing?.lockedTraits || [],
    referenceAssetIds: Array.isArray(raw.referenceAssetIds) ? stringArray(raw.referenceAssetIds) : existing?.referenceAssetIds || [],
  }
  if (existing) assertLockedCharacterTraits(existing, incoming)
  const next = {
    ...project,
    characters: existing
      ? project.characters.map((character) => character.id === id ? incoming : character)
      : [...project.characters, incoming],
    updatedAt: Date.now(),
  }
  return completeProjectTask(next, 'character')
}

export const upsertLocationFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  const raw = asRecord(args.location || args)
  const id = stringValue(raw.id)
  if (!id) throw new Error('film.upsert_location requires location.id.')
  const existing = project.locations.find((location) => location.id === id)
  const location: FilmLocation = {
    id,
    name: stringValue(raw.name, existing?.name || 'Location'),
    description: stringValue(raw.description, existing?.description || ''),
    lighting: stringValue(raw.lighting, existing?.lighting || ''),
    palette: Array.isArray(raw.palette) ? stringArray(raw.palette) : existing?.palette || [],
    lockedTraits: Array.isArray(raw.lockedTraits) ? stringArray(raw.lockedTraits) : existing?.lockedTraits || [],
    referenceAssetIds: Array.isArray(raw.referenceAssetIds) ? stringArray(raw.referenceAssetIds) : existing?.referenceAssetIds || [],
  }
  const next = {
    ...project,
    locations: existing
      ? project.locations.map((item) => item.id === id ? location : item)
      : [...project.locations, location],
    updatedAt: Date.now(),
  }
  return completeProjectTask(next, 'world')
}

export const createScenesFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  if (!Array.isArray(args.scenes) || args.scenes.length === 0) throw new Error('film.create_scenes requires a non-empty scenes array.')
  const scenes: FilmScene[] = args.scenes.slice(0, 200).map((value, index) => {
    const raw = asRecord(value)
    const id = stringValue(raw.id, `scene-${index + 1}`)
    return {
      id,
      order: Number.isFinite(Number(raw.order)) ? Math.max(1, Number(raw.order)) : index + 1,
      title: stringValue(raw.title, `Scene ${index + 1}`),
      ...(stringValue(raw.locationId) ? { locationId: stringValue(raw.locationId) } : {}),
      summary: stringValue(raw.summary),
      purpose: stringValue(raw.purpose),
      characterIds: stringArray(raw.characterIds),
      shotIds: stringArray(raw.shotIds),
    }
  }).sort((left, right) => left.order - right.order)
  return completeTaskTypes({ ...project, scenes, updatedAt: Date.now() }, ['script'])
}

export const createShotsFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  if (!Array.isArray(args.shots) || args.shots.length === 0) throw new Error('film.create_shots requires a non-empty shots array.')
  const sceneIds = new Set(project.scenes.map((scene) => scene.id))
  const shots: FilmShot[] = args.shots.slice(0, 500).map((value, index) => {
    const raw = asRecord(value)
    const id = stringValue(raw.id, `shot-${String(index + 1).padStart(3, '0')}`)
    const sceneId = stringValue(raw.sceneId)
    if (!sceneIds.has(sceneId)) throw new Error(`Shot ${id} references unknown scene ${sceneId || '(missing)'}.`)
    return {
      id,
      sceneId,
      order: Number.isFinite(Number(raw.order)) ? Math.max(1, Number(raw.order)) : index + 1,
      durationSec: Number.isFinite(Number(raw.durationSec)) ? Math.min(120, Math.max(1, Number(raw.durationSec))) : 5,
      description: stringValue(raw.description),
      camera: stringValue(raw.camera),
      action: stringValue(raw.action),
      emotion: stringValue(raw.emotion),
      imagePrompt: stringValue(raw.imagePrompt),
      videoPrompt: stringValue(raw.videoPrompt),
      ...(stringValue(raw.negativePrompt) ? { negativePrompt: stringValue(raw.negativePrompt) } : {}),
      characterIds: stringArray(raw.characterIds),
      referenceAssetIds: stringArray(raw.referenceAssetIds),
      workflowNodeIds: [],
      status: 'planned' as const,
      attempt: 0,
      imageAttempt: 0,
      videoAttempt: 0,
    }
  }).sort((left, right) => left.order - right.order)
  const shotsByScene = new Map<string, string[]>()
  shots.forEach((shot) => shotsByScene.set(shot.sceneId, [...(shotsByScene.get(shot.sceneId) || []), shot.id]))
  const scenes = project.scenes.map((scene) => ({ ...scene, shotIds: shotsByScene.get(scene.id) || [] }))
  return completeProjectTask({ ...project, scenes, shots, updatedAt: Date.now() }, 'storyboard')
}

export const updateShotFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  const shotId = stringValue(args.shotId)
  const patch = asRecord(args.patch)
  const existing = project.shots.find((shot) => shot.id === shotId)
  if (!existing) throw new Error(`Shot not found: ${shotId || '(missing)'}.`)
  const merged = normalizeFilmProject({
    ...project,
    shots: project.shots.map((shot) => shot.id === shotId ? { ...shot, ...patch, id: shot.id, sceneId: shot.sceneId } : shot),
    updatedAt: Date.now(),
  })
  if (!merged) throw new Error('film.update_shot produced an invalid shot patch.')
  return merged
}

export const markShotStatusFromTool = (project: FilmProject, args: Record<string, unknown>): FilmProject => {
  const shotId = stringValue(args.shotId)
  const status = stringValue(args.status) as FilmShotStatus
  const allowed = new Set<FilmShotStatus>([
    'planned', 'workflow-ready', 'generating-image', 'image-ready', 'image-approved', 'generating-video', 'video-ready', 'needs-review', 'approved', 'failed'
  ])
  if (!allowed.has(status)) throw new Error(`Invalid shot status: ${status || '(missing)'}.`)
  const shot = project.shots.find((candidate) => candidate.id === shotId)
  if (!shot) throw new Error(`Shot not found: ${shotId || '(missing)'}.`)
  if ((status === 'generating-image' || status === 'generating-video') && project.status !== 'production') {
    throw new Error(`Cannot mark ${shotId} as generating without an approved runner action.`)
  }
  if (status === 'image-ready' && !shot.imageAssetId) throw new Error(`Cannot mark ${shotId} image-ready without imageAssetId.`)
  if (status === 'image-approved' && !shot.imageAssetId) throw new Error(`Cannot mark ${shotId} image-approved without imageAssetId.`)
  if ((status === 'video-ready' || status === 'approved') && !shot.videoAssetId) throw new Error(`Cannot mark ${shotId} ${status} without videoAssetId.`)
  return {
    ...project,
    shots: project.shots.map((shot) => shot.id === shotId ? { ...shot, status } : shot),
    updatedAt: Date.now(),
  }
}
