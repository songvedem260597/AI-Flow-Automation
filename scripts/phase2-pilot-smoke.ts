import assert from 'node:assert/strict'

const storage = new Map<string, unknown>()
const chromeMock = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys]
        return Object.fromEntries(list.map((key) => [key, storage.get(key)]))
      },
      set: async (values: Record<string, unknown>) => { Object.entries(values).forEach(([key, value]) => storage.set(key, value)) },
      remove: async (keys: string | string[]) => { (Array.isArray(keys) ? keys : [keys]).forEach((key) => storage.delete(key)) },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { lastError: null },
}
Object.assign(globalThis, { chrome: chromeMock, localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })

const main = async () => {
  const [{ createEmptyFilmProject, createDefaultAgentTasks, normalizeFilmProject }, pilotTools, pilotRuntime, { useFilmProjectStore }, { useAgentStore }, { useWorkflowStore }, { executeAgentToolCalls }] = await Promise.all([
    import('../src/agent/schemas/filmProjectSchemas'),
    import('../src/agent/tools/pilotTools'),
    import('../src/agent/runtime/pilotRunner'),
    import('../src/agent/stores/filmProjectStore'),
    import('../src/agent/stores/agentStore'),
    import('../src/stores/workflowStore'),
    import('../src/agent/runtime/agentToolExecutor'),
  ])

  const makeWorkflow = (workflowId = 'wf-pilot', projectId = 'project-pilot', shotId = 'SHOT-001') => ({
    id: workflowId,
    name: 'Pilot Workflow',
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      { id: `${shotId}-prompt-image`, type: 'prompt' as const, position: { x: 0, y: 0 }, data: { label: 'Image prompt', prompt: 'A clear hero portrait', provider: 'chatgpt' as const, enabled: true, filmProjectId: projectId, shotId } },
      { id: `${shotId}-delay-image`, type: 'delay' as const, position: { x: 150, y: 120 }, data: { label: 'Pilot delay', duration: 5, enabled: true, filmProjectId: projectId, shotId } },
      { id: `${shotId}-generate-image`, type: 'generate' as const, position: { x: 300, y: 0 }, data: { label: 'Generate image', provider: 'chatgpt' as const, mediaType: 'image' as const, aspectRatio: '16:9' as const, quantity: 1, enabled: true, filmProjectId: projectId, shotId } },
      { id: `${shotId}-prompt-video`, type: 'prompt' as const, position: { x: 600, y: 0 }, data: { label: 'Video prompt', prompt: 'The hero looks toward camera', provider: 'google-flow' as const, enabled: true, filmProjectId: projectId, shotId } },
      { id: `${shotId}-generate-video`, type: 'generate' as const, position: { x: 900, y: 0 }, data: { label: 'Generate video', provider: 'google-flow' as const, mediaType: 'video' as const, flowVideoMode: 'frame' as const, aspectRatio: '16:9' as const, quantity: 1, enabled: true, filmProjectId: projectId, shotId } },
    ],
    edges: [
      { id: `${shotId}-delay-image-edge`, source: `${shotId}-delay-image`, target: `${shotId}-generate-image`, sourceHandle: 'output_1', targetHandle: 'input_1' },
    ],
  })

  const makeProject = (workflowId = 'wf-pilot', projectId = 'project-pilot', shotId = 'SHOT-001') => {
    const base = createEmptyFilmProject(workflowId, 'Pilot Film')
    return {
      ...base,
      id: projectId,
      pilotShotId: shotId,
      scenes: [{ id: 'SCENE-001', order: 1, title: 'Opening', summary: 'Meet the hero', purpose: 'Hook', characterIds: ['hero'], shotIds: [shotId] }],
      characters: [{ id: 'hero', name: 'Hero', role: 'main protagonist', appearance: 'Distinct silhouette', lockedTraits: [], referenceAssetIds: [] }],
      shots: [{
        id: shotId, sceneId: 'SCENE-001', order: 1, durationSec: 5, description: 'Hero portrait', camera: 'Medium shot', action: 'Looks up', emotion: 'Hopeful',
        imagePrompt: 'A clear hero portrait', videoPrompt: 'The hero looks toward camera', characterIds: ['hero'], referenceAssetIds: [],
        workflowNodeIds: [`${shotId}-prompt-image`, `${shotId}-generate-image`, `${shotId}-prompt-video`, `${shotId}-generate-video`],
        status: 'workflow-ready' as const, attempt: 0, imageAttempt: 0, videoAttempt: 0,
      }],
      tasks: createDefaultAgentTasks().map((task) => task.type.startsWith('pilot-') ? { ...task, shotId } : task),
    }
  }

  const imageAsset = { id: 'asset-image-1', kind: 'image' as const, blob: new Blob(['image']), mimeType: 'image/png', size: 5, createdAt: 1, updatedAt: 1, source: 'generated' as const }
  const videoAsset = { id: 'asset-video-1', kind: 'video' as const, blob: new Blob(['video']), mimeType: 'video/mp4', size: 5, createdAt: 1, updatedAt: 1, source: 'generated' as const }
  const assets = new Map([[imageAsset.id, imageAsset], [videoAsset.id, videoAsset]])
  const workflow = makeWorkflow()
  let project = makeProject()
  const selected = pilotTools.selectPilotShot(project)
  project = pilotTools.createPilotRunApproval(selected.project, workflow, selected.selection.shotId, 'image')
  const imageApproval = project.approvals.find((approval) => approval.payload.stage === 'run' && approval.payload.kind === 'image')!
  assert.equal(imageApproval.status, 'pending')

  const resetStores = (nextProject: typeof project, nextWorkflow = workflow) => {
    useFilmProjectStore.setState({ projects: [nextProject], activeProjectByWorkflow: { [nextWorkflow.id]: nextProject.id }, hydrated: true })
    useAgentStore.setState({ pilotJobs: [], idempotencyResults: {}, activities: [], modesByWorkflow: { [nextWorkflow.id]: 'run-with-approval' }, pendingPatchesByWorkflow: {}, hydrated: true })
    useWorkflowStore.setState({ workflows: [nextWorkflow], activeWorkflowId: nextWorkflow.id })
  }
  resetStores(project)

  let submissions = 0
  const runtimeSlices: Array<{ nodeIds: string[]; edgeIds: string[]; generateNodeIds: string[] }> = []
  const pipeline = { isRunning: false, activeTaskId: null as string | null, tasks: [] as Array<any> }
  const dependencies = {
    pipelineState: () => pipeline,
    stop: () => { pipeline.isRunning = false; pipeline.activeTaskId = null },
    cacheOutput: async (output: unknown) => output,
    readAsset: async (assetId: string) => assets.get(assetId) || null,
    updateWorkflowOutput: () => undefined,
    run: async (runtimeWorkflow: typeof workflow, callbacks: any) => {
      submissions += 1
      runtimeSlices.push({
        nodeIds: runtimeWorkflow.nodes.map((node) => node.id),
        edgeIds: runtimeWorkflow.edges.map((edge) => edge.id),
        generateNodeIds: runtimeWorkflow.nodes.filter((node) => node.type === 'generate').map((node) => node.id),
      })
      assert.equal(runtimeWorkflow.nodes.filter((node) => node.type === 'generate').length, 1, 'pilot runtime must contain one Generate node')
      const target = runtimeWorkflow.nodes.find((node) => node.type === 'generate')!
      assert.equal((target.data as any).quantity, 1)
      const task = { id: `runner-${submissions}`, workflowId: runtimeWorkflow.id, status: 'running', progress: 0, results: {}, errors: [], createdAt: Date.now() }
      pipeline.tasks.push(task)
      pipeline.activeTaskId = task.id
      pipeline.isRunning = true
      callbacks.onNodeStart?.(target.id, target.type)
      const kind = (target.data as any).mediaType === 'video' ? 'video' : 'image'
      callbacks.onNodeComplete?.(target.id, { outputs: [{ assetId: kind === 'video' ? videoAsset.id : imageAsset.id, mediaType: kind }] })
      task.status = 'completed'
      pipeline.activeTaskId = null
      pipeline.isRunning = false
    },
  }

  const args = {
    projectId: project.id,
    shotId: 'SHOT-001',
    workflowId: workflow.id,
    generateNodeId: 'SHOT-001-generate-image',
    approvalId: imageApproval.id,
    idempotencyKey: String(imageApproval.payload.idempotencyKey),
    kind: 'image' as const,
  }
  const planResult = await executeAgentToolCalls([{ id: 'plan', name: 'runner.run_pilot_image', arguments: args, idempotencyKey: 'plan-run' }], { workflow, mode: 'plan-only' })
  const editResult = await executeAgentToolCalls([{ id: 'edit', name: 'runner.run_pilot_image', arguments: args, idempotencyKey: 'edit-run' }], { workflow, mode: 'edit-workflow' })
  assert.equal(planResult.results[0].success, false)
  assert.equal(editResult.results[0].success, false)
  assert.equal(submissions, 0, 'plan/edit modes must not call a provider')

  await assert.rejects(
    () => pilotRuntime.runPilotJob(args, workflow, dependencies),
    /explicitly approved approval card/,
  )
  assert.equal(submissions, 0, 'run-with-approval must not submit before approval')

  project = useFilmProjectStore.getState().updateProject(project.id, (current) => ({
    ...current,
    approvals: current.approvals.map((approval) => approval.id === imageApproval.id ? { ...approval, status: 'approved' as const, resolvedAt: Date.now() } : approval),
  }))!
  const [first, second] = await Promise.all([
    pilotRuntime.runPilotJob(args, workflow, dependencies),
    pilotRuntime.runPilotJob(args, workflow, dependencies),
  ])
  assert.equal(first.assetId, imageAsset.id)
  assert.equal(second.assetId, imageAsset.id)
  assert.equal(submissions, 1, 'double-click must still submit once')
  assert.deepEqual(runtimeSlices[0].generateNodeIds, ['SHOT-001-generate-image'])
  assert.equal(runtimeSlices[0].nodeIds.includes('SHOT-001-generate-video'), false, 'unrelated enabled Generate node must not enter the pilot subgraph')
  assert.equal(runtimeSlices[0].nodeIds.includes('SHOT-001-delay-image'), true, 'enabled upstream Delay must remain in the pilot subgraph')
  assert.equal(runtimeSlices[0].edgeIds.includes('SHOT-001-delay-image-edge'), true)
  const persistedImageJobs = useAgentStore.getState().pilotJobs.filter((job) => job.idempotencyKey === args.idempotencyKey)
  assert.equal(persistedImageJobs.length, 1, 'double-click must persist one pilot job')
  assert.equal(persistedImageJobs[0].nodeId, 'SHOT-001-generate-image')
  assert.equal(persistedImageJobs[0].outputAssetId, imageAsset.id)
  assert.ok(persistedImageJobs[0].startedAt > 0)
  const imageReadyProject = useFilmProjectStore.getState().getProjectForWorkflow(workflow.id)!
  assert.equal(imageReadyProject.shots[0].status, 'image-ready')
  assert.equal(imageReadyProject.shots[0].imageAssetId, imageAsset.id)
  assert.equal(imageReadyProject.assetMappings[0].assetId, imageAsset.id)
  const imageReview = imageReadyProject.approvals.find((approval) => approval.status === 'pending' && approval.payload.stage === 'review')!

  const rejectedProject = pilotTools.resolvePilotReview(imageReadyProject, workflow, imageReview.id, 'reject')
  assert.equal(rejectedProject.shots[0].status, 'workflow-ready')
  assert.equal(rejectedProject.approvals.some((approval) => approval.status === 'pending' && approval.payload.kind === 'video'), false, 'rejected image must not create a video run')

  const approvedImageProject = pilotTools.resolvePilotReview(imageReadyProject, workflow, imageReview.id, 'approve')
  assert.equal(approvedImageProject.shots[0].status, 'image-approved')
  const videoApproval = approvedImageProject.approvals.find((approval) => approval.status === 'pending' && approval.payload.stage === 'run' && approval.payload.kind === 'video')!
  assert.ok(videoApproval, 'approved image must create video approval')
  const approvedVideoRunProject = { ...approvedImageProject, approvals: approvedImageProject.approvals.map((approval) => approval.id === videoApproval.id ? { ...approval, status: 'approved' as const, resolvedAt: Date.now() } : approval) }
  resetStores(approvedVideoRunProject)
  const videoResult = await pilotRuntime.runPilotJob({
    projectId: approvedVideoRunProject.id,
    shotId: 'SHOT-001',
    workflowId: workflow.id,
    generateNodeId: 'SHOT-001-generate-video',
    approvalId: videoApproval.id,
    idempotencyKey: String(videoApproval.payload.idempotencyKey),
    kind: 'video',
  }, workflow, dependencies)
  assert.equal(videoResult.assetId, videoAsset.id)
  assert.equal(submissions, 2, 'video approval must submit exactly once')
  const videoReadyProject = useFilmProjectStore.getState().getProjectForWorkflow(workflow.id)!
  assert.equal(videoReadyProject.shots[0].videoAssetId, videoAsset.id)
  assert.equal(videoReadyProject.shots[0].status, 'video-ready')

  const staleWorkflow = makeWorkflow('wf-stale', 'project-stale', 'SHOT-STALE')
  staleWorkflow.nodes = staleWorkflow.nodes.map((node) => node.id === 'SHOT-STALE-generate-image'
    ? { ...node, data: { ...node.data, _output: { outputs: [{ assetId: imageAsset.id, mediaType: 'image' }] } } }
    : node)
  let staleProject = makeProject('wf-stale', 'project-stale', 'SHOT-STALE')
  staleProject = pilotTools.createPilotRunApproval(staleProject, staleWorkflow, 'SHOT-STALE', 'image')
  const staleApproval = staleProject.approvals.find((approval) => approval.status === 'pending' && approval.payload.kind === 'image')!
  staleProject = {
    ...staleProject,
    approvals: staleProject.approvals.map((approval) => approval.id === staleApproval.id
      ? { ...approval, status: 'approved' as const, resolvedAt: Date.now() }
      : approval),
  }
  resetStores(staleProject, staleWorkflow)
  let staleSubmissions = 0
  const stalePipeline = { isRunning: false, activeTaskId: null as string | null, tasks: [] as Array<any> }
  const staleResult = await pilotRuntime.runPilotJob({
    projectId: staleProject.id,
    shotId: 'SHOT-STALE',
    workflowId: staleWorkflow.id,
    generateNodeId: 'SHOT-STALE-generate-image',
    approvalId: staleApproval.id,
    idempotencyKey: String(staleApproval.payload.idempotencyKey),
    kind: 'image',
  }, staleWorkflow, {
    ...dependencies,
    pipelineState: () => stalePipeline,
    run: async (runtimeWorkflow: typeof staleWorkflow, callbacks: any) => {
      staleSubmissions += 1
      const target = runtimeWorkflow.nodes.find((node) => node.type === 'generate')!
      assert.equal((target.data as any)._output, undefined, 'pilot target must not carry stale _output into the runner')
      const task = { id: 'runner-stale', workflowId: runtimeWorkflow.id, status: 'running', progress: 0, results: {}, errors: [] as Array<any>, createdAt: Date.now() }
      stalePipeline.tasks.push(task)
      stalePipeline.activeTaskId = task.id
      stalePipeline.isRunning = true
      callbacks.onNodeStart?.(target.id, target.type)
      task.status = 'completed'
      stalePipeline.activeTaskId = null
      stalePipeline.isRunning = false
    },
  })
  assert.equal(staleSubmissions, 1)
  assert.equal(staleResult.status, 'failed')
  assert.equal(staleResult.error, 'PILOT_OUTPUT_STALE_OR_UNCORRELATED')
  assert.equal(useFilmProjectStore.getState().getProjectForWorkflow(staleWorkflow.id)?.shots[0].imageAssetId, undefined, 'stale _output must never be linked')

  const failedWorkflow = makeWorkflow('wf-fail', 'project-fail', 'SHOT-FAIL')
  let failedProject = makeProject('wf-fail', 'project-fail', 'SHOT-FAIL')
  failedProject = { ...failedProject, pilotShotId: 'SHOT-FAIL', shots: failedProject.shots.map((shot) => ({ ...shot, imageAssetId: imageAsset.id, imageAttempt: 1, status: 'image-approved' as const })) }
  failedProject = pilotTools.createPilotRunApproval(failedProject, failedWorkflow, 'SHOT-FAIL', 'video')
  const failedApproval = failedProject.approvals.find((approval) => approval.status === 'pending' && approval.payload.kind === 'video')!
  failedProject = { ...failedProject, approvals: failedProject.approvals.map((approval) => approval.id === failedApproval.id ? { ...approval, status: 'approved' as const, resolvedAt: Date.now() } : approval) }
  resetStores(failedProject, failedWorkflow)
  const failurePipeline = { isRunning: false, activeTaskId: null as string | null, tasks: [] as Array<any> }
  const failureDependencies = {
    ...dependencies,
    pipelineState: () => failurePipeline,
    run: async (runtimeWorkflow: typeof failedWorkflow, callbacks: any) => {
      const target = runtimeWorkflow.nodes.find((node) => node.type === 'generate')!
      const task = { id: 'runner-failed', workflowId: runtimeWorkflow.id, status: 'running', progress: 0, results: {}, errors: [] as Array<any>, createdAt: Date.now() }
      failurePipeline.tasks.push(task)
      failurePipeline.activeTaskId = task.id
      failurePipeline.isRunning = true
      callbacks.onNodeStart?.(target.id, target.type)
      callbacks.onNodeFail?.(target.id, 'Provider rejected request')
      task.status = 'failed'
      task.errors.push({ nodeId: target.id, message: 'Provider rejected request', timestamp: Date.now(), recoverable: false })
      failurePipeline.activeTaskId = null
      failurePipeline.isRunning = false
    },
  }
  const failedResult = await pilotRuntime.runPilotJob({
    projectId: failedProject.id,
    shotId: 'SHOT-FAIL',
    workflowId: failedWorkflow.id,
    generateNodeId: 'SHOT-FAIL-generate-video',
    approvalId: failedApproval.id,
    idempotencyKey: String(failedApproval.payload.idempotencyKey),
    kind: 'video',
  }, failedWorkflow, failureDependencies)
  assert.equal(failedResult.status, 'failed')
  const projectAfterFailure = useFilmProjectStore.getState().getProjectForWorkflow(failedWorkflow.id)!
  assert.equal(projectAfterFailure.shots[0].imageAssetId, imageAsset.id, 'video failure must preserve approved image')
  assert.equal(projectAfterFailure.shots[0].status, 'image-approved')

  const interrupted = normalizeFilmProject({
    ...projectAfterFailure,
    shots: projectAfterFailure.shots.map((shot) => ({ ...shot, status: 'generating-video' })),
    tasks: projectAfterFailure.tasks.map((task) => task.type === 'pilot-video' ? { ...task, status: 'running' } : task),
  }, true)!
  assert.equal(interrupted.tasks.find((task) => task.type === 'pilot-video')?.status, 'interrupted')
  assert.equal(interrupted.shots[0].status, 'image-approved', 'reload must preserve the approved image and make video regeneration possible')

  storage.set('ai-flow-agent-runs', {
    modesByWorkflow: {}, pendingPatchesByWorkflow: {}, idempotencyResults: {}, activities: [],
    pilotJobs: [{
      id: 'job-reload', idempotencyKey: 'pilot:image:reload:shot:1', projectId: 'reload', shotId: 'shot', workflowId: 'wf',
      generateNodeId: 'generate', approvalId: 'approval', kind: 'image', attempt: 1, status: 'running', createdAt: 1, updatedAt: 1,
    }],
  })
  useAgentStore.setState({ hydrated: false, pilotJobs: [] })
  await useAgentStore.getState().hydrate()
  assert.equal(useAgentStore.getState().pilotJobs[0].status, 'interrupted', 'reload must not auto-resubmit an active pilot job')

  console.log('Phase 2 pilot smoke tests passed: isolation, persisted reservation, freshness rejection, gates, image/video, failure preservation, reload interruption.')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
