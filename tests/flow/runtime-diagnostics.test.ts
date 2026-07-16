import assert from 'node:assert/strict'
import test from 'node:test'

import { FlowAdmissionController } from '../../src/background/flow/FlowAdmissionController.ts'
import {
  FLOW_BACKGROUND_BUILD_MARKER,
  FLOW_BRIDGE_BUILD_MARKER,
  FLOW_CONTENT_BUILD_MARKER,
  buildFlowRuntimeHandshake,
  buildFlowRuntimeHealthReport,
  createFlowRuntimeDiagnosticState,
  detectDuplicateRuntimeInstances,
  evaluateRuntimeMarker,
  resetFlowRuntimeDiagnosticLogs,
  sanitizeFlowRuntimeReport,
} from '../../src/lib/flow/runtimeDiagnostics.ts'

test('runtime diagnostic report sanitizer redacts and hashes sensitive values', async () => {
  const unsafe = {
    prompt: 'draw a private lighthouse',
    cookie: 'SID=private-cookie',
    Authorization: 'Bearer private-token',
    apiKey: 'sk-private-api-key',
    negativePrompt: 'private negative prompt',
    requestBody: { prompt: 'nested secret prompt' },
    responseBody: 'private response',
    editorContent: 'private editor value',
    tileId: 'tile-user-123',
    fileName: 'customer-alice@example.com-reference.png',
    mediaUrl: 'https://lh3.googleusercontent.com/private/path/image.png?X-Goog-Signature=secret',
    currentUrl: 'https://labs.google/fx/tools/flow/project/test?authuser=alice@example.com#private',
    error: 'Authorization: Bearer another-secret for alice@example.com',
  }

  const sanitized = await sanitizeFlowRuntimeReport(unsafe)
  const serialized = JSON.stringify(sanitized)

  for (const forbidden of [
    'draw a private lighthouse',
    'private-cookie',
    'private-token',
    'sk-private-api-key',
    'private negative prompt',
    'nested secret prompt',
    'private response',
    'private editor value',
    'tile-user-123',
    'customer-alice@example.com-reference.png',
    'X-Goog-Signature',
    'alice@example.com',
    'another-secret',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `report leaked ${forbidden}`)
  }
  assert.match(serialized, /sha256:/)
  assert.match(serialized, /https:\/\/labs\.google\/fx\/tools\/flow\/project\/test/)
})

test('runtime markers distinguish match, missing, and mismatch', () => {
  assert.equal(evaluateRuntimeMarker(FLOW_BACKGROUND_BUILD_MARKER, FLOW_BACKGROUND_BUILD_MARKER), 'MATCH')
  assert.equal(evaluateRuntimeMarker(FLOW_CONTENT_BUILD_MARKER, undefined), 'MISSING')
  assert.equal(evaluateRuntimeMarker(FLOW_BRIDGE_BUILD_MARKER, 'flow-bridge:old-build'), 'MISMATCH')
})

test('duplicate instance detection is scoped to the current document', () => {
  const instances = [
    { instanceId: 'old-doc-instance', documentId: 'old-doc', active: true },
    { instanceId: 'current-a', documentId: 'current-doc', active: true },
    { instanceId: 'current-b', documentId: 'current-doc', active: true },
    { instanceId: 'inactive-current', documentId: 'current-doc', active: false },
  ]
  const duplicate = detectDuplicateRuntimeInstances(instances, 'current-doc')
  assert.equal(duplicate.duplicateDetected, true)
  assert.equal(duplicate.activeCount, 2)

  const newDocument = detectDuplicateRuntimeInstances(instances, 'new-doc')
  assert.equal(newDocument.duplicateDetected, false)
  assert.equal(newDocument.activeCount, 0)
})

test('handshake reports partial failure without promoting missing layers', () => {
  const result = buildFlowRuntimeHandshake({
    timestamp: 100,
    backgroundInstanceId: 'bg-1',
    tabId: 7,
    flowUrlValid: true,
    contentResponse: {
      contentReady: true,
      contentInstanceId: 'content-1',
      contentMarker: FLOW_CONTENT_BUILD_MARKER,
      bridgeReady: false,
      duplicateListenerDetected: false,
      error: 'bridge_channel_unavailable',
    },
  })

  assert.equal(result.backgroundReady, true)
  assert.equal(result.contentReady, true)
  assert.equal(result.bridgeReady, false)
  assert.equal(result.markerStatus.background, 'MATCH')
  assert.equal(result.markerStatus.content, 'MATCH')
  assert.equal(result.markerStatus.bridge, 'MISSING')
  assert.equal(result.success, false)
})

