import React from 'react'
import { History } from 'lucide-react'
import { useHistoryStore } from '@/stores/dataStore'
import { cn } from '@/lib/utils'

export const HistoryPanel: React.FC = () => {
  const entries = useHistoryStore((s) => s.entries)

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      <div className="px-4 py-3 border-b border-white/5">
        <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">History</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-white/20">
            <History className="w-8 h-8 mb-2" />
            <p className="text-xs">No history yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="p-3 bg-[#1A1A1A] rounded-xl border border-white/5 hover:border-white/10 transition-colors cursor-pointer"
              >
                <p className="text-xs text-white/60 truncate">{entry.prompt}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] text-white/20">
                    {new Date(entry.completedAt).toLocaleString()}
                  </span>
                  <span className={cn(
                    'text-[10px] font-medium',
                    entry.status === 'success' && 'text-emerald-400',
                    entry.status === 'failed' && 'text-red-400'
                  )}>
                    {entry.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
