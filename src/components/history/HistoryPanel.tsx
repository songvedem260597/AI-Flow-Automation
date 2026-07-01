import React from 'react'
import { motion } from 'framer-motion'
import { useHistoryStore } from '@/stores/dataStore'
import { cn } from '@/lib/utils'
import { CheckCircle2, XCircle, Clock, Trash2, RotateCcw, History } from 'lucide-react'
import { formatDate, formatDuration } from '@/lib/utils'

export const HistoryPanel: React.FC = () => {
  const entries = useHistoryStore((s) => s.entries)
  const deleteEntry = useHistoryStore((s) => s.deleteEntry)
  const clearHistory = useHistoryStore((s) => s.clearHistory)

  const statusConfig = {
    completed: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/20' },
    failed: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/20' },
    cancelled: { icon: XCircle, color: 'text-amber-400', bg: 'bg-amber-500/20' },
    running: { icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/20' }
  }

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white/80">Run History</h2>
          <p className="text-xs text-white/30 mt-0.5">{entries.length} entries</p>
        </div>
        {entries.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear All
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-white/20">
            <History className="w-8 h-8 mb-2" />
            <p className="text-sm">No history yet</p>
            <p className="text-xs mt-1">Completed pipelines appear here</p>
          </div>
        ) : (
          entries.map((entry) => {
            const config = statusConfig[entry.status] || statusConfig.completed
            const Icon = config.icon

            return (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white/5 border border-white/10 rounded-xl p-4 hover:border-white/20 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className={cn('p-2 rounded-lg', config.bg)}>
                      <Icon className={cn('w-4 h-4', config.color)} />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-white/80">{entry.workflowName}</h3>
                      <p className="text-xs text-white/40 mt-0.5">{formatDate(entry.completedAt)}</p>
                      <div className="flex items-center gap-3 mt-1">
                        {entry.duration && (
                          <span className="text-xs text-white/30 font-mono">{formatDuration(entry.duration)}</span>
                        )}
                        {entry.errorCount > 0 && (
                          <span className="text-xs text-red-400">{entry.errorCount} errors</span>
                        )}
                        <span className={cn('text-xs px-2 py-0.5 rounded-full', config.bg, config.color)}>
                          {entry.status}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => deleteEntry(entry.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            )
          })
        )}
      </div>
    </div>
  )
}