test('resetting diagnostic logs preserves the admission controller state', async () => {
  const controller = new FlowAdmissionController({
    now: () => 1_000,
    createJobId: () => 'flow-active',
  })
  await controller.requestAdmission({ source: 'gen-panel', tabId: 3, mediaType: 'image' }, async () => ({
    healthy: false,
    tabExists: true,
    bridgeReady: true,
    composerPresent: true,
    processing: 0,
    pending: 0,
    generating: 0,
    blockingDialog: true,
    errorCode: 'unusual_activity',
    statusReason: 'fixture_block',
    evidence: [],
  }))
  const admissionBefore = await controller.getDiagnostics()
  const diagnostics = createFlowRuntimeDiagnosticState({ enabled: true, now: 1_000 })
  diagnostics.logs.push({ timestamp: 1_001, event: 'fixture', runtimeSessionId: diagnostics.runtimeSessionId! })

  const reset = resetFlowRuntimeDiagnosticLogs(diagnostics, 1_002)
  const admissionAfter = await controller.getDiagnostics()

  assert.equal(reset.logs.length, 0)
  assert.equal(reset.enabled, true)
  assert.equal(reset.runtimeSessionId, diagnostics.runtimeSessionId)
  assert.deepEqual(admissionAfter, admissionBefore)
})

test('exported diagnostic payload excludes sensitive values at every nesting level', async () => {
  const report = await sanitizeFlowRuntimeReport({
    logs: [
      { event: 'unsafe', prompt: 'do not export me', token: 'token-123' },
      { event: 'unsafe-url', mediaUrl: 'https://googleusercontent.com/a/b?token=signed-secret' },
    ],
    consoleErrors: ['Request for jane@example.com failed with Authorization: Bearer abc.def.ghi'],
    nested: { fileName: 'Jane Project Final.png' },
  })
  const serialized = JSON.stringify(report)

  for (const forbidden of ['do not export me', 'token-123', 'signed-secret', 'jane@example.com', 'abc.def.ghi', 'Jane Project Final.png']) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('admission diagnostic snapshot is read-only and does not persist or expire leases', async () => {
  let saveCount = 0
  const persisted = {
    scope: 'google-flow-global' as const,
    state: 'admitted' as const,
    activeJob: {
      jobId: 'persisted-job',
      source: 'workflow',
      tabId: 9,
      mediaType: 'image' as const,
      requestedAt: 100,
      admittedAt: 110,
      state: 'admitted' as const,
    },
    lastJob: null,
    cooldownUntil: 0,
    capturedAt: 110,
  }
  const controller = new FlowAdmissionController({
    now: () => 1_000_000,
    storage: {
      load: async () => persisted,
      save: async () => { saveCount += 1 },
    },
    preSubmitLeaseMs: 10,
  })

  const first = await controller.getDiagnostics()
  const second = await controller.getDiagnostics()

  assert.equal(first.state, 'admitted')
  assert.equal(second.state, 'admitted')
  assert.equal(first.ownerJobId, 'persisted-job')
  assert.equal(saveCount, 0)
})

test('unknown health signals remain unknown instead of becoming pass', () => {
  const report = buildFlowRuntimeHealthReport({
    timestamp: 200,
    tabExists: true,
    validFlowRoute: true,
    bridgeReady: null,
    composerDetected: null,
    blockingDialogDetected: null,
    errorCode: null,
    processingTileCount: null,
    pendingTileCount: null,
    generatingTileCount: null,
  })

  assert.equal(report.bridgeReady.status, 'unknown')
  assert.equal(report.composerDetected.status, 'unknown')
  assert.equal(report.blockingDialogDetected.status, 'unknown')
  assert.equal(report.sessionWarningDetected.status, 'unknown')
  assert.equal(report.processingTileCount.status, 'unknown')
})
