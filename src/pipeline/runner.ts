import type { Workflow, WorkflowNode, FlowNodeData, AIProvider } from '@/types'
import { getAdapter, type ProviderAdapter } from '@/providers'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useHistoryStore } from '@/stores/dataStore'
import { useSettingsStore } from '@/stores/settingsStore'

export class PipelineRunner {
  private workflow: Workflow
  private adapter: ProviderAdapter
  private context: Record<string, unknown> = {}
  private isRunning = false
  private isPaused = false
  private shouldStop = false
  private taskId: string
  private wakeLock: WakeLockSentinel | null = null
  private retryCount = 0

  constructor(workflow: Workflow, taskId: string) {
    this.workflow = workflow
    this.taskId = taskId
    const provider = this.detectProvider()
    this.adapter = getAdapter(provider)
  }

  private detectProvider(): AIProvider {
    const promptNode = this.workflow.nodes.find((n) => n.type === 'prompt' || n.type === 'generate')
    if (promptNode) {
      const data = promptNode.data as Record<string, unknown>
      if (data.provider) return data.provider as AIProvider
    }
    return useSettingsStore.getState().defaultProvider
  }

  private getSortedNodes(): WorkflowNode[] {
    const visited = new Set<string>()
    const sorted: WorkflowNode[] = []
    const nodeMap = new Map(this.workflow.nodes.map((n) => [n.id, n]))

    const rootNodes = this.workflow.nodes.filter(
      (n) => !this.workflow.edges.some((e) => e.target === n.id)
    )

    const visit = (node: WorkflowNode) => {
      if (visited.has(node.id)) return
      visited.add(node.id)
      sorted.push(node)

      const outgoing = this.workflow.edges.filter((e) => e.source === node.id)
      for (const edge of outgoing) {
        const nextNode = nodeMap.get(edge.target)
        if (nextNode) visit(nextNode)
      }
    }

    for (const root of rootNodes.length > 0 ? rootNodes : this.workflow.nodes) {
      visit(root)
    }

    return sorted
  }

  async run(): Promise<void> {
    this.isRunning = true
    this.shouldStop = false
    this.retryCount = 0

    const pipelineStore = usePipelineStore.getState()
    const settings = useSettingsStore.getState()

    try {
      await this.acquireWakeLock()
      pipelineStore.startPipeline(this.taskId)
      pipelineStore.addLog(this.taskId, 'info', `Pipeline started: ${this.workflow.name}`)

      await this.adapter.open()
      pipelineStore.addLog(this.taskId, 'success', 'Provider opened')

      const sortedNodes = this.getSortedNodes()
      const totalNodes = sortedNodes.length

      for (let i = 0; i < sortedNodes.length; i++) {
        if (this.shouldStop) {
          pipelineStore.stopPipeline(this.taskId)
          pipelineStore.addLog(this.taskId, 'warn', 'Pipeline stopped by user')
          break
        }

        while (this.isPaused) {
          await new Promise((r) => setTimeout(r, 500))
          if (this.shouldStop) break
        }

        const node = sortedNodes[i]
        const progress = Math.round(((i + 1) / totalNodes) * 100)

        pipelineStore.updateProgress(this.taskId, node.id, progress)
        pipelineStore.addLog(this.taskId, 'info', `Executing: ${node.data.label}`, node.id)

        try {
          const result = await this.executeNode(node)
          this.context[node.id] = result
          pipelineStore.updateProgress(this.taskId, node.id, progress, {
            ...pipelineStore.getActiveTask()?.results,
            [node.id]: result
          })
          pipelineStore.addLog(this.taskId, 'success', `Completed: ${node.data.label}`, node.id)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          pipelineStore.addLog(this.taskId, 'error', `Failed: ${node.data.label} — ${errorMessage}`, node.id)

          if (this.retryCount < settings.maxRetries) {
            this.retryCount++
            pipelineStore.addLog(this.taskId, 'warn', `Retrying (${this.retryCount}/${settings.maxRetries})...`, node.id)
            await new Promise((r) => setTimeout(r, settings.retryDelay))
            i--
            continue
          }

          pipelineStore.failPipeline(this.taskId, {
            nodeId: node.id,
            message: errorMessage,
            timestamp: Date.now(),
            recoverable: false
          })
          break
        }
      }

      if (!this.shouldStop) {
        const task = pipelineStore.getActiveTask()
        if (task && task.status !== 'failed') {
          pipelineStore.completePipeline(this.taskId, this.context)

          useHistoryStore.getState().addEntry({
            workflowId: this.workflow.id,
            workflowName: this.workflow.name,
            status: 'completed',
            duration: task.startedAt ? Date.now() - task.startedAt : undefined,
            nodeResults: this.context,
            errorCount: 0
          })

          pipelineStore.addLog(this.taskId, 'success', 'Pipeline completed successfully')
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      pipelineStore.failPipeline(this.taskId, {
        nodeId: '',
        message: errorMessage,
        timestamp: Date.now(),
        recoverable: false
      })
      pipelineStore.addLog(this.taskId, 'error', `Pipeline failed: ${errorMessage}`)
    } finally {
      await this.releaseWakeLock()
      await this.adapter.cleanup()
      this.isRunning = false
    }
  }

  private async executeNode(node: WorkflowNode): Promise<unknown> {
    const data = node.data as FlowNodeData

    switch (node.type) {
      case 'prompt': {
        const promptData = data as { prompt: string; provider?: AIProvider; model?: string }
        if (promptData.provider && promptData.provider !== this.adapter.name) {
          this.adapter = getAdapter(promptData.provider)
          await this.adapter.open()
        }
        if (promptData.model) await this.adapter.setModel?.(promptData.model)
        const resolvedPrompt = this.interpolateVariables(promptData.prompt)
        await this.adapter.insertPrompt(resolvedPrompt)
        return { prompt: resolvedPrompt }
      }

      case 'image': {
        const imageData = data as { imageUrl?: string; imageData?: string; aspectRatio?: string }
        if (imageData.aspectRatio) await this.adapter.setAspectRatio?.(imageData.aspectRatio)
        if (imageData.imageData) await this.adapter.uploadImage?.(imageData.imageData)
        return { imageUrl: imageData.imageUrl, aspectRatio: imageData.aspectRatio }
      }

      case 'generate': {
        const genData = data as {
          provider?: AIProvider
          model?: string
          mediaType?: 'image' | 'video'
          aspectRatio?: string
          videoDuration?: string
          autoGenerate?: boolean
          waitForCompletion?: boolean
        }
        if (genData.provider && genData.provider !== this.adapter.name) {
          this.adapter = getAdapter(genData.provider)
          await this.adapter.open()
        }

        const mediaType = genData.provider === 'google-flow' && genData.mediaType === 'video' ? 'video' : 'image'
        await this.adapter.setMediaType?.(mediaType)
        if (genData.aspectRatio) await this.adapter.setAspectRatio?.(genData.aspectRatio)
        if (genData.provider === 'google-flow' && genData.model) await this.adapter.setModel?.(genData.model)
        if (mediaType === 'video' && genData.videoDuration) await this.adapter.setDuration?.(genData.videoDuration)

        if (genData.autoGenerate !== false) await this.adapter.clickGenerate()
        if (genData.waitForCompletion !== false) {
          const result = await this.adapter.waitForResult()
          return {
            result,
            mediaType,
            aspectRatio: genData.aspectRatio,
            model: genData.provider === 'google-flow' ? genData.model : undefined,
            videoDuration: mediaType === 'video' ? genData.videoDuration : undefined
          }
        }
        return {
          triggered: true,
          mediaType,
          aspectRatio: genData.aspectRatio,
          model: genData.provider === 'google-flow' ? genData.model : undefined,
          videoDuration: mediaType === 'video' ? genData.videoDuration : undefined
        }
      }

      case 'delay': {
        const delayData = data as { duration: number }
        await new Promise((r) => setTimeout(r, delayData.duration))
        return { delayed: delayData.duration }
      }

      case 'download': {
        const downloadData = data as { format?: string; filename?: string }
        const result = await this.adapter.downloadResult?.()
        if (result) {
          await this.downloadFile(result, downloadData.format || 'png', downloadData.filename)
        }
        return { downloaded: true, format: downloadData.format }
      }

      case 'wait': {
        const waitData = data as { condition?: string; selector?: string; timeout?: number }
        await this.waitForCondition(waitData)
        return { waited: true }
      }

      default:
        return { executed: true }
    }
  }

  private interpolateVariables(prompt: string): string {
    let result = prompt
    for (const [key, value] of Object.entries(this.context)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value))
    }
    return result
  }

