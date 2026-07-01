import React from 'react'
import { Bookmark, Plus, Search } from 'lucide-react'
import { usePromptStore } from '@/stores/dataStore'
import { cn } from '@/lib/utils'

export const PromptsPanel: React.FC = () => {
  const prompts = usePromptStore((s) => s.prompts)
  const [search, setSearch] = React.useState('')

  const filtered = prompts.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.content.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      <div className="px-4 py-3 border-b border-white/5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts..."
            className="w-full pl-8 pr-3 py-2 bg-[#1A1A1A] rounded-xl text-xs text-white/70 placeholder:text-white/25 outline-none focus:ring-1 focus:ring-white/10 border border-white/5"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-white/20">
            <Bookmark className="w-8 h-8 mb-2" />
            <p className="text-xs">No prompts yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((prompt) => (
              <div
                key={prompt.id}
                className="p-3 bg-[#1A1A1A] rounded-xl border border-white/5 hover:border-white/10 transition-colors cursor-pointer"
              >
                <p className="text-xs font-medium text-white/70 truncate">{prompt.name}</p>
                <p className="text-[10px] text-white/30 mt-1 line-clamp-2">{prompt.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
