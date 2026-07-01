import React from 'react'
import { motion } from 'framer-motion'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { PROVIDER_LABELS } from '@/constants'
import type { AIProvider } from '@/types'
import {
  Settings, Moon, Bell, Download, Clock, Zap, Shield, Keyboard,
  Eye, RotateCcw, Check
} from 'lucide-react'

export const SettingsPanel: React.FC = () => {
  const settings = useSettingsStore()

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white/80">Settings</h2>
        <p className="text-xs text-white/30 mt-0.5">Configure your automation preferences</p>
      </div>

      <div className="space-y-3">
        <Section title="General" icon={<Settings className="w-4 h-4" />}>
          <Toggle
            label="Auto Download"
            description="Automatically download results after generation"
            checked={settings.autoDownload}
            onChange={settings.setAutoDownload}
          />
          <Select
            label="Download Format"
            value={settings.downloadFormat}
            onChange={(v) => settings.setDownloadFormat(v as 'png' | 'jpg' | 'webp')}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpg', label: 'JPG' },
              { value: 'webp', label: 'WebP' }
            ]}
          />
          <Select
            label="Default Provider"
            value={settings.defaultProvider}
            onChange={(v) => settings.setDefaultProvider(v as AIProvider)}
            options={Object.entries(PROVIDER_LABELS).map(([v, l]) => ({ value: v, label: l }))}
          />
        </Section>

        <Section title="Automation" icon={<Zap className="w-4 h-4" />}>
          <NumberInput
            label="Max Retries"
            value={settings.maxRetries}
            onChange={(v) => settings.updateSettings({ maxRetries: v })}
            min={0}
            max={10}
          />
          <NumberInput
            label="Retry Delay (ms)"
            value={settings.retryDelay}
            onChange={(v) => settings.updateSettings({ retryDelay: v })}
            min={500}
            max={30000}
            step={500}
          />
          <NumberInput
            label="Timeout Duration (ms)"
            value={settings.timeoutDuration}
            onChange={(v) => settings.updateSettings({ timeoutDuration: v })}
            min={5000}
            max={300000}
            step={5000}
          />
          <Toggle
            label="Wake Lock"
            description="Keep screen awake during long automations"
            checked={settings.wakeLockEnabled}
            onChange={settings.setWakeLock}
          />
        </Section>

        <Section title="Notifications" icon={<Bell className="w-4 h-4" />}>
          <Toggle
            label="On Complete"
            checked={settings.notifications.onComplete}
            onChange={(v) => settings.updateSettings({ notifications: { ...settings.notifications, onComplete: v } })}
          />
          <Toggle
            label="On Error"
            checked={settings.notifications.onError}
            onChange={(v) => settings.updateSettings({ notifications: { ...settings.notifications, onError: v } })}
          />
          <Toggle
            label="On Progress"
            checked={settings.notifications.onProgress}
            onChange={(v) => settings.updateSettings({ notifications: { ...settings.notifications, onProgress: v } })}
          />
        </Section>

        <Section title="Advanced" icon={<Shield className="w-4 h-4" />}>
          <Toggle
            label="Debug Mode"
            checked={settings.advanced.debugMode}
            onChange={(v) => settings.updateSettings({ advanced: { ...settings.advanced, debugMode: v } })}
          />
          <Toggle
            label="Preserve Session"
            checked={settings.advanced.preserveSession}
            onChange={(v) => settings.updateSettings({ advanced: { ...settings.advanced, preserveSession: v } })}
          />
          <Toggle
            label="Parallel Execution"
            checked={settings.advanced.parallelExecution}
            onChange={(v) => settings.updateSettings({ advanced: { ...settings.advanced, parallelExecution: v } })}
          />
        </Section>

        <Section title="Shortcuts" icon={<Keyboard className="w-4 h-4" />}>
          {Object.entries(settings.shortcuts).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between py-2">
              <span className="text-sm text-white/60 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
              <kbd className="px-2 py-1 bg-white/10 rounded text-xs text-white/60 font-mono">{value}</kbd>
            </div>
          ))}
        </Section>

        <motion.button
          onClick={settings.resetSettings}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm text-white/40 hover:text-red-400 transition-colors"
        >
          <RotateCcw className="w-4 h-4" />
          Reset to Defaults
        </motion.button>
      </div>
    </div>
  )
}

const Section: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => (
  <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
    <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
      <span className="text-violet-400">{icon}</span>
      <h3 className="text-sm font-medium text-white/70">{title}</h3>
    </div>
    <div className="p-4 space-y-3">
      {children}
    </div>
  </div>
)

const Toggle: React.FC<{ label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, description, checked, onChange }) => (
  <div className="flex items-center justify-between">
    <div>
      <p className="text-sm text-white/70">{label}</p>
      {description && <p className="text-xs text-white/30 mt-0.5">{description}</p>}
    </div>
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-10 h-5.5 rounded-full transition-colors',
        checked ? 'bg-violet-500' : 'bg-white/10'
      )}
    >
      <motion.div
        animate={{ x: checked ? 18 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className="absolute top-1 w-3.5 h-3.5 bg-white rounded-full shadow"
      />
    </button>
  </div>
)

const Select: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }> = ({ label, value, onChange, options }) => (
  <div className="flex items-center justify-between">
    <span className="text-sm text-white/70">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white/70 outline-none focus:border-violet-500/50"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  </div>
)

const NumberInput: React.FC<{ label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }> = ({ label, value, onChange, min, max, step }) => (
  <div className="flex items-center justify-between">
    <span className="text-sm text-white/70">{label}</span>
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white/70 text-right outline-none focus:border-violet-500/50"
    />
  </div>
)
