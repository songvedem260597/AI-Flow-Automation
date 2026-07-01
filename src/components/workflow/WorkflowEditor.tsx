import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type NodeChange,
  type EdgeChange,
  BackgroundVariant,
  Panel,
  useReactFlow
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useWorkflowStore } from '@/stores/workflowStore'
import { PromptNode, ImageNode, GenerateNode, DelayNode, DownloadNode, WaitNode } from './nodes'
import { cn } from '@/lib/utils'
import type { FlowNodeType, Workflow } from '@/types'
import {
  FileText, Image, Zap, Clock, Download, Pause,
  Play, Square, ChevronDown, PanelLeftClose, PanelLeft,
  Workflow as WorkflowIcon, List, ZoomIn, ZoomOut, Maximize2
} from 'lucide-react'
import { runPipeline, stopPipeline, pausePipeline, resumePipeline } from '@/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'

const nodeTypes = {
  prompt: PromptNode,
  image: ImageNode,
  generate: GenerateNode,
  delay: DelayNode,
  download: DownloadNode,
  wait: WaitNode
}

const NODE_CATEGORIES = [
  {
    label: 'INPUT',
    color: 'text-sky-400',
    bgColor: 'bg-sky-500/10',
    borderColor: 'border-l-sky-500',
    nodes: [
      { type: 'prompt' as FlowNodeType, label: 'Prompt', icon: <FileText className="w-4 h-4" />, color: 'sky' }
    ]
  },
  {
    label: 'ACTION',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-l-emerald-500',
    nodes: [
      { type: 'generate' as FlowNodeType, label: 'Generate', icon: <Zap className="w-4 h-4" />, color: 'emerald' },
      { type: 'download' as FlowNodeType, label: 'Download', icon: <Download className="w-4 h-4" />, color: 'emerald' }
    ]
  },
  {
    label: 'UTILITY',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-l-amber-500',
    nodes: [
      { type: 'delay' as FlowNodeType, label: 'Delay', icon: <Clock className="w-4 h-4" />, color: 'amber' },
      { type: 'wait' as FlowNodeType, label: 'Wait', icon: <Pause className="w-4 h-4" />, color: 'amber' },
      { type: 'image' as FlowNodeType, label: 'Image', icon: <Image className="w-4 h-4" />, color: 'amber' }
    ]
  }
]

const NODE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  sky: { bg: 'bg-sky-500/10', border: 'border-l-sky-500', text: 'text-sky-400' },
  violet: { bg: 'bg-violet-500/10', border: 'border-l-violet-500', text: 'text-violet-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-l-emerald-500', text: 'text-emerald-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-l-amber-500', text: 'text-amber-400' },
  pink: { bg: 'bg-pink-500/10', border: 'border-l-pink-500', text: 'text-pink-400' }
}

interface WorkflowEditorProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
}

interface WorkflowCanvasProps {
  workflow: Workflow
  isSidebarOpen: boolean
  onToggleSidebar: () => void
}