  private async waitForCondition(config: { condition?: string; selector?: string; timeout?: number }): Promise<void> {
    const { condition = 'dom-change', selector, timeout = 30000 } = config
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Wait condition timeout')), timeout)
      if (condition === 'manual') {
        clearTimeout(timeoutId)
        resolve()
      } else {
        clearTimeout(timeoutId)
        resolve()
      }
    })
  }

  private async downloadFile(data: string, format: string, filename?: string): Promise<void> {
    const settings = useSettingsStore.getState()
    if (!settings.autoDownload) return

    const name = filename || `ai-flow-${Date.now()}`
    const mimeType = format === 'png' ? 'image/png' : format === 'jpg' ? 'image/jpeg' : 'image/webp'

    const base64Data = data.replace(/^data:[^;]+;base64,/, '')
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    const blob = new Blob([bytes], { type: mimeType })
    const url = URL.createObjectURL(blob)

    await chrome.downloads.download({
      url,
      filename: `${name}.${format}`,
      saveAs: true
    })

    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  pause(): void {
    this.isPaused = true
    usePipelineStore.getState().pausePipeline(this.taskId)
  }

  resume(): void {
    this.isPaused = false
    usePipelineStore.getState().resumePipeline(this.taskId)
  }

  stop(): void {
    this.shouldStop = true
    this.isRunning = false
    usePipelineStore.getState().stopPipeline(this.taskId)
  }

  private async acquireWakeLock(): Promise<void> {
    const settings = useSettingsStore.getState()
    if (settings.wakeLockEnabled && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen')
      } catch {
        // Wake lock not available
      }
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLock) {
      await this.wakeLock.release()
      this.wakeLock = null
    }
  }
}

let currentRunner: PipelineRunner | null = null

export async function runPipeline(workflow: Workflow): Promise<void> {
  if (currentRunner?.isRunning) {
    throw new Error('A pipeline is already running')
  }
  const pipelineStore = usePipelineStore.getState()
  const task = pipelineStore.createTask(workflow.id)
  currentRunner = new PipelineRunner(workflow, task.id)
  await currentRunner.run()
}

export function pausePipeline(): void {
  currentRunner?.pause()
}

export function resumePipeline(): void {
  currentRunner?.resume()
}

export function stopPipeline(): void {
  currentRunner?.stop()
  currentRunner = null
}
