import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePromptStore } from '@/stores/dataStore'
import { cn } from '@/lib/utils'
import { PROVIDER_LABELS } from '@/constants'
import { Plus, Search, Trash2, Edit3, Clock, MessageSquare, X } from 'lucide-react'
import type { SavedPrompt, AIProvider } from '@/types'

export const PromptManager: React.FC = () => {
  const prompts = usePromptStore((s) => s.prompts)
  const addPrompt = usePromptStore((s) => s.addPrompt)
  const deletePrompt = usePromptStore((s) => s.deletePrompt)
  const updatePrompt = usePromptStore((s) => s.updatePrompt)

  const [search, setSearch] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<AIProvider | 'all'>('all')
  const [isCreating, setIsCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', content: '', provider: 'chatgpt' as AIProvider })

  const filtered = prompts.filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || p.content.toLowerCase().includes(search.toLowerCase())
    const matchesProvider = selectedProvider === 'all' || p.provider === selectedProvider
    return matchesSearch && matchesProvider
  })

  const handleCreate = () => {
    if (!form.name.trim() || !form.content.trim()) return
    addPrompt(form)
    setForm({ name: '', content: '', provider: 'chatgpt' })
    setIsCreating(false)
  }

  const handleEdit = (prompt: SavedPrompt) => {
    setEditingId(prompt.id)
    setForm({ name: prompt.name, content: prompt.content, provider: prompt.provider })
  }

  const handleSaveEdit = () => {
    if (!editingId) return
    updatePrompt(editingId, form)
    setEditingId(null)
    setForm({ name: '', content: '', provider: 'chatgpt' })
  }

  const providers: (AIProvider | 'all')[] = ['all', 'chatgpt', 'google-flow', 'grok', 'claude', 'gemini']

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts..."
            className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-white/80 outline-none focus:border-violet-500/50 transition-colors"
          />
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 px-4 py-2 bg-violet-500/20 text-violet-400 rounded-xl text-sm font-medium hover:bg-violet-500/30 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New
        </button>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => setSelectedProvider(p)}
            className={cn(
              'px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all',
              selectedProvider === p ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-white/40 hover:text-white/60'
            )}
          >
            {p === 'all' ? 'All' : PROVIDER_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        <AnimatePresence>
          {isCreating && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white/70">New Prompt</span>
                <button onClick={() => setIsCreating(false)} className="p-1 hover:bg-white/10 rounded">
                  <X className="w-4 h-4 text-white/40" />
                </button>
              </div>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Prompt name..."
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm outline-none focus:border-violet-500/50"
              />
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="Prompt content..."
                rows={4}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm outline-none resize-none focus:border-violet-500/50"
              />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setIsCreating(false)} className="px-3 py-1.5 text-xs text-white/40 hover:text-white/60">Cancel</button>
                <button onClick={handleCreate} className="px-3 py-1.5 bg-violet-500 text-white rounded-lg text-xs font-medium">Create</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {filtered.length === 0 && !isCreating && (
          <div className="flex flex-col items-center justify-center h-40 text-white/30">
            <MessageSquare className="w-8 h-8 mb-2" />
            <p className="text-sm">No prompts found</p>
          </div>
        )}

        {filtered.map((prompt) => (
          <motion.div
            key={prompt.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              'bg-white/5 border rounded-xl p-4 transition-colors',
              editingId === prompt.id ? 'border-violet-500/50' : 'border-white/10 hover:border-white/20'
            )}
          >
            {editingId === prompt.id ? (
              <div className="space-y-3">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm outline-none" />
                <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={4} className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm outline-none resize-none" />
                <div className="flex items-center justify-end gap-2">
                  <button onClick={() => setEditingId(null)} className="px-3 py-1.5 text-xs text-white/40">Cancel</button>
                  <button onClick={handleSaveEdit} className="px-3 py-1.5 bg-violet-500 text-white rounded-lg text-xs font-medium">Save</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-white/80">{prompt.name}</h3>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/40">{PROVIDER_LABELS[prompt.provider]}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => handleEdit(prompt)} className="p-1.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70">
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => deletePrompt(prompt.id)} className="p-1.5 rounded hover:bg-red-500/10 text-white/40 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-white/40 line-clamp-2">{prompt.content}</p>
                <div className="flex items-center gap-1 mt-2 text-white/20">
                  <Clock className="w-3 h-3" />
                  <span className="text-[10px]">{new Date(prompt.createdAt).toLocaleDateString()}</span>
                  {prompt.usageCount !== undefined && prompt.usageCount > 0 && (
                    <span className="text-[10px] ml-2">Used {prompt.usageCount} times</span>
                  )}
                </div>
              </>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  )
}
