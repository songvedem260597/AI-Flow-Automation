import React from 'react'
import { Bookmark, Check, Edit3, Search, Trash2, X } from 'lucide-react'
import { usePromptStore } from '@/stores/dataStore'
import { cn } from '@/lib/utils'

export const PromptsPanel: React.FC = () => {
  const prompts = usePromptStore((s) => s.prompts)
  const updatePrompt = usePromptStore((s) => s.updatePrompt)
  const deletePrompt = usePromptStore((s) => s.deletePrompt)
  const [search, setSearch] = React.useState('')
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState({ name: '', content: '' })

  const filtered = prompts.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.content.toLowerCase().includes(search.toLowerCase())
  )

  const startEdit = (prompt: (typeof prompts)[number]) => {
    setEditingId(prompt.id)
    setDraft({ name: prompt.name, content: prompt.content })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft({ name: '', content: '' })
  }

  const saveEdit = (id: string) => {
    const name = draft.name.trim()
    const content = draft.content.trim()
    if (!name || !content) return
    updatePrompt(id, { name, content })
    cancelEdit()
  }

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
                className={cn(
                  'group bg-[#1A1A1A] rounded-xl border border-white/5 transition-colors',
                  editingId === prompt.id ? 'border-[#7C5CFF]/45' : 'hover:border-white/10'
                )}
              >
                {editingId === prompt.id ? (
                  <div className="space-y-2 p-3">
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                      className="h-8 w-full rounded-lg border border-white/[0.08] bg-[#111111] px-2.5 text-xs text-white/75 outline-none focus:border-[#7C5CFF]/60"
                      placeholder="Prompt name"
                    />
                    <textarea
                      value={draft.content}
                      onChange={(e) => setDraft((prev) => ({ ...prev, content: e.target.value }))}
                      className="min-h-[90px] w-full resize-none rounded-lg border border-white/[0.08] bg-[#111111] px-2.5 py-2 text-xs text-white/70 outline-none focus:border-[#7C5CFF]/60"
                      placeholder="Prompt content"
                    />
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white"
                        title="Cancel"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdit(prompt.id)}
                        disabled={!draft.name.trim() || !draft.content.trim()}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-[#9B82FF] transition-colors hover:bg-[#7C5CFF]/10 disabled:cursor-not-allowed disabled:text-white/20"
                        title="Save"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-xs font-medium text-white/75">{prompt.name}</p>
                        <span className="shrink-0 rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/25">
                          {prompt.provider}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-white/30">{prompt.content}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => startEdit(prompt)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white"
                        title="Edit prompt"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deletePrompt(prompt.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
                        title="Delete prompt"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
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
