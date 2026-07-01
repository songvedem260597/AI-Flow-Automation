import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { usePresetStore } from '@/stores/dataStore'
import { useWorkflowStore } from '@/stores/workflowStore'
import { cn } from '@/lib/utils'
import { Plus, Bookmark, Play, Trash2, FolderOpen } from 'lucide-react'
import { runPipeline } from '@/pipeline'
import type { Workflow, WorkflowNode, WorkflowEdge, FlowNodeType } from '@/types'

interface PresetTemplateData {
  id: string
  name: string
  description: string
  category: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  isCustom?: boolean
}

const PRESET_TEMPLATES: PresetTemplateData[] = [
  {
    id: 'image-gen',
    name: 'Quick Image Generation',
    description: 'Generate images with aspect ratio selection',
    category: 'Image',
    nodes: [
      { id: 'p1', type: 'prompt' as FlowNodeType, position: { x: 100, y: 100 }, data: { label: 'Image Prompt', prompt: '', provider: 'chatgpt' as const } },
      { id: 'g1', type: 'generate' as FlowNodeType, position: { x: 350, y: 100 }, data: { label: 'Generate', provider: 'chatgpt' as const, autoGenerate: true } },
      { id: 'd1', type: 'download' as FlowNodeType, position: { x: 600, y: 100 }, data: { label: 'Download', format: 'png' as const } }
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'g1' },
      { id: 'e2', source: 'g1', target: 'd1' }
    ]
  },
  {
    id: 'batch-prompt',
    name: 'Batch Prompt Runner',
    description: 'Run multiple prompts sequentially',
    category: 'Text',
    nodes: [
      { id: 'p1', type: 'prompt' as FlowNodeType, position: { x: 100, y: 100 }, data: { label: 'Prompt 1', prompt: '', provider: 'chatgpt' as const } },
      { id: 'g1', type: 'generate' as FlowNodeType, position: { x: 350, y: 100 }, data: { label: 'Generate', provider: 'chatgpt' as const } },
      { id: 'w1', type: 'wait' as FlowNodeType, position: { x: 600, y: 100 }, data: { label: 'Wait', condition: 'dom-change' as const } }
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'g1' },
      { id: 'e2', source: 'g1', target: 'w1' }
    ]
  }
]

export const PresetsPanel: React.FC = () => {
  const presets = usePresetStore((s) => s.presets)
  const deletePreset = usePresetStore((s) => s.deletePreset)
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow)
  const importWorkflow = useWorkflowStore((s) => s.importWorkflow)

  const [selectedCategory, setSelectedCategory] = useState<string>('all')

  const categories = ['all', 'Image', 'Text', 'Custom']
  const allPresets: PresetTemplateData[] = [
    ...PRESET_TEMPLATES,
    ...presets.map((p) => ({ ...p, id: `custom-${p.id}`, isCustom: true }))
  ]

  const filtered = selectedCategory === 'all' ? allPresets : allPresets.filter((p) => p.category === selectedCategory)

  const handleUsePreset = (preset: PresetTemplateData) => {
    const workflow = createWorkflow(preset.name)
    importWorkflow({
      ...workflow,
      nodes: preset.nodes,
      edges: preset.edges,
      id: workflow.id
    })
  }

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div>
        <h2 className="text-sm font-semibold text-white/80">Preset Templates</h2>
        <p className="text-xs text-white/30 mt-0.5">Start fast with pre-built workflows</p>
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={cn(
              'px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all',
              selectedCategory === cat ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-white/40 hover:text-white/60'
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {filtered.map((preset) => (
          <motion.div
            key={preset.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/5 border border-white/10 rounded-xl p-4 hover:border-white/20 transition-colors group"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500/20 to-pink-500/20">
                  <FolderOpen className="w-4 h-4 text-violet-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-white/80">{preset.name}</h3>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/40">{preset.category}</span>
                  </div>
                  <p className="text-xs text-white/40 mt-1">{preset.description}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-white/25">{preset.nodes.length} nodes</span>
                    <span className="text-xs text-white/25">{preset.edges.length} connections</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {'isCustom' in preset && preset.isCustom && (
                  <button
                    onClick={() => deletePreset(preset.id.replace('custom-', ''))}
                    className="p-1.5 rounded hover:bg-red-500/10 text-white/20 hover:text-red-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => handleUsePreset(preset)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg text-xs font-medium hover:bg-emerald-500/30 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  Use
                </button>
              </div>
            </div>
          </motion.div>
        ))}

        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-white/20">
            <Bookmark className="w-8 h-8 mb-2" />
            <p className="text-sm">No presets in this category</p>
          </div>
        )}
      </div>
    </div>
  )
}
