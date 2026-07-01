import React from 'react'
import { ListChecks } from 'lucide-react'
import { usePipelineStore } from '@/stores/pipelineStore'
import { cn } from '@/lib/utils'

export const TasksPanel: React.FC = () => {
  const tasks = usePipelineStore((s) => s.tasks)

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      <div className="px-4 py-3 border-b border-white/5">
        <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">Tasks</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-white/20">
            <ListChecks className="w-8 h-8 mb-2" />
            <p className="text-xs">No tasks yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="p-3 bg-[#1A1A1A] rounded-xl border border-white/5"
              >
                <div className="flex items-center gap-2">
                  <div className={cn(
                    'w-2 h-2 rounded-full',
                    task.status === 'running' && 'bg-emerald-400 animate-pulse',
                    task.status === 'completed' && 'bg-emerald-500',
                    task.status === 'failed' && 'bg-red-500',
                    task.status === 'pending' && 'bg-white/20',
                    task.status === 'paused' && 'bg-amber-400'
                  )} />
                  <span className="text-xs text-white/60 truncate flex-1">
                    {task.workflowId.slice(0, 8)}...
                  </span>
                  <span className={cn(
                    'text-[10px] font-medium',
                    task.status === 'running' && 'text-emerald-400',
                    task.status === 'completed' && 'text-emerald-500',
                    task.status === 'failed' && 'text-red-400',
                    task.status === 'pending' && 'text-white/30',
                    task.status === 'paused' && 'text-amber-400'
                  )}>
                    {task.status}
                  </span>
                </div>
                {task.status === 'running' && (
                  <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
