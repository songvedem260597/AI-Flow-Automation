import React, { useState, useRef, useEffect } from 'react'
import { Bell, Settings } from 'lucide-react'

interface FlowProject {
  id: string
  name: string
  href?: string
  thumbnailMediaKey?: string
  creationTime?: string
  date?: string
  index?: number
}

interface TopNavigationProps {
  activeTab: string
  onTabChange: (tab: string) => void
  flowProjects: FlowProject[]
  selectedProject: FlowProject | null
  isLoadingProjects: boolean
  onSelectFlowProject: (project: FlowProject) => void
  onReloadFlowProjects: () => void
}

const tabs = [
  { id: 'gen', label: 'Gen' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
]

export const TopNavigation: React.FC<TopNavigationProps> = ({
  activeTab,
  onTabChange,
  flowProjects,
  selectedProject,
  isLoadingProjects,
  onSelectFlowProject,
  onReloadFlowProjects,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#7C5CFF] to-[#A78BFA] flex items-center justify-center flex-shrink-0">
          <span className="text-xs font-bold text-white">AF</span>
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-white">AI Flow</h1>
          <p className="text-[10px] text-white/30">Free Plan</p>
        </div>
        <div className="flex items-center gap-1">
          <button className="p-2 rounded-xl text-white/40 hover:text-white hover:bg-white/5 transition-colors">
            <Bell className="w-4 h-4" />
          </button>
          <button className="p-2 rounded-xl text-white/40 hover:text-white hover:bg-white/5 transition-colors">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Project / Session selector */}
      <div className="px-4 py-2 border-b border-white/5" ref={dropdownRef}>
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-[#1A1A1A] rounded-xl text-left hover:bg-white/5 transition-colors"
          >
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-emerald-500/30 to-teal-500/30 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
              <span className="text-[8px] font-bold text-emerald-400">P</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">
                {selectedProject?.name || 'No project selected'}
              </p>
              <p className="text-[10px] text-white/30 truncate">
                {selectedProject ? 'Flow Project' : 'Select a Flow project'}
              </p>
            </div>
            <svg className="w-3 h-3 text-white/30 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-[#1A1A1A] rounded-xl border border-white/10 shadow-2xl z-50 overflow-hidden">
              <div className="max-h-64 overflow-y-auto py-1">
              {isLoadingProjects ? (
                <div className="px-3 py-4 text-center text-[11px] text-white/30">
                  Loading projects...
                </div>
              ) : flowProjects.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-white/30">
                  No projects loaded
                </div>
              ) : (
                flowProjects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => { onSelectFlowProject(project); setDropdownOpen(false) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-white/60 hover:bg-white/5 hover:text-white transition-colors"
                  >
                    <div className="w-4 h-4 rounded bg-white/5 flex items-center justify-center flex-shrink-0">
                      <span className="text-[7px] font-bold text-white/40">P</span>
                    </div>
                    <span className="flex-1 truncate">{project.name}</span>
                  </button>
                ))
              )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-white/5 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`
              px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex-shrink-0
              ${activeTab === tab.id
                ? 'bg-[#7C5CFF]/20 text-[#7C5CFF]'
                : 'text-white/40 hover:text-white/70 hover:bg-white/5'
              }
            `}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}
