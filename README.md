# DevMate AI Chat

Use ChatGPT, GPT‑4, and compatible APIs right inside VS Code to enhance and automate your coding with AI‑powered assistance. DevMate provides a flexible provider/model selector, rich chat UI with streaming, reasoning deltas, token stats, file/content references, images, YAML import/export, and more.

- Publisher: diegoaac
- Extension ID: diegoaac.devmate-ai-chat
- License: MIT
- Min VS Code: 1.73.0

---

## Table of Contents

- [Features](#features)
- [Screens & UX Highlights](#screens--ux-highlights)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
	- [Providers (devmate.providers)](#providers-devmateproviders)
	- [System Prompts (devmate.prompts)](#system-prompts-devmateprompts)
	- [Behavior Settings](#behavior-settings)
- [Usage](#usage)
	- [The Chat View](#the-chat-view)
	- [Commands & Menus](#commands--menus)
	- [Working with Files and Images](#working-with-files-and-images)
	- [YAML Import/Export](#yaml-importexport)
	- [Streaming, Reasoning, and Stats](#streaming-reasoning-and-stats)
	- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Privacy & Security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Development Guide](#development-guide)
	- [Project Structure](#project-structure)
	- [Build, Run, Test](#build-run-test)
	- [Packaging & Publishing (vsce)](#packaging--publishing-vsce)
	- [Webview Messaging Protocol](#webview-messaging-protocol)
	- [Providers & APIs](#providers--apis)
	- [Compatibility Notes](#compatibility-notes)
- [Changelog](#changelog)
- [License](#license)

---

## Features

- Provider and Model selectors with per‑model API type:
	- Chat Completions (e.g., gpt-4o-mini, compatible endpoints)
	- Responses API (OpenAI v6+ Responses with tools and reasoning)
- Streaming output with low-latency rendering
	- Shows reasoning deltas in a distinct style while streaming (not persisted to history)
- Token stats bar: total, last used (prompt+completion), and current model
- Rich chat controls per message:
	- Include/Exclude message from context (checkbox)
	- Collapse/Expand with preview
	- Edit message content inline
	- “Move reference to end” toggle for file references
- File workflows:
	- Add file content (code blocks) to chat
	- Add lightweight file reference (content expanded at send time)
	- Add multiple references/images from selected path lists
	- Clickable inline code that looks like a file path opens & adds it
- Image support:
	- Drag/paste images into the prompt input (as image parts)
	- Add images from Explorer context menu
- YAML import/export:
	- Export the current chat as YAML
	- Replace or append chat by selecting YAML in the editor
- System Prompt selector (from configured prompts)
- Click‑to‑paste any code block into the editor (configurable)
- Watchdog to auto‑finalize stalled streams

---

## Screens & UX Highlights

- Fast streaming renderer with truncated view (shows tail of long outputs, keeps code fences balanced)
- Reasoning deltas highlighted while streaming; saved into a collapsed <think> message when done
- Each message renders in its own Shadow DOM for safer, isolated markup with sanitized HTML

---

## Requirements

- VS Code ≥ 1.73.0
- An AI provider account and API key (e.g., OpenAI)
- Node.js (for development/build)
- For Responses API features: OpenAI SDK v6+

---

## Installation

- From VSIX:
	- Build/package (see Development Guide), then install:
	```bash
	code --install-extension devmate-ai-chat-*.vsix
	```
- From Marketplace:
	- When published, search for “DevMate AI Chat” and install.

Open Command Palette → “DevMate AI Chat: Ask DevMate AI Chat” or open the “DevMate AI Chat” view from the Activity Bar.

---

## Quick Start

1. Open Settings and search for “DevMate AI Chat”.
2. Configure at least one provider in devmate.providers (see below).
3. Open the “DevMate AI Chat” view (Activity Bar).
4. Select a provider and model; set a system prompt if desired.
5. Type your question and press Enter to send.

---

## Configuration

All settings live under the devmate namespace.

### Providers (devmate.providers)

Define one or more providers with models. Each model can specify which API to use (chatCompletions or responses), custom options, and optional tools (Responses API).

Example:
```json
{
	"devmate.providers": [
	{
		"name": "OpenAI",
		"apiKey": "sk-...",
		"apiUrl": "https://api.openai.com/v1",
		"chatCompletionsUrl": "https://api.openai.com/v1",
		"responsesUrl": "https://api.openai.com/v1",
		"models": [
		{
			"name": "gpt-4o-mini (Chat Completions)",
			"model_name": "gpt-4o-mini",
			"api": "chatCompletions",
			"options": {
			"temperature": 0.7,
			"max_tokens": 1024
			},
			"reasoning_output_delta_path": "choices[0].delta.reasoning"
		},
		{
			"name": "o4-mini (Responses)",
			"model_name": "o4-mini",
			"api": "responses",
			"tools": [
			{ "type": "web_search" }
			],
			"options": {
			"temperature": 0.6,
			"max_output_tokens": 2048,
			"reasoning": { "summary": "auto" }
			}
		}
		]
	}
	]
}
```

Notes:
- For Chat Completions, set chatCompletionsUrl (or fallback to apiUrl).
- For Responses, set responsesUrl (or fallback to apiUrl).
- reasoning_output_delta_path is optional and provider‑specific; it tells DevMate where to find reasoning deltas in streaming chat completion chunks.

### System Prompts (devmate.prompts)

Define a list of reusable system prompts for the selector.

```json
{
	"devmate.prompts": [
	{ "name": "Default", "prompt": "You are a helpful assistant." },
	{ "name": "Explain-first", "prompt": "You are a meticulous assistant. First explain the reasoning, then provide the code." }
	]
}
```

### Behavior Settings

```json
{
	"devmate.pasteOnClick": true,
	"devmate.selectedInsideCodeblock": true,
	"devmate.codeblockWithLanguageId": true,
	"devmate.keepConversation": true,
	"devmate.timeoutLength": 120
}
```

- pasteOnClick: Click a code block in responses to paste into the editor.
- selectedInsideCodeblock: Wrap editor selection in code fences when sending.
- codeblockWithLanguageId: Include language id in code fences.
- keepConversation: Reuse the same conversation for follow‑ups.
- timeoutLength: Request timeout (seconds).

---

## Usage

### The Chat View

- Top bar: Provider and Model selectors.
- Message list:
	- Each message shows role and content, with a checkbox to include/exclude from next context.
	- Collapse/expand with preview. Collapsed state is preserved for YAML export/import.
	- Inline editing for plain text messages.
	- For “File reference” messages, a “Move reference to end” toggle appears. When enabled, the reference is moved just before your latest query on send (leaving a note where it was).
- Stats bar: Total tokens used across the session, tokens used this request (prompt+completion), and model.
- Bottom: System Prompt selector and the input box.

### Commands & Menus

Commands:
- devmate.ask — Ask DevMate AI Chat
- devmate.explain — Explain selection
- devmate.refactor — Refactor selection
- devmate.optimize — Optimize selection
- devmate.findProblems — Find problems
- devmate.documentation — Write documentation
- devmate.resetConversation — Reset conversation
- devmate.pasteChat — Paste chat (export YAML into editor)
- devmate.useSelectionAsChat — Use selection as conversation (import YAML, replaces)
- devmate.appendSelectionAsChat — Append selection as conversation (import YAML, appends)
- devmate.appendSelectionMarkdownAsChat — Append Markdown selection as chat (images + text)
- devmate.addImageToChat — Add image (Explorer)
- devmate.addFileToChat — Add file content (Explorer)
- devmate.addFileReferenceToChat — Add file reference (Explorer)
- devmate.addSelectedPathsAsReferences — Add multiple references/images from selected tree text

Menus:
- Editor context: Most chat actions (explain/refactor/optimize/etc.)
- Explorer context: Add image/file content/file reference

### Working with Files and Images

- Add File Content: Inserts file contents immediately as a code block.
- Add File Reference: Inserts a lightweight reference; actual content is injected right before sending the next prompt. Toggle “Move reference to end” to auto‑pin near the query.
- Inline file paths in responses: Any inline code that looks like a path becomes clickable and can be added automatically.
- Images: Paste images into the prompt input or add via Explorer context menu. Images are attached as proper image parts.

### YAML Import/Export

- Export: “Paste chat” inserts the current chat as YAML into the active editor. Collapsed states and moveToEnd flags are included.
- Import (replace): Select YAML → “Use selection as DevMate AI Chat conversation”.
- Import (append): Select YAML → “Append selection to DevMate AI Chat conversation”.

YAML format is an array of messages with:
```yaml
- role: user|assistant|system
	content: string | parts
	selected: true|false
	collapsed: true|false # optional
	moveToEnd: true|false # optional
```

### Streaming, Reasoning, and Stats

- Output is streamed to the view.
- Reasoning deltas are shown in a distinct color during streaming and are saved as a collapsed <think> assistant message after completion.
- Token stats bar shows totals and per‑request usage.
- Watchdog: If streaming stalls for ~90s, the partial output is finalized to avoid hanging.

### Keyboard Shortcuts

- Enter: Send query (uses editor selection if configured).
- Ctrl+Enter (Cmd+Enter on macOS): Send without querying the editor selection (Prompt No Query).

---

## Privacy & Security

- DevMate sends your selected messages (including file contents, images, and references expanded at send time) to the configured provider endpoint(s). Review your content before sending.
- Your API key is read from your VS Code settings (devmate.providers). Keep it secure.
- DevMate does not transmit data anywhere else.

---

## Troubleshooting

- “API key or API URL not set…”: Ensure devmate.providers is configured. Pick a provider/model in the UI.
- Responses API errors:
	- Requires OpenAI SDK v6+ (Responses). Update dependencies and rebuild if needed.
- Stalled stream:
	- The watchdog finalizes partial output after ~90s. Try again or check provider status.
- Click‑to‑paste disabled:
	- Set devmate.pasteOnClick to true.

---

## Known Limitations

- Token estimates use js‑tiktoken heuristics and may not match provider billing exactly.
- Reasoning markers are visible in the stream but not saved in the final answer (saved separately in a collapsed <think> message).
- Mixed lockfiles (npm/yarn) or SDK versions can cause mismatches (see Compatibility Notes).

---

## Roadmap

- Multi‑message editing improvements
- Model capability discovery in UI
- More provider templates
- Better diff/patch operations back to workspace

---

## Contributing

Issues and PRs are welcome. Please:
- Describe expected vs. actual behavior
- Include logs (DevTools / Output) if relevant
- For PRs, run lint/tests and keep changes focused

---

## Development Guide

### Project Structure

```
.
├─ media/
│  ├─ main.js               # Webview script (UI, streaming renderer, events, sanitization)
│  ├─ styles.css            # Webview styles
│  └─ scripts/              # Microlight, Tailwind, Showdown, DOMPurify
├─ src/
│  ├─ extension.ts          # Activation, commands, configuration glue
│  ├─ chatGptViewProvider.ts# Core chat logic, OpenAI calls, messages/state
│  └─ types.ts              # Shared types, provider/model definitions
├─ dist/                    # Webpack output (extension.js)
├─ package.json
├─ package-lock.json / yarn.lock
├─ webpack.config.js
├─ tsconfig.json
└─ vsc-extension-quickstart.md
```

Architecture:
- Extension host (Node): src/extension.ts, src/chatGptViewProvider.ts
- UI (Webview): media/main.js + HTML generated by provider
- Messaging: webview.postMessage / onDidReceiveMessage

### Build, Run, Test

- Install deps:
	```bash
	yarn
	# or: npm install
	```
- Build (bundle with webpack):
	```bash
	yarn compile
	# or: npm run compile
	```
- Watch:
	```bash
	yarn watch
	```
- Launch the extension:
	- Press F5 in VS Code (“Run Extension”)
- Lint:
	```bash
	yarn lint
	```
- Tests (Mocha):
	```bash
	yarn test
	```

Note: The repo contains both package-lock.json and yarn.lock. Use one package manager consistently to avoid version drift. If using npm, you can refresh the lock with:
```bash
npm run update-package-lock
```

### Packaging & Publishing (vsce)

This project is packaged with vsce (Visual Studio Code Extension Manager).

- Install vsce (globally):
	```bash
	npm install -g @vscode/vsce
	```
- Build the bundle first:
	```bash
	yarn compile
	# or: npm run compile
	```
- Create the .vsix package:
	```bash
	vsce package
	```
	This produces devmate-ai-chat-<version>.vsix in the project root.

- Install the VSIX locally:
	```bash
	code --install-extension devmate-ai-chat-*.vsix
	```

Notes:
- vsce runs the vscode:prepublish script automatically if defined (this project’s prepublish bundles with webpack in production mode).
- To publish to the Marketplace, follow:
	https://code.visualstudio.com/api/working-with-extensions/publishing-extension

### Webview Messaging Protocol

Webview → Extension:
- ready
- prompt / promptNoQuery
- pasteImage
- codeSelected
- checkboxChanged
- messageContentChanged
- collapseChanged
- toggleMoveRefToEnd
- providerModelChanged
- systemPromptChanged
- forceFinalizePartial
- fileClicked

Extension → Webview:
- initialize (providers)
- initialize_prompts (system prompts)
- addResponse (render content)
- updateResponse
- clearResponse
- setPrompt
- updateStats (tokens/model)
- resetCollapseState
- setCollapsedForIndex
- setMoveRefToEndForIndex
- Streaming:
	- streamStart
	- appendDelta
	- appendReasoningDelta
	- streamEnd

See media/main.js and src/chatGptViewProvider.ts for exact payload shapes.

### Providers & APIs

- Model selection drives API usage:
	- chatCompletions: openai.chat.completions.create({ stream: true, ... })
	- responses: openai.responses.stream({ model, input, tools?, reasoning?, ... })
- Tools (Responses API):
	- Server-side tools like web_search are handled by the provider.
	- Client-side custom tools are stubbed with a deterministic output so the model can proceed.
- File references:
	- Lightweight string markers (e.g., <!--FILE:relative/path.ext-->) are expanded to code blocks at send time using the latest on-disk file contents.

### Compatibility Notes

- OpenAI SDK:
	- This project targets OpenAI SDK v6+ for Responses API features. Ensure your installed version is ≥ 6 if you intend to use responses.stream().
	- If you see dependency mismatches (e.g., older openai versions in your lockfile), align by installing:
	```bash
	npm install openai@^6
	# or
	yarn add openai@^6
	```
- Mixed lockfiles:
	- Prefer either npm or yarn. Remove the other lockfile to avoid version drift.

---

## Changelog

- 1.1.0
	- Provider/Model selectors with Chat Completions & Responses support
	- Streaming with reasoning deltas and token stats bar
	- File references with “Move to end” toggle and path click handling
	- YAML import/export; Markdown selection import (with images)
	- Image paste support; inline editing; collapse/expand messages
	- Streaming watchdog for stalled responses

---

## License

MIT © Diego Alfonso Aguilar Cardona