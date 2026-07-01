import React, { useState, useEffect, useRef, useCallback } from 'react'
import { TopNavigation } from '@/components/layout/TopNavigation'
import { GenPanel } from '@/components/gen/GenPanel'
import { WorkflowEditor } from '@/components/workflow/WorkflowEditor'
import { PromptsPanel } from '@/components/layout/PromptsPanel'
import { TasksPanel } from '@/components/layout/TasksPanel'
import { HistoryPanel } from '@/components/layout/HistoryPanel'
import { SettingsPanel } from '@/components/layout/SettingsPanel'

interface SidePanelProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
}

function isFlowHomeUrl(url?: string) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!u.hostname.includes('labs.google')) return false

    return (
      /^\/fx\/tools\/flow\/?$/.test(u.pathname) ||
      /^\/fx\/[a-z]{2}\/tools\/flow\/?$/.test(u.pathname)
    )
  } catch {
    return false
  }
}

function isFlowProjectUrl(url?: string) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (!u.hostname.includes('labs.google')) return false

    return /^\/fx\/([a-z]{2}\/)?tools\/flow\/project\/[^/]+/.test(u.pathname)
  } catch {
    return false
  }
}

function isAnyFlowUrl(url?: string) {
  return isFlowHomeUrl(url) || isFlowProjectUrl(url)
}

interface CheckResult {
  hasFlow: boolean
  activeUrl: string
  flowTabId?: number
  error?: string
}

interface FlowProject {
  id: string
  name: string
  href?: string
  thumbnailMediaKey?: string
  creationTime?: string
  date?: string
  index?: number
}

async function checkAllTabs(): Promise<CheckResult> {
  try {
    const allTabs = await chrome.tabs.query({})
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = activeTabs[0]
    const flowTab = allTabs.find(t => isAnyFlowUrl(t.url))

    return {
      hasFlow: Boolean(flowTab),
      activeUrl: activeTab?.url || '',
      flowTabId: flowTab?.id
    }
  } catch (err) {
    return {
      hasFlow: false,
      activeUrl: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function readFlowProjectsFromActiveTab(): Promise<FlowProject[]> {
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = activeTabs[0]

    if (!activeTab?.id || !isFlowHomeUrl(activeTab.url)) return []

    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: async () => {
        const input = encodeURIComponent(JSON.stringify({
          json: {
            pageSize: 20,
            toolName: "PINHOLE",
            cursor: null
          },
          meta: {
            values: {
              cursor: ["undefined"]
            }
          }
        }))

        const url = `/fx/api/trpc/project.searchUserProjects?input=${input}`

        const res = await fetch(url, {
          method: "GET",
          credentials: "include"
        })

        const data = await res.json()
        const projects = data?.result?.data?.json?.result?.projects || []

        return projects.map((p: any, index: number) => ({
          id: p.projectId,
          name: p.projectInfo?.projectTitle || `Project ${index + 1}`,
          href: `/fx/vi/tools/flow/project/${p.projectId}`,
          thumbnailMediaKey: p.projectInfo?.thumbnailMediaKey,
          creationTime: p.creationTime,
          date: p.creationTime,
          index
        })).filter((p: any) => p.id && p.name)
      }
    })

    return results?.[0]?.result || []
  } catch {
    return []
  }
}

async function clickFlowProject(project: FlowProject) {
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = activeTabs[0]

    if (!activeTab?.id || !isFlowHomeUrl(activeTab.url)) return

    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      args: [project],
      func: (p: FlowProject) => {
        if (p.href) {
          window.location.href = p.href
        } else {
          window.location.href = `/fx/vi/tools/flow/project/${p.id}`
        }
      }
    })
  } catch {}
}

export const SidePanel: React.FC<SidePanelProps> = ({ isSidebarOpen, onToggleSidebar }) => {
  const [activeTab, setActiveTab] = useState<string>('gen')
  const [hasFlowTab, setHasFlowTab] = useState<boolean>(false)
  const [showFlowOverlay, setShowFlowOverlay] = useState<boolean>(false)
  const [currentUrl, setCurrentUrl] = useState<string>('')
  const [activeGenProvider, setActiveGenProvider] = useState<string>('flow')
  const [initDone, setInitDone] = useState<boolean>(false)
  const [flowProjects, setFlowProjects] = useState<FlowProject[]>([])
  const [selectedProject, setSelectedProject] = useState<FlowProject | null>(null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState<boolean>(false)
  const [projectSearch, setProjectSearch] = useState<string>('')
  const [syncDone, setSyncDone] = useState<boolean>(false)
  const providerRef = useRef(activeGenProvider)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    providerRef.current = activeGenProvider
  }, [activeGenProvider])

  const runCheck = useCallback(async () => {
    if (providerRef.current !== 'flow') return

    const result = await checkAllTabs()
    if (providerRef.current !== 'flow') return

    setCurrentUrl(result.activeUrl || result.error || 'NO ACTIVE URL')

    if (result.error) {
      setHasFlowTab(false)
      setShowFlowOverlay(true)
      setShowProjectPicker(false)
      return
    }

    if (result.hasFlow || isAnyFlowUrl(result.activeUrl)) {
      setHasFlowTab(true)
      setShowFlowOverlay(false)
    } else {
      setHasFlowTab(false)
      setShowFlowOverlay(true)
      setShowProjectPicker(false)
    }
  }, [])

  useEffect(() => {
    if (activeGenProvider !== 'flow') {
      setShowFlowOverlay(false)
      setShowProjectPicker(false)
      setInitDone(true)
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    let cancelled = false

    const doCheck = async () => {
      const result = await checkAllTabs()
      if (cancelled || providerRef.current !== 'flow') return

      setCurrentUrl(result.activeUrl || result.error || 'NO ACTIVE URL')
      setInitDone(true)

      if (result.error) {
        setHasFlowTab(false)
        setShowFlowOverlay(true)
        setShowProjectPicker(false)
        return
      }

      if (result.hasFlow || isAnyFlowUrl(result.activeUrl)) {
        setHasFlowTab(true)
        setShowFlowOverlay(false)
      } else {
        setHasFlowTab(false)
        setShowFlowOverlay(true)
        setShowProjectPicker(false)
      }
    }

    doCheck()
    intervalRef.current = setInterval(doCheck, 3000)

    return () => {
      cancelled = true
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [activeGenProvider])

  useEffect(() => {
    if (!initDone) return
    if (activeGenProvider !== 'flow') return
    if (showFlowOverlay) return

    if (!isFlowHomeUrl(currentUrl)) {
      setShowProjectPicker(false)
      setSyncDone(false)
      return
    }

    loadFlowProjects().then(() => {
      setShowProjectPicker(true)
      setSyncDone(true)
    })
  }, [activeGenProvider, currentUrl, showFlowOverlay, initDone])

  const handleResync = async () => {
    setSyncDone(false)
    await runCheck()
    if (isFlowProjectUrl(currentUrl)) {
      setSyncDone(true)
      return
    }
    if (isFlowHomeUrl(currentUrl)) {
      const projects = await readFlowProjectsFromActiveTab()
      setFlowProjects(projects)
      setShowProjectPicker(projects.length > 0)
      setSyncDone(true)
    } else {
      setShowProjectPicker(false)
      setSyncDone(true)
    }
  }

  const loadFlowProjects = async () => {
    setIsLoadingProjects(true)
    try {
      const projects = await readFlowProjectsFromActiveTab()
      setFlowProjects(projects)
    } catch {
      setFlowProjects([])
    } finally {
      setIsLoadingProjects(false)
    }
  }

  const handleSelectFlowProject = async (project: FlowProject) => {
    setSelectedProject(project)
    await clickFlowProject(project)
    setShowProjectPicker(false)
  }

  const filteredProjects = flowProjects.filter(p =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase())
  )

  if (!initDone) {
    return (
      <div className="flex h-screen w-full overflow-hidden bg-[#0A0A0A]">
        <TopNavigation
          activeTab={activeTab}
          onTabChange={setActiveTab}
          flowProjects={flowProjects}
          selectedProject={selectedProject}
          isLoadingProjects={isLoadingProjects}
          onSelectFlowProject={handleSelectFlowProject}
          onReloadFlowProjects={loadFlowProjects}
        />
        <main className="flex-1 flex flex-col h-full overflow-hidden border-l border-white/5">
          <div className="flex items-center justify-center h-full text-white/30 text-sm">
            Loading...
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#0A0A0A]">
      <TopNavigation
        activeTab={activeTab}
        onTabChange={setActiveTab}
        flowProjects={flowProjects}
        selectedProject={selectedProject}
        isLoadingProjects={isLoadingProjects}
        onSelectFlowProject={handleSelectFlowProject}
        onReloadFlowProjects={loadFlowProjects}
      />
      <main className="flex-1 flex flex-col h-full overflow-hidden border-l border-white/5">
        {activeTab === 'gen' && (
          <div className="relative h-full">
            {showFlowOverlay && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div
                  className="bg-[#1A1A1A] rounded-2xl border border-white/10 px-8 py-6 flex flex-col items-center text-center shadow-2xl max-w-xs w-full"
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#7C5CFF" strokeWidth="1.5" style={{ opacity: 0.6 }}>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  <p style={{ margin: '12px 0 4px', fontWeight: 600, color: 'rgba(255,255,255,0.9)', fontSize: '14px' }}>
                    Google Flow tab not open
                  </p>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '16px' }}>
                    Please open a Google Flow tab to use this extension
                  </p>
                  <button
                    onClick={async () => {
                      const result = await checkAllTabs()
                      if (result.hasFlow && result.flowTabId) {
                        await chrome.tabs.update(result.flowTabId, { active: true }).catch(() => {})
                        setHasFlowTab(true)
                        setShowFlowOverlay(false)
                        setActiveGenProvider('flow')
                      } else {
                        await chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow', active: true }).catch(() => {})
                        setHasFlowTab(true)
                        setShowFlowOverlay(false)
                        setActiveGenProvider('flow')
                      }
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-[#7C5CFF] hover:bg-[#6B4CE0] text-white text-sm font-medium rounded-xl transition-colors cursor-pointer w-full justify-center"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    Open Google Flow
                  </button>
                </div>
              </div>
            )}

            {showProjectPicker && activeGenProvider === 'flow' && !showFlowOverlay && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div
                  className="bg-[#1A1A1A] rounded-2xl border border-white/10 flex flex-col shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
                  style={{ maxHeight: '85vh' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="project-select-header" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '16px 16px 12px' }}>
                    <svg className="project-select-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: '2px', flexShrink: 0 }}>
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <div className="project-select-header-text" style={{ flex: 1, minWidth: 0 }}>
                      <div className="project-select-title" style={{ fontSize: '14px', fontWeight: 600, color: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center' }}>
                        Chọn project
                        <span className="project-select-syncing" style={{ display: syncDone ? 'flex' : 'none', marginLeft: '8px', fontSize: '11px', fontWeight: 400, color: 'rgba(255,255,255,0.6)', alignItems: 'center', gap: '4px' }}>
                          <span style={{ color: '#10b981' }}>&#10003;</span> Đã đồng bộ
                        </span>
                      </div>
                      <div className="project-select-desc" style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>Chọn một project để bắt đầu làm việc</div>
                    </div>
                    <button
                      className="project-select-resync"
                      type="button"
                      title="Đồng bộ lại"
                      onClick={handleResync}
                      style={{ flexShrink: 0, width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', transition: 'all 0.15s' }}
                    >
                      <svg className="project-select-resync-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <polyline points="1 20 1 14 7 14"></polyline>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                      </svg>
                    </button>
                  </div>

                  <div className="project-select-search-wrap" style={{ padding: '0 16px 12px', position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <svg className="project-select-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: '26px' }}>
                      <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <input
                      type="text"
                      className="project-select-search"
                      placeholder="Tìm project..."
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                      autoComplete="off"
                      spellCheck="false"
                      style={{ width: '100%', padding: '8px 40px 8px 32px', background: '#141414', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', color: 'white', fontSize: '12px', outline: 'none' }}
                    />
                    <span className="project-select-search-count" style={{ position: 'absolute', right: '26px', fontSize: '10px', color: 'rgba(255,255,255,0.2)' }}>{filteredProjects.length}</span>
                  </div>

                  <div className="project-select-list" style={{ overflowY: 'auto', flex: 1, padding: '0 16px', maxHeight: 'calc(85vh - 160px)' }}>
                    {filteredProjects.length === 0 ? (
                      <div style={{ padding: '16px 0', textAlign: 'center', fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>
                        Không có project nào
                        {flowProjects.length === 0 && (
                          <div style={{ marginTop: '8px' }}>
                            <button
                              onClick={handleResync}
                              style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', color: 'rgba(255,255,255,0.6)', fontSize: '11px', cursor: 'pointer' }}
                            >
                              Scan current Flow page again
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      filteredProjects.map((project) => (
                        <div
                          key={project.id}
                          className="project-select-item"
                          onClick={() => handleSelectFlowProject(project)}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderRadius: '8px', cursor: 'pointer', transition: 'background 0.15s', marginBottom: '4px' }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <div className="project-select-item-info" style={{ flex: 1, minWidth: 0 }}>
                            <span className="project-select-name" style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
                            {project.date && (
                              <span className="project-select-date" style={{ display: 'block', fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '1px' }}>{project.date}</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                    {flowProjects.length > 0 && (
                      <div style={{ padding: '8px 0 4px', fontSize: '10px', color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
                        Found {flowProjects.length} project{flowProjects.length !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>

                  <div className="project-select-actions" style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <button
                      className="project-select-create-btn"
                      onClick={() => setShowProjectPicker(false)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', background: '#7C5CFF', border: 'none', borderRadius: '8px', color: 'white', fontSize: '12px', fontWeight: 500, cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#6B4CE0')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '#7C5CFF')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                      Tạo dự án mới
                    </button>
                  </div>
                </div>
              </div>
            )}

            <GenPanel
              activeGenProvider={activeGenProvider}
              onProviderChange={setActiveGenProvider}
              onHideFlowOverlay={() => { setHasFlowTab(true); setShowFlowOverlay(false) }}
            />
          </div>
        )}
        {activeTab === 'workflow' && (
          <WorkflowEditor isSidebarOpen={isSidebarOpen} onToggleSidebar={onToggleSidebar} />
        )}
        {activeTab === 'prompts' && <PromptsPanel />}
        {activeTab === 'tasks' && <TasksPanel />}
        {activeTab === 'history' && <HistoryPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  )
}