const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({ workflow, isSidebarOpen, onToggleSidebar }) => {
  const updateNodePosition = useWorkflowStore((s) => s.updateNodePosition)
  const addNode = useWorkflowStore((s) => s.addNode)
  const addEdgeToStore = useWorkflowStore((s) => s.addEdge)
  const deleteNode = useWorkflowStore((s) => s.deleteNode)
  const setSelectedNode = useWorkflowStore((s) => s.setSelectedNode)
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId)
  const isRunning = usePipelineStore((s) => s.isRunning)
  const isPaused = usePipelineStore((s) => s.isPaused)
  const activeTaskId = usePipelineStore((s) => s.activeTaskId)
  const tasks = usePipelineStore((s) => s.tasks)
  const logs = usePipelineStore((s) => s.logs)

  const [isPaletteOpen, setIsPaletteOpen] = useState(true)
  const [expandedCategories, setExpandedCategories] = useState<string[]>(['INPUT', 'ACTION', 'UTILITY'])
  const [showLogs, setShowLogs] = useState(false)
  const { fitView, zoomIn, zoomOut } = useReactFlow()

  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const activeTask = tasks.find((t) => t.id === activeTaskId)
  const taskLogs = logs.filter((l) => l.pipelineId === activeTaskId).slice(0, 20)

  const initialNodes = useMemo(() => {
    return workflow.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data
    }))
  }, [workflow.id])

  const initialEdges = useMemo(() => {
    return workflow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: true,
      style: { stroke: '#7C5CFF', strokeWidth: 2 },
      type: 'smoothstep'
    }))
  }, [workflow.id])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  const onConnect = useCallback(
    (params: Connection) => {
      const newEdge = { ...params, type: 'smoothstep', animated: true }
      setEdges((eds) => addEdge(newEdge, eds))
      if (params.source && params.target) {
        addEdgeToStore({ source: params.source, target: params.target })
      }
    },
    [setEdges, addEdgeToStore]
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          updateNodePosition(change.id, change.position)
        }
        if (change.type === 'remove') {
          deleteNode(change.id)
          setNodes((nds) => nds.filter((n) => n.id !== change.id))
          setEdges((eds) => eds.filter((e) => e.source !== change.id && e.target !== change.id))
        }
      }
    },
    [onNodesChange, updateNodePosition, deleteNode, setNodes, setEdges]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes)
      for (const change of changes) {
        if (change.type === 'remove') {
          useWorkflowStore.getState().deleteEdge(change.id)
        }
      }
    },
    [onEdgesChange]
  )

  const handleAddNode = useCallback(
    (type: FlowNodeType, color: string) => {
      const centerX = 300 + Math.random() * 200
      const centerY = 200 + Math.random() * 200
      const node = addNode(type, { x: centerX, y: centerY })
      if (node) {
        setNodes((nds) => [
          ...nds,
          { id: node.id, type: node.type, position: node.position, data: { ...node.data, _nodeColor: color } }
        ])
      }
    },
    [addNode, setNodes]
  )

  const handleRun = useCallback(async () => {
    if (isRunning) {
      if (isPaused) {
        resumePipeline()
      } else {
        pausePipeline()
      }
      return
    }

    await runPipeline(workflow)
  }, [workflow, isRunning, isPaused])

  const handleStop = useCallback(() => {
    stopPipeline()
  }, [])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      setSelectedNode(node.id)
    },
    [setSelectedNode]
  )

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [setSelectedNode])

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  return (
    <div ref={reactFlowWrapper} className="w-full h-full relative bg-[#0F0F0F]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        fitView
        snapToGrid
        snapGrid={[20, 20]}
        deleteKeyCode="Delete"
        className="bg-[#0F0F0F]"
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: true,
          style: { stroke: '#7C5CFF', strokeWidth: 2 }
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#2A2A2A"
        />

        {/* Top Bar */}
        <Panel position="top-left" className="!m-0">
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleSidebar}
              className="flex items-center justify-center w-9 h-9 rounded-xl bg-[#1A1A1A] hover:bg-[#252525] text-white/60 hover:text-white transition-colors"
            >
              {isSidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setIsPaletteOpen(!isPaletteOpen)}
              className={cn(
                'flex items-center gap-2 px-3 h-9 rounded-xl text-sm font-medium transition-colors',
                isPaletteOpen ? 'bg-[#7C5CFF] text-white' : 'bg-[#1A1A1A] text-white/60 hover:text-white hover:bg-[#252525]'
              )}
            >
              <WorkflowIcon className="w-4 h-4" />
              Blocks
            </button>
          </div>
        </Panel>

        {/* Node Palette */}
        {isPaletteOpen && (
          <Panel position="top-left" className="!m-0 ml-[116px] mt-[52px]">
            <div className="w-60 bg-[#1A1A1A] rounded-2xl border border-white/5 shadow-2xl overflow-hidden">
              {NODE_CATEGORIES.map((category) => (
                <div key={category.label}>
                  <button
                    onClick={() => toggleCategory(category.label)}
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-white/5 transition-colors"
                  >
                    <span className={cn('text-[10px] font-semibold tracking-widest uppercase', category.color)}>
                      {category.label}
                    </span>
                    <ChevronDown
                      className={cn(
                        'w-3 h-3 text-white/30 transition-transform',
                        expandedCategories.includes(category.label) && 'rotate-180'
                      )}
                    />
                  </button>
                  {expandedCategories.includes(category.label) && (
                    <div className="px-2 pb-2 space-y-1">
                      {category.nodes.map((node) => (
                        <button
                          key={node.type}
                          onClick={() => handleAddNode(node.type, node.color)}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-white/70',
                            'hover:bg-white/5 transition-colors border-l-2',
                            NODE_COLORS[node.color]?.border,
                            NODE_COLORS[node.color]?.bg
                          )}
                        >
                          <span className={NODE_COLORS[node.color]?.text}>{node.icon}</span>
                          {node.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}

        {/* Top Right Controls */}
        <Panel position="top-right" className="!m-0">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-[#1A1A1A] rounded-xl p-1.5">
              <button
                onClick={() => zoomOut()}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => fitView()}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-colors"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => zoomIn()}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-colors"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-1.5 bg-[#1A1A1A] rounded-xl p-1.5">
              <button
                onClick={handleRun}
                disabled={nodes.length === 0}
                className={cn(
                  'flex items-center gap-1.5 px-4 h-9 rounded-lg text-xs font-medium transition-all',
                  isRunning && !isPaused
                    ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30',
                  nodes.length === 0 && 'opacity-40 cursor-not-allowed',
                  isPaused && 'bg-sky-500/20 text-sky-400 hover:bg-sky-500/30'
                )}
              >
                {isRunning && !isPaused ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {isRunning ? (isPaused ? 'Resume' : 'Pause') : 'Run'}
              </button>
              {isRunning && (
                <button
                  onClick={handleStop}
                  className="flex items-center justify-center w-9 h-9 rounded-lg text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <button
              onClick={() => setShowLogs(!showLogs)}
              className={cn(
                'flex items-center justify-center w-10 h-10 rounded-xl transition-colors',
                showLogs ? 'bg-[#7C5CFF] text-white' : 'bg-[#1A1A1A] text-white/50 hover:text-white'
              )}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </Panel>

        {/* Logs Panel */}
        {showLogs && (
          <Panel position="bottom-left" className="!m-0">
            <div className="w-80 max-h-64 bg-[#1A1A1A] rounded-2xl border border-white/5 shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
                <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Console</span>
                <span className="text-[10px] text-white/20">{taskLogs.length} entries</span>
              </div>
              <div className="max-h-48 overflow-y-auto p-2 space-y-0.5">
                {taskLogs.length === 0 ? (
                  <p className="text-xs text-white/20 text-center py-4">No logs yet</p>
                ) : (
                  taskLogs.map((log) => (
                    <div key={log.id} className="flex items-start gap-2 px-2 py-1 rounded-lg hover:bg-white/5">
                      <span className={cn(
                        'text-[10px] font-mono mt-0.5 w-10',
                        log.level === 'success' && 'text-emerald-400',
                        log.level === 'error' && 'text-red-400',
                        log.level === 'warn' && 'text-amber-400',
                        log.level === 'info' && 'text-white/30'
                      )}>
                        {log.level.toUpperCase()}
                      </span>
                      <span className="text-xs text-white/50 truncate flex-1">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Panel>
        )}

        {/* MiniMap */}
        <div className="!absolute bottom-4 right-4">
          <MiniMap
            nodeColor={(n) => {
              const colorMap: Record<string, string> = {
                prompt: '#38bdf8',
                image: '#fbbf24',
                generate: '#34d399',
                delay: '#fbbf24',
                download: '#34d399',
                wait: '#fbbf24'
              }
              return colorMap[n.type || ''] || '#7C5CFF'
            }}
            maskColor="rgba(0,0,0,0.6)"
            style={{
              backgroundColor: '#1A1A1A',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.05)'
            }}
          />
        </div>
      </ReactFlow>

    </div>
  )
}

export const WorkflowEditor: React.FC<WorkflowEditorProps> = ({ isSidebarOpen, onToggleSidebar }) => {
  const workflows = useWorkflowStore((s) => s.workflows)
  const activeWorkflowId = useWorkflowStore((s) => s.activeWorkflowId)
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow)
  const setActiveWorkflow = useWorkflowStore((s) => s.setActiveWorkflow)

  useEffect(() => {
    if (workflows.length === 0) {
      const wf = createWorkflow('My First Flow')
      setActiveWorkflow(wf.id)
    }
  }, [])

  const workflow = workflows.find((w) => w.id === activeWorkflowId) || workflows[0] || null

  if (!workflow) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0F0F0F]">
        <div className="w-8 h-8 border-2 border-[#7C5CFF] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <WorkflowCanvas
      workflow={workflow}
      isSidebarOpen={isSidebarOpen}
      onToggleSidebar={onToggleSidebar}
    />
  )
}
