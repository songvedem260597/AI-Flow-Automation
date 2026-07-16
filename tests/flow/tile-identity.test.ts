import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dedupeFlowTileObservations,
  createFlowTileLifecycleState,
  isFlowTileInBaseline,
  observeFlowTileLifecycle,
  wasFlowTileObservedProcessing,
} from '../../src/lib/flow/tileIdentity.ts'

test('fixture 1: a lazy-rendered old tile stays suspicious without post-submit processing evidence', () => {
  const processing = new Set<string>()
  assert.equal(wasFlowTileObservedProcessing({ id: 'repaint-2', fileName: 'old.png' }, processing), false)
})

test('fixture 2: a new ID and new filename is not part of the baseline', () => {
  assert.equal(isFlowTileInBaseline(
    { id: 'new-2', fileName: 'new.png' },
    [{ id: 'old-1', fileName: 'old.png' }],
  ), false)
})

test('fixture 3: a new ID with a baseline filename is evaluated by recency instead of auto-rejected', () => {
  assert.equal(isFlowTileInBaseline(
    { id: 'new-2', fileName: 'shared.png' },
    [{ id: 'old-1', fileName: 'shared.png' }],
  ), false)
})

test('fixture 4: a reused ID with a new filename is not treated as the same baseline tile', () => {
  assert.equal(isFlowTileInBaseline(
    { id: 'reused-1', fileName: 'new.png' },
    [{ id: 'reused-1', fileName: 'old.png' }],
  ), false)
})

test('fixture 5: two different IDs with the same filename remain distinct', () => {
  const result = dedupeFlowTileObservations([
    { id: 'tile-a', fileName: 'shared.png' },
    { id: 'tile-b', fileName: 'shared.png' },
  ])
  assert.equal(result.length, 2)
})

test('fixture 6: processing to done is accepted for the same observed tile ID', () => {
  const processing = new Set(['tile-a'])
  assert.equal(wasFlowTileObservedProcessing({ id: 'tile-a', fileName: 'result.png' }, processing), true)
})

test('fixture 7: transient failed to processing to done is confirmed instead of failed', () => {
  const state = createFlowTileLifecycleState()
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-retry', status: 'failed' }, 0), 'pending')
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-retry', status: 'processing' }, 1_000), 'pending')
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-retry', status: 'done', fileName: 'retry.png' }, 2_000), 'confirmed')
})

test('fixture 8: a stable failure is promoted only after debounce', () => {
  const state = createFlowTileLifecycleState()
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-fail', status: 'failed' }, 1_000), 'pending')
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-fail', status: 'failed' }, 15_999), 'pending')
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-fail', status: 'failed' }, 16_000), 'failed')
})

test('fixture 12: a done tile never observed processing remains suspicious', () => {
  const state = createFlowTileLifecycleState()
  assert.equal(observeFlowTileLifecycle(state, { id: 'tile-done-only', status: 'done', fileName: 'old.png' }, 1_000), 'suspicious_done')
})
