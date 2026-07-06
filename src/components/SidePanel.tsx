import React, { useState, useEffect, useRef, useCallback } from 'react'
import { usePersistedState } from '@/lib/utils'
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

function getFlowProjectIdFromUrl(url?: string) {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!u.hostname.includes('labs.google')) return null
    const match = u.pathname.match(/^\/fx\/(?:[a-z]{2}\/)?tools\/flow\/project\/([^/]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function isAnyFlowUrl(url?: string) {
  return isFlowHomeUrl(url) || isFlowProjectUrl(url)
}

function isChatGPTUrl(url?: string) {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com')
  } catch {
    return false
  }
}

type TrackedGenProvider = 'flow' | 'chatgpt'

function isTrackedGenProvider(provider: string): provider is TrackedGenProvider {
  return provider === 'flow' || provider === 'chatgpt'
}

function isProviderUrl(provider: TrackedGenProvider, url?: string) {
  return provider === 'flow' ? isAnyFlowUrl(url) : isChatGPTUrl(url)
}

interface CheckResult {
  hasFlow: boolean
  hasProvider: boolean
  activeUrl: string
  flowTabId?: number
  providerTabId?: number
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

async function checkAllTabs(provider: TrackedGenProvider = 'flow'): Promise<CheckResult> {
  try {
    const allTabs = await chrome.tabs.query({})
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = activeTabs[0]
    const flowTab = allTabs.find(t => isAnyFlowUrl(t.url))
    const providerTab = allTabs.find(t => isProviderUrl(provider, t.url))

    return {
      hasFlow: Boolean(flowTab),
      hasProvider: Boolean(providerTab),
      activeUrl: activeTab?.url || '',
      flowTabId: flowTab?.id,
      providerTabId: providerTab?.id
    }
  } catch (err) {
    return {
      hasFlow: false,
      hasProvider: false,
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

async function navigateToFlowProject(project: FlowProject) {
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = activeTabs[0]
    const allTabs = await chrome.tabs.query({})
    const targetTab = activeTab?.id && isAnyFlowUrl(activeTab.url)
      ? activeTab
      : allTabs.find(t => t.id && isAnyFlowUrl(t.url))

    const relativeHref = project.href || `/fx/vi/tools/flow/project/${project.id}`
    const targetUrl = targetTab?.url
      ? new URL(relativeHref, targetTab.url).href
      : new URL(relativeHref, 'https://labs.google').href

    if (targetTab?.id) {
      await chrome.tabs.update(targetTab.id, { url: targetUrl, active: true })
      return
    }

    await chrome.tabs.create({ url: targetUrl, active: true })
  } catch {}
}

export const SidePanel: React.FC<SidePanelProps> = ({ isSidebarOpen, onToggleSidebar }) => {
  const [activeTab, setActiveTab] = usePersistedState<string>('sidepanel.activeTab', 'gen')
  const [hasFlowTab, setHasFlowTab] = useState<boolean>(false)
  const [showFlowOverlay, setShowFlowOverlay] = useState<boolean>(false)
  const [currentUrl, setCurrentUrl] = useState<string>('')
  const [activeGenProvider, setActiveGenProvider] = usePersistedState<string>('sidepanel.activeGenProvider', 'flow')
  const [initDone, setInitDone] = useState<boolean>(false)
  const [flowProjects, setFlowProjects] = usePersistedState<FlowProject[]>('sidepanel.flowProjects', [])
  const [selectedProject, setSelectedProject] = usePersistedState<FlowProject | null>('sidepanel.selectedFlowProject', null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState<boolean>(false)
  const [projectSearch, setProjectSearch] = useState<string>('')
  const [syncDone, setSyncDone] = useState<boolean>(false)
  const providerRef = useRef(activeGenProvider)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingProjectNavigationRef = useRef<{ projectId: string; startedAt: number } | null>(null)
  const projectLoadRequestRef = useRef(0)

  useEffect(() => {
    providerRef.current = activeGenProvider
  }, [activeGenProvider])

  const applyProviderCheckResult = useCallback((provider: TrackedGenProvider, result: CheckResult) => {
    setCurrentUrl(result.activeUrl || result.error || 'NO ACTIVE URL')

    if (provider !== 'flow') {
      setShowProjectPicker(false)
      setSyncDone(false)
    }

    if (result.error) {
      if (provider === 'flow') setHasFlowTab(false)
      setShowFlowOverlay(true)
      setShowProjectPicker(false)
      return
    }

    const hasProviderTab = result.hasProvider || isProviderUrl(provider, result.activeUrl)
    if (provider === 'flow') setHasFlowTab(hasProviderTab)

    if (hasProviderTab) {
      setShowFlowOverlay(false)
    } else {
      setShowFlowOverlay(true)
      setShowProjectPicker(false)
    }
  }, [])

  const runCheck = useCallback(async () => {
    const provider = providerRef.current
    if (!isTrackedGenProvider(provider)) return

    const result = await checkAllTabs(provider)
    if (providerRef.current !== provider) return

    applyProviderCheckResult(provider, result)
  }, [applyProviderCheckResult])

  useEffect(() => {
    if (activeGenProvider !== 'flow') return

    const currentProjectId = getFlowProjectIdFromUrl(currentUrl)
    if (!currentProjectId) return

    const cachedProject = flowProjects.find((project) => project.id === currentProjectId)
    const selectedMatchesCurrent = selectedProject?.id === currentProjectId

    if (cachedProject && !selectedMatchesCurrent) {
      setSelectedProject(cachedProject)
    }

    if (cachedProject || selectedMatchesCurrent) {
      pendingProjectNavigationRef.current = null
      setShowFlowOverlay(false)
      setShowProjectPicker(false)
      setSyncDone(false)
    }
  }, [activeGenProvider, currentUrl, flowProjects, selectedProject, setSelectedProject])

  useEffect(() => {
    if (!isTrackedGenProvider(activeGenProvider)) {
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
      const provider = providerRef.current
      if (!isTrackedGenProvider(provider)) return
      const result = await checkAllTabs(provider)
      if (cancelled || providerRef.current !== provider) return

      setInitDone(true)
      applyProviderCheckResult(provider, result)
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
  }, [activeGenProvider, applyProviderCheckResult])

  useEffect(() => {
    if (!initDone) return
    if (activeGenProvider !== 'flow') {
      projectLoadRequestRef.current += 1
      return
    }
    if (showFlowOverlay) {
      projectLoadRequestRef.current += 1
      return
    }

    if (!isFlowHomeUrl(currentUrl)) {
      projectLoadRequestRef.current += 1
      if (isFlowProjectUrl(currentUrl)) {
        pendingProjectNavigationRef.current = null
      }
      setShowProjectPicker(false)
      setSyncDone(false)
      return
    }

    const pendingNavigation = pendingProjectNavigationRef.current
    if (pendingNavigation) {
      if (Date.now() - pendingNavigation.startedAt < 8000) {
        setShowProjectPicker(false)
        setIsLoadingProjects(false)
        return
      }
      pendingProjectNavigationRef.current = null
    }

    const requestId = projectLoadRequestRef.current + 1
    projectLoadRequestRef.current = requestId
    setSelectedProject((project) => project ? null : project)
    setShowProjectPicker(true)
    setSyncDone(false)
    setIsLoadingProjects(true)

    loadFlowProjects(requestId).then(() => {
      if (projectLoadRequestRef.current !== requestId) return
      setShowProjectPicker(true)
      setSyncDone(true)
    })
  }, [activeGenProvider, currentUrl, showFlowOverlay, initDone])

  const handleResync = async () => {
    setSyncDone(false)
    setIsLoadingProjects(true)
    await runCheck()
    if (isFlowProjectUrl(currentUrl)) {
      setIsLoadingProjects(false)
      setSyncDone(true)
      return
    }
    if (isFlowHomeUrl(currentUrl)) {
      const projects = await readFlowProjectsFromActiveTab()
      setFlowProjects(projects)
      setSelectedProject(null)
      setShowProjectPicker(true)
      setSyncDone(true)
      setIsLoadingProjects(false)
    } else {
      setShowProjectPicker(false)
      setSyncDone(true)
      setIsLoadingProjects(false)
    }
  }

  const loadFlowProjects = async (requestId?: number) => {
    setIsLoadingProjects(true)
    try {
      const projects = await readFlowProjectsFromActiveTab()
      if (requestId && projectLoadRequestRef.current !== requestId) return projects
      setFlowProjects(projects)
      return projects
    } catch {
      if (requestId && projectLoadRequestRef.current !== requestId) return []
      setFlowProjects([])
      return []
    } finally {
      if (!requestId || projectLoadRequestRef.current === requestId) {
        setIsLoadingProjects(false)
      }
    }
  }

  const handleSelectFlowProject = async (project: FlowProject) => {
    pendingProjectNavigationRef.current = { projectId: project.id, startedAt: Date.now() }
    setSelectedProject(project)
    await navigateToFlowProject(project)
    setShowProjectPicker(false)
  }

  const handleOpenFlowHome = async () => {
    pendingProjectNavigationRef.current = null
    const flowHomeUrl = 'https://labs.google/fx/tools/flow'
    const result = await checkAllTabs()
    if (result.hasFlow && result.flowTabId) {
      await chrome.tabs.update(result.flowTabId, { url: flowHomeUrl, active: true }).catch(() => {})
    } else {
      await chrome.tabs.create({ url: flowHomeUrl, active: true }).catch(() => {})
    }
    setCurrentUrl(flowHomeUrl)
    setHasFlowTab(true)
    setShowFlowOverlay(false)
    setSelectedProject(null)
    setShowProjectPicker(true)
    setSyncDone(false)
    setIsLoadingProjects(true)
    setActiveGenProvider('flow')
  }

  const handleOpenChatGPT = async () => {
    const chatGPTUrl = 'https://chatgpt.com/'
    const result = await checkAllTabs('chatgpt')
    if (result.hasProvider && result.providerTabId) {
      await chrome.tabs.update(result.providerTabId, { active: true }).catch(() => {})
    } else {
      await chrome.tabs.create({ url: chatGPTUrl, active: true }).catch(() => {})
    }
    setCurrentUrl(chatGPTUrl)
    setShowFlowOverlay(false)
    setShowProjectPicker(false)
    setActiveGenProvider('chatgpt')
  }

  const filteredProjects = flowProjects.filter(p =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase())
  )
  const currentFlowProjectId = getFlowProjectIdFromUrl(currentUrl)
  const cachedCurrentFlowProject = currentFlowProjectId
    ? flowProjects.find((project) => project.id === currentFlowProjectId)
    : null
  const hasCachedCurrentFlowProject = Boolean(
    currentFlowProjectId &&
    (selectedProject?.id === currentFlowProjectId || cachedCurrentFlowProject)
  )
  const hasFlowProjectSelectionForCurrentTab = currentFlowProjectId
    ? hasCachedCurrentFlowProject
    : Boolean(selectedProject)
  const mustOpenFlowHomeForProjectSelection =
    activeGenProvider === 'flow' &&
    !showFlowOverlay &&
    !hasFlowProjectSelectionForCurrentTab &&
    !isFlowHomeUrl(currentUrl)
  const mustSelectFlowProject =
    activeGenProvider === 'flow' &&
    !showFlowOverlay &&
    !selectedProject &&
    isFlowHomeUrl(currentUrl)
  const shouldShowFlowOpenOverlay =
    activeGenProvider === 'flow' &&
    (showFlowOverlay || mustOpenFlowHomeForProjectSelection)
  const shouldShowChatGPTOpenOverlay =
    activeGenProvider === 'chatgpt' &&
    showFlowOverlay
  const shouldShowProjectPicker =
    activeGenProvider === 'flow' &&
    !showFlowOverlay &&
    !mustOpenFlowHomeForProjectSelection &&
    (showProjectPicker || mustSelectFlowProject)
  const providerOpenOverlay = shouldShowFlowOpenOverlay
    ? {
        title: 'Google Flow tab not open',
        description: 'Please open Google Flow home to select a project',
        action: 'Open Google Flow',
        onClick: handleOpenFlowHome,
      }
    : shouldShowChatGPTOpenOverlay
      ? {
          title: 'ChatGPT tab not open',
          description: 'Please open ChatGPT to use this extension',
          action: 'Open ChatGPT',
          onClick: handleOpenChatGPT,
        }
      : null

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
        <div className={activeTab === 'gen' ? 'relative h-full' : 'contents'}>
            {providerOpenOverlay && (
              <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
                    {providerOpenOverlay.title}
                  </p>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '16px' }}>
                    {providerOpenOverlay.description}
                  </p>
                  <button
                    onClick={providerOpenOverlay.onClick}
                    className="flex items-center gap-2 px-4 py-2 bg-[#7C5CFF] hover:bg-[#6B4CE0] text-white text-sm font-medium rounded-xl transition-colors cursor-pointer w-full justify-center"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    {providerOpenOverlay.action}
                  </button>
                </div>
              </div>
            )}

            {shouldShowProjectPicker && (
              <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div
                  className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1A1A1A] shadow-2xl mx-4"
                  style={{ maxHeight: '72vh' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="project-select-header" style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '18px 20px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
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
                      <div className="project-select-desc" style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px' }}>Bắt buộc chọn một project trước khi dùng tab Gen</div>
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

                  {isLoadingProjects ? (
                    <div style={{ minHeight: '180px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px 20px', color: 'rgba(255,255,255,0.45)', fontSize: '12px' }}>
                      <svg className="animate-spin" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7C5CFF" strokeWidth="2" strokeLinecap="round">
                        <path d="M12 3a9 9 0 1 1-9 9" />
                      </svg>
                      <span>Đang tải danh sách project...</span>
                    </div>
                  ) : (
                    <>
                      <div className="project-select-search-wrap" style={{ padding: '14px 20px 12px', position: 'relative', display: 'flex', alignItems: 'center' }}>
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
                        <span className="project-select-search-count" style={{ position: 'absolute', right: '30px', fontSize: '10px', color: 'rgba(255,255,255,0.2)' }}>{filteredProjects.length}</span>
                      </div>

                      <div className="project-select-list" style={{ overflowY: 'auto', flex: 1, maxHeight: '42vh', padding: '0 20px 4px' }}>
                        {filteredProjects.length === 0 ? (
                      <div style={{ padding: '32px 0', textAlign: 'center', fontSize: '12px', color: 'rgba(255,255,255,0.35)' }}>
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
                              style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', borderRadius: '10px', cursor: 'pointer', transition: 'background 0.15s', marginBottom: '6px', border: '1px solid rgba(255,255,255,0.04)', background: 'rgba(255,255,255,0.02)' }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                              onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
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
                    </>
                  )}

                  {!isLoadingProjects && (
                  <div className="project-select-actions" style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <button
                      className="project-select-create-btn"
                      onClick={handleOpenFlowHome}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', background: '#7C5CFF', border: 'none', borderRadius: '8px', color: 'white', fontSize: '12px', fontWeight: 500, cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#6B4CE0')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '#7C5CFF')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                      Tạo dự án mới trên Flow
                    </button>
                  </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'gen' && (
              <GenPanel
                activeGenProvider={activeGenProvider}
                onProviderChange={setActiveGenProvider}
                onHideFlowOverlay={() => { setHasFlowTab(true); setShowFlowOverlay(false) }}
              />
            )}
        </div>
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
