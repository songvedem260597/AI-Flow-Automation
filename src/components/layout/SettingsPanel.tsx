import React from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

export const SettingsPanel: React.FC = () => {
  const settings = useSettingsStore()

  return (
    <div className="flex flex-col h-full bg-[#0A0A0A]">
      <div className="px-4 py-3 border-b border-white/5">
        <h2 className="text-xs font-semibold text-white/50 uppercase tracking-widest">Settings</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="space-y-2">
          <label className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Appearance</label>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">Theme</span>
              <span className="text-xs text-white/30 capitalize">{settings.theme}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">Default Provider</span>
              <span className="text-xs text-white/30 capitalize">{settings.defaultProvider}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">Auto Download</span>
              <button
                onClick={() => settings.setAutoDownload(!settings.autoDownload)}
                className={cn(
                  'w-9 h-5 rounded-full transition-all relative',
                  settings.autoDownload ? 'bg-[#7C5CFF]' : 'bg-white/10'
                )}
              >
                <div className={cn(
                  'w-3.5 h-3.5 rounded-full bg-white absolute top-1/2 -translate-y-1/2 transition-all',
                  settings.autoDownload ? 'left-[22px]' : 'left-1'
                )} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
