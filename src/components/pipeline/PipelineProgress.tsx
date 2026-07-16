import React, { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import { cn } from '@/lib/utils'
import {
  Play, Pause, Square, Loader2, CheckCircle2, XCircle,
  ChevronRight, X, Minimize2, Maximize2
} from 'lucide-react'
import type { FlowRecoverySnapshot } from '@/types/flow'

interface PipelineProgressProps {
  compact?: boolean
}

function workflowRecoveryText(snapshot: FlowRecoverySnapshot | null): string {
  if (!snapshot) return 'Flow recovery status unavailable'
  if (snapshot.errorCode === 'submit_uncertain') return 'Flow job status uncertain — open GenPanel'
  if (snapshot.state === 'healthy') return 'Flow healthy'
  if (snapshot.state === 'session_suspect') return 'Flow session needs recovery — open GenPanel'
  if (snapshot.state === 'recovering') return 'Refreshing Flow session'
  if (snapshot.state === 'rate_limited' || snapshot.state === 'cooldown') return 'Flow rate limited — waiting for cooldown'
  if (snapshot.state === 'blocked') return 'Flow blocked — open GenPanel for user action'
  return 'Flow transient failure — open GenPanel'
}

export const PipelineProgress: React.FC<PipelineProgressProps> = ({ compact }) => {
  const isRunning = usePipelineStore((s) => s.isRunning)
  const isPaused = usePipelineStore((s) => s.isPaused)
  const activeTaskId = usePipelineStore((s) => s.activeTaskId)
  const tasks = usePipelineStore((s) => s.tasks)
  const logs = usePipelineStore((s) => s.logs)
  const workflows = useWorkflowStore((s) => s.workflows)

  const activeTask = tasks.find((t) => t.id === activeTaskId)
  const activeWorkflow = activeTask ? workflows.find((w) => w.id === activeTask.workflowId) : null
  const workflowUsesFlow = activeWorkflow?.nodes.some((node) => (
    node.type === 'generate' && (node.data as { provider?: string }).provider === 'google-flow'
  )) === true
  const taskLogs = logs.filter((l) => l.pipelineId === activeTaskId).slice(0, 10)

  const [isExpanded, setIsExpanded] = React.useState(!compact)
  const [isMinimized, setIsMinimized] = React.useState(false)
  const [flowRecovery, setFlowRecovery] = React.useState<FlowRecoverySnapshot | null>(null)

  useEffect(() => {
    if (!activeTask || !workflowUsesFlow) {
      setFlowRecovery(null)
      return
    }
    let disposed = false
    const refresh = () => {
      chrome.runtime.sendMessage({ action: 'FLOW_GET_RECOVERY_SNAPSHOT' }).then((response: { success?: boolean; snapshot?: FlowRecoverySnapshot } | undefined) => {
        if (!disposed && response?.success === true && response.snapshot) setFlowRecovery(response.snapshot)
      }).catch(() => undefined)
    }
    refresh()
    const interval = window.setInterval(refresh, 3_000)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [activeTask?.id, workflowUsesFlow])

  if (!isRunning && !activeTask) return null

  const statusConfig = {
    running: { icon: Loader2, color: 'text-blue-400', text: 'Running', animate: true },
    paused: { icon: Pause, color: 'text-amber-400', text: 'Paused' },
    pending: { icon: Loader2, color: 'text-white/40', text: 'Starting' }
  }

  const config = activeTask ? statusConfig[activeTask.status] || statusConfig.running : statusConfig.running
  const Icon = config.icon

  if (compact && !isExpanded) {
    return (
      <motion.button
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={() => setIsExpanded(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-[#0d0d12]/90 backdrop-blur-xl rounded-xl border border-white/10 shadow-lg"
      >
        <div className={cn('p-1 rounded-md bg-white/5', config.animate && 'animate-spin')}>
          <Icon className={cn('w-3.5 h-3.5', config.color)} />
        </div>
        <span className="text-xs text-white/70">{activeWorkflow?.name || 'Pipeline'}</span>
        <span className="text-xs text-white/40 font-mono">{activeTask?.progress || 0}%</span>
      </motion.button>
    )
  }

  if (isMinimized) {
    return (
      <motion.button
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={() => setIsMinimized(false)}
        className="fixed bottom-4 right-4 flex items-center gap-2 px-4 py-2.5 bg-[#0d0d12]/95 backdrop-blur-xl rounded-xl border border-violet-500/30 shadow-[0_0_30px_rgba(139,92,246,0.2)] z-50"
      >
        <div className={cn('p-1 rounded-md bg-white/5', config.animate && 'animate-spin')}>
          <Icon className={cn('w-4 h-4', config.color)} />
        </div>
        <div>
          <p className="text-xs font-medium text-white/80">{activeWorkflow?.name || 'Pipeline'}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-white/40">{config.text}</span>
            <span className="text-[10px] text-white/30 font-mono">{activeTask?.progress || 0}%</span>
          </div>
        </div>
      </motion.button>
    )
  }

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0, y: 20 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.9, opacity: 0, y: 20 }}
      className={cn(
        'fixed z-50 bg-[#0d0d12]/95 backdrop-blur-xl rounded-2xl border shadow-[0_0_40px_rgba(139,92,246,0.15)] overflow-hidden',
        compact ? 'bottom-4 right-4 w-80' : 'inset-4 m-auto max-w-md max-h-[80vh]'
      )}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-gradient-to-r from-violet-500/10 to-pink-500/10">
        <div className="flex items-center gap-3">
          <div className={cn('p-2 rounded-xl bg-white/5', config.animate && 'animate-spin')}>
            <Icon className={cn('w-5 h-5', config.color)} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white/90">{activeWorkflow?.name || 'Pipeline Running'}</h3>
            <p className="text-xs text-white/40">{config.text}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setIsMinimized(true)} className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors">
            <Minimize2 className="w-4 h-4" />
          </button>
          {compact && (
            <button onClick={() => setIsExpanded(false)} className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {workflowUsesFlow && (
          <div className={cn(
            'rounded-lg border px-3 py-2 text-[10px]',
            flowRecovery?.state === 'healthy'
              ? 'border-emerald-400/15 bg-emerald-400/5 text-emerald-200/70'
              : 'border-amber-400/20 bg-amber-400/5 text-amber-200/80',
          )}>
            {workflowRecoveryText(flowRecovery)}
          </div>
        )}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-white/40">Progress</span>
            <span className="text-white/70 font-mono">{activeTask?.progress || 0}%</span>
          </div>
          <div className="h-2 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-violet-500 via-purple-500 to-pink-500 rounded-full"
              animate={{ width: `${activeTask?.progress || 0}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
        </div>

        {taskLogs.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            <h4 className="text-xs font-medium text-white/30 uppercase tracking-wider">Recent Logs</h4>
            {taskLogs.map((log) => (
              <div key={log.id} className="flex items-start gap-2 text-xs">
                <ChevronRight className={cn(
                  'w-3 h-3 mt-0.5 flex-shrink-0',
                  log.level === 'success' && 'text-emerald-400',
                  log.level === 'error' && 'text-red-400',
                  log.level === 'warn' && 'text-amber-400',
                  log.level === 'info' && 'text-white/30'
                )} />
                <span className={cn(
                  'text-white/50',
                  log.level === 'success' && 'text-emerald-300/70',
                  log.level === 'error' && 'text-red-300/70',
                  log.level === 'warn' && 'text-amber-300/70'
                )}>
                  {log.message}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 rounded-xl text-sm text-white/70 transition-colors">
            <Pause className="w-4 h-4" />
            Pause
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-xl text-sm transition-colors">
            <Square className="w-4 h-4" />
            Stop
          </button>
        </div>
      </div>
    </motion.div>
  )
}
