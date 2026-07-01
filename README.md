# AI Flow Automation - Chrome Extension

An AI Workflow Automation Tool for Google Flow, ChatGPT, Grok and other AI platforms, built with React, TypeScript, Tailwind CSS, and Plasmo Framework.

## Features

- **Workflow Editor**: Visual node-graph editor using @xyflow/react (React Flow)
- **AI Provider Adapters**: Google Flow, ChatGPT, Grok (extensible)
- **Pipeline Runner**: Sequential execution with state management (pending/running/completed/failed)
- **Prompt Manager**: Save, organize, and reuse prompts
- **Task Queue**: Manage automation pipelines
- **History**: Track completed workflow runs
- **Preset Templates**: Quick-start workflows
- **Dark Mode UI**: Modern glassmorphism design with Framer Motion animations
- **Chrome Side Panel**: Primary interface
- **Wake Lock**: Prevent screen sleep during long automations
- **Auto Download**: Automatically save results
- **Retry Logic**: Configurable retry on failure

## Tech Stack

- Plasmo Framework (Chrome Extension SDK)
- React 18 + TypeScript
- Tailwind CSS v3
- @xyflow/react v12 (React Flow)
- Zustand v5 (State Management)
- Framer Motion (Animations)
- Chrome Side Panel API
- Manifest V3

## Project Structure

```
ai-workflow-automation/
├── src/
│   ├── components/
│   │   ├── workflow/
│   │   │   └── nodes/         # React Flow nodes
│   │   ├── prompt/            # Prompt Manager
│   │   ├── queue/             # Task Queue
│   │   ├── history/            # History Panel
│   │   ├── presets/           # Preset Templates
│   │   ├── settings/          # Settings Panel
│   │   ├── pipeline/          # Pipeline Progress overlay
│   │   └── SidePanel.tsx      # Main container
│   ├── providers/             # AI provider adapters
│   ├── pipeline/              # Pipeline runner engine
│   ├── stores/                # Zustand stores
│   ├── types/                 # TypeScript types
│   ├── constants/             # App constants
│   ├── lib/                   # Utilities
│   ├── content-scripts/       # Content scripts
│   ├── background/            # Service worker
│   └── sidepanel.tsx          # Side Panel entry
├── assets/                    # Icons
├── plasmo.config.ts
├── package.json
├── tsconfig.json
└── tailwind.config.js
```

## Setup Instructions

### 1. Install Dependencies

```bash
cd ai-workflow-automation
npm install
```

### 2. Create Icon Files

The extension requires PNG icon files. Run this PowerShell script to generate them:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\uchih\Desktop\ai-workflow-automation\create-icons.ps1"
```

Or manually run these commands in PowerShell:

```powershell
$dir = "C:\Users\uchih\Desktop\ai-workflow-automation\assets"
# Create icon16.png, icon32.png, icon48.png, icon128.png
# (Use the base64 strings in create-icons.ps1)
```

### 3. Build the Extension

```bash
npm run build
```

### 4. Load in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `build/chrome-mv3-prod` folder

### 5. Open Side Panel

1. Click the extension icon in Chrome toolbar
2. Or right-click and select "Open side panel"

## Usage

### Creating a Workflow

1. Click "New Workflow" in the sidebar
2. Click node type buttons (Prompt, Image, Generate, Delay, Download, Wait) to add nodes
3. Drag nodes to position them
4. Connect nodes by dragging from output handles to input handles
5. Click a node to edit its properties
6. Click "Run" to execute the pipeline

### Node Types

- **Prompt Node**: Enter prompts with variable interpolation
- **Image Node**: Configure aspect ratio and image upload
- **Generate Node**: Trigger generation and wait for completion
- **Delay Node**: Add time delays between steps
- **Download Node**: Download results automatically
- **Wait Node**: Wait for DOM changes or manual confirmation

### Provider Selection

Select your AI provider (Google Flow, ChatGPT, Grok) in the Prompt node settings. The pipeline will automatically open/focus the correct tab and inject scripts.

## License

MIT
