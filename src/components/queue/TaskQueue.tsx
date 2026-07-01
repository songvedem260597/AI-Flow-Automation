import React from 'react'
import { motion } from 'framer-motion'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import { cn } from '@/lib/utils'
import { Play, Pause, Square, Trash2, Clock, CheckCircle2, XCircle, Loader2, ListX } from 'lucide-react'
import { formatDuration } from '@/lib/utils'

export const TaskQueue: React.FC = () => {
  const tasks = usePipelineStore((s) => s.tasks)
  const deleteTask = usePipelineStore((s) => s.deleteTask)
  const clearCompletedTasks = usePipelineStore((s) => s.clearCompletedTasks)
  const workflows = useWorkflowStore((s) => s.workflows)

  const statusConfig = {
    pending: { icon: Clock, color: 'text-white/40', bg: 'bg-white/10' },
    running: { icon: Loader2, color: 'text-blue-400', bg: 'bg-blue-500/20', animate: true },
    completed: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/20' },
    failed: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/20' },
    cancelled: { icon: XCircle, color: 'text-amber-400', bg: 'bg-amber-500/20' },
    paused: { icon: Pause, color: 'text-amber-400', bg: 'bg-amber-500/20' }
  }

  const runningTasks = tasks.filter((t) => t.status === 'running' || t.status === 'pending')
  const completedTasks = tasks.filter((t) => ['completed', 'failed', 'cancelled'].includes(t.status))

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white/80">Pipeline Tasks</h2>
          <p className="text-xs text-white/30 mt-0.5">{tasks.length} total tasks</p>
        </div>
        {completedTasks.length > 0 && (
          <button
            onClick={clearCompletedTasks}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors"
          >
            <ListX className="w-3.5 h-3.5" />
            Clear Completed
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-3">
        {runningTasks.length > 0 && (
          <>
            <h3 className="text-xs font-medium text-white/30 uppercase tracking-wider">Active</h3>
            {runningTasks.map((task) => {
              const wf = workflows.find((w) => w.id === task.workflowId)
              const config = statusConfig[task.status]
              const Icon = config.icon

              return (
                <motion.div
                  key={task.id}
                  layout
                  className="bg-white/5 border border-white/10 rounded-xl p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className={cn('p-1.5 rounded-lg', config.bg)}>
                        <Icon className={cn('w-4 h-4', config.color, config.animate && 'animate-spin')} />
                      </div>
                      <div>
                        <h4 className="text-sm font-medium text-white/80">{wf?.name || 'Unknown Workflow'}</h4>
                        <p className="text-xs text-white/40 capitalize">{task.status}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70">
                        <Pause className="w-3.5 h-3.5" />
                      </button>
                      <button className="p-1.5 rounded hover:bg-red-500/10 text-white/40 hover:text-red-400">
                        <Square className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white/40">Progress</span>
                      <span className="text-white/70 font-mono">{task.progress}%</span>
                    </div>
                    <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-violet-500 to-blue-500 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${task.progress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                    {task.currentNodeId && (
                      <p className="text-xs text-white/30 truncate">Node: {task.currentNodeId}</p>
                    )}
                  </div>
                </motion.div>
              )
            })}
          </>
        )}

        {completedTasks.length > 0 && (
          <>
            <h3 className="text-xs font-medium text-white/30 uppercase tracking-wider">History</h3>
            {completedTasks.map((task) => {
              const wf = workflows.find((w) => w.id === task.workflowId)
              const config = statusConfig[task.status]
              const Icon = config.icon
              const duration = task.startedAt && task.completedAt ? task.completedAt - task.startedAt : 0

              return (
                <motion.div
                  key={task.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="bg-white/[0.02] border border-white/5 rounded-xl p-3 hover:border-white/10 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon className={cn('w-4 h-4 flex-shrink-0', config.color)} />
                      <div className="min-w-0">
                        <h4 className="text-sm text-white/60 truncate">{wf?.name || 'Unknown'}</h4>
                        <p className="text-xs text-white/30 capitalize">{task.status}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {duration > 0 && (
                        <span className="text-xs text-white/30 font-mono">{formatDuration(duration)}</span>
                      )}
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="p-1 rounded hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </>
        )}

        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-white/20">
            <ListX className="w-8 h-8 mb-2" />
            <p className="text-sm">No tasks yet</p>
            <p className="text-xs mt-1">Run a workflow to see tasks here</p>
          </div>
        )}
      </div>
    </div>
  )
}
