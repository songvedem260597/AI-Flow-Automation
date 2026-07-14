import React from 'react'
import { CheckCircle2, Circle, Clock3, ListChecks, LoaderCircle, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FilmProject } from '@/agent/schemas/filmProjectSchemas'
import type { AgentToolActivity } from '@/agent/stores/agentStore'

export const AgentTasks: React.FC<{ project: FilmProject | null; activities: AgentToolActivity[] }> = ({ project, activities }) => {
  if (!project) {
    return <div className="flex h-full flex-col items-center justify-center px-8 text-center"><ListChecks className="h-6 w-6 text-white/18" /><p className="mt-3 text-[11px] font-medium text-white/52">No production plan yet</p><p className="mt-1 text-[9px] leading-4 text-white/28">Describe a film in Chat to create the brief, task graph, scenes and shots.</p></div>
  }
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div><p className="text-[11px] font-semibold text-white/80">Production tasks</p><p className="mt-0.5 text-[8px] text-white/28">Dependencies keep provider side effects sequential.</p></div>
        <span className="rounded-full bg-[#7C5CFF]/12 px-2 py-1 text-[8px] font-semibold text-[#C8BCFF]">{project.tasks.filter((task) => task.status === 'completed').length}/{project.tasks.length}</span>
      </div>
      <div className="space-y-1.5">
        {project.tasks.map((task) => {
          const taskActive = task.status === 'running' || task.status === 'waiting-output' || task.status === 'queued'
          const Icon = task.status === 'completed' ? CheckCircle2 : taskActive ? LoaderCircle : task.status === 'failed' || task.status === 'interrupted' ? TriangleAlert : task.status === 'waiting-approval' ? Clock3 : Circle
          const statusOnly = task.progressMode === 'status'
          return (
            <div key={task.id} className="rounded-xl border border-white/[0.07] bg-white/[0.018] px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', task.status === 'completed' ? 'text-emerald-300/75' : task.status === 'failed' || task.status === 'interrupted' ? 'text-red-300/75' : task.status === 'waiting-approval' ? 'text-amber-300/75' : taskActive ? 'animate-spin text-[#B8A8FF]' : 'text-white/20')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3"><p className="truncate text-[10px] font-medium text-white/68">{task.title}</p><span className="shrink-0 text-[8px] capitalize text-white/26">{statusOnly ? task.status.replace('-', ' ') : `${task.progress}%`}</span></div>
                  {!statusOnly && <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-[#8E73FF] transition-[width]" style={{ width: `${task.progress}%` }} /></div>}
                  {task.dependsOn.length > 0 && <p className="mt-1.5 truncate text-[7px] text-white/20">Depends on {task.dependsOn.join(', ')}</p>}
                  {task.error && <p className="mt-1.5 text-[8px] leading-3 text-red-200/60">{task.error}</p>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {activities.length > 0 && (
        <div className="pt-1"><p className="mb-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-white/25">Tool activity</p><div className="space-y-1">{activities.slice(-8).reverse().map((activity) => <div key={activity.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-[8px] text-white/36"><span className={cn('h-1.5 w-1.5 rounded-full', activity.status === 'completed' ? 'bg-emerald-300/70' : activity.status === 'failed' ? 'bg-red-300/70' : activity.status === 'waiting-approval' ? 'bg-amber-300/70' : 'bg-[#A895FF]')} /><span className="truncate">{activity.summary}</span></div>)}</div></div>
      )}
    </div>
  )
}
