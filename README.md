# DevMate AI Chat

DevMate is my “pseudo‑agentic” way to code with AI in VS Code. Instead of letting an autonomous agent spin up tools, hallucinate tasks, or loop on errors, you stay in control of the context at every step: choose which messages, files (content or references), images, and prompts to include and then send. I’ve used this workflow daily for 2+ years, it’s stable, avoids runaway loops, and keeps costs predictable (I average around $10/month across LLM providers). It complements faster, fully agentic IDEs (e.g., Cline, Cursor, Antigravity, Claude Code) but prioritizes reliability, determinism, and low burn. For many day‑to‑day tasks, this “pseudo‑agentic development” works better in practice.

<p align="center">
  <img src="resources/extensionIconColor.png" alt="Extension Icon" width="50%" height="auto">
</p>

- Publisher: diegoalfonsoaguilarcardona
- Extension ID: diegoalfonsoaguilarcardona.devmate-ai-chat
- License: MIT
- VS Code: ≥ 1.73.0

---

## Table of Contents

- [Why DevMate (Pseudo‑Agentic)](#why-devmate-pseudoagentic)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
	- [Providers (devmate.providers)](#providers-devmateproviders)
	- [System Prompts (devmate.prompts)](#system-prompts-devmateprompts)
	- [Behavior Settings](#behavior-settings)
- [Usage](#usage)
	- [Chat View](#chat-view)
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
- [Credits](#credits)
- [License](#license)

---

## Why DevMate (Pseudo‑Agentic)

- Stay in control: You decide the exact context per request (which prior messages, what file content vs. lightweight references, which images, which prompt).
- Cut waste and loops: No endless tool runs or agent loops. Keep requests focused and auditable.
- Predictable cost: Tight prompts and scoped context mean much lower token use; this has kept my monthly spend around ~$10.
- Practical day‑to‑day: In many coding tasks, this hands‑on approach beats fully agentic systems for reliability and speed to “good enough.”

---

## Features

- Provider/Model selectors per request
	- Chat Completions or Responses API (tools/reasoning) per model
- Fast streaming output with optional “reasoning deltas”
- Token stats: total, per‑request (prompt+completion), current model
- Fine‑grained message controls
	- Include/Exclude from context
	- Collapse/Expand with preview
	- Inline edit
	- “Move file reference to end” toggle
- Files and images
	- Add file content now, or lightweight references expanded on send
	- Clickable inline code paths open & add files
	- Paste/drag images or add from Explorer
- YAML import/export for the whole chat
- System Prompt selector
- Click‑to‑paste code blocks into your editor (optional)
- Watchdog to finalize stalled streams automatically

---

## Requirements

- VS Code ≥ 1.73.0
- An AI provider/API key (e.g., OpenAI-compatible)
- Node.js for development/build
- For Responses API features: OpenAI SDK v6+

---

## Installation

- From VSIX:
	```bash
	code --install-extension devmate-ai-chat-*.vsix
	```
- From Marketplace (when published): search “DevMate AI Chat”.

Open Command Palette → “DevMate AI Chat: Ask DevMate AI Chat” or open the DevMate AI Chat view from the Activity Bar.

---

## Quick Start

1. Open Settings and search “DevMate AI Chat”.
2. Configure at least one provider in devmate.providers.
3. Open the DevMate view (Activity Bar).
4. Pick a provider/model and optional system prompt.
5. Type your request and press Enter.

---

## Configuration

All settings live under devmate.

### Providers (devmate.providers)

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
			"options": { "temperature": 0.7, "max_tokens": 1024 },
			"reasoning_output_delta_path": "choices[0].delta.reasoning"
		},
		{
			"name": "o4-mini (Responses)",
			"model_name": "o4-mini",
			"api": "responses",
			"tools": [{ "type": "web_search" }],
			"options": { "temperature": 0.6, "max_output_tokens": 2048, "reasoning": { "summary": "auto" } }
		}
		]
	}
	]
}
```

Notes:
- Chat Completions uses chatCompletionsUrl (or apiUrl).
- Responses uses responsesUrl (or apiUrl).
- reasoning_output_delta_path is optional and provider‑specific.

### System Prompts (devmate.prompts)

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

---

## Usage

### Chat View

- Top: Provider/Model selectors
- Middle: Messages (include/exclude, collapse/expand, inline edit, “move ref to end” on reference messages)
- Bottom: System Prompt selector + input
- Stats bar shows tokens and current model

### Commands & Menus

- devmate.ask — Ask DevMate AI Chat
- devmate.explain — Explain selection
- devmate.refactor — Refactor selection
- devmate.optimize — Optimize selection
- devmate.findProblems — Find problems
- devmate.documentation — Write documentation
- devmate.resetConversation — Reset conversation
- devmate.pasteChat — Paste chat (export YAML)
- devmate.useSelectionAsChat — Replace chat from selected YAML
- devmate.appendSelectionAsChat — Append selected YAML
- devmate.appendSelectionMarkdownAsChat — Append Markdown (text+images)
- devmate.addImageToChat — Add image (Explorer)
- devmate.addFileToChat — Add file content (Explorer)
- devmate.addFileReferenceToChat — Add file reference (Explorer)
- devmate.addSelectedPathsAsReferences — Add multiple references/images from a selected “tree” text

### Working with Files and Images

- File Content: embeds the file as a code block now.
- File Reference: adds a lightweight reference and expands on send. Optionally “move to end” so it sits next to your latest query.
- Inline code paths in answers are clickable and can be added automatically.
- Images: paste/drag into input or add via Explorer.

### YAML Import/Export

- Export: “Paste chat” inserts YAML into your editor, including collapsed/moveToEnd flags.
- Import: Replace or append from selected YAML.

YAML shape:
```yaml
- role: user|assistant|system
	content: string | parts
	selected: true|false
	collapsed: true|false # optional
	moveToEnd: true|false # optional
```

### Streaming, Reasoning, and Stats

- Output streams live; optional reasoning deltas display in a distinct style and are saved as a collapsed <think> message.
- Watchdog finalizes if the stream stalls (~90s).

### Keyboard Shortcuts

- Enter: Send
- Ctrl+Enter (Cmd+Enter): Send (No Query)

---

## Privacy & Security

- Only the content you select (messages/files/images) is sent to your configured provider endpoint(s).
- API keys are read from your VS Code settings.
- No other telemetry or data exfiltration.

---

## Troubleshooting

- “API key or API URL not set…” → Configure devmate.providers and pick a model.
- Responses API not available → Use OpenAI SDK v6+ and rebuild.
- Stalled stream → Watchdog will finalize; retry or check provider status.
- Click‑to‑paste not working → Enable devmate.pasteOnClick.

---

## Known Limitations

- Token stats are estimates and may not match billing exactly.
- Reasoning deltas are streamed separately and saved as a collapsed <think> message.
- Mixed npm/yarn lockfiles can cause dependency drift (see Compatibility Notes).

---

## Roadmap

- Better multi‑message editing
- Provider templates and capability discovery
- Smarter diffs/patches back to files

---

## Contributing

Issues and PRs are welcome. Please include repro steps and logs if relevant, and keep PRs focused.

---

## Development Guide

### Project Structure

```
.
├─ media/
│  ├─ main.js               # Webview UI + streaming renderer
│  ├─ styles.css
│  └─ scripts/              # Microlight, Tailwind, Showdown, DOMPurify
├─ src/
│  ├─ extension.ts          # Activation, commands, settings
│  ├─ chatGptViewProvider.ts# Chat logic, OpenAI calls, state
│  └─ types.ts              # Shared types
├─ dist/                    # Webpack output
├─ package.json
├─ package-lock.json / yarn.lock
├─ webpack.config.js
├─ tsconfig.json
└─ vsc-extension-quickstart.md
```

### Build, Run, Test

```bash
# install deps
yarn        # or: npm install

# dev build
yarn compile    # or: npm run compile
yarn watch

# run the extension
# Press F5 in VS Code (“Run Extension”)

# lint / test
yarn lint
yarn test
```

Note: The repo contains both package-lock.json and yarn.lock. Use one package manager consistently. If using npm:
```bash
npm run update-package-lock
```

### Packaging & Publishing (vsce)

This project uses vsce to create the .vsix.

Recommended (auto version bump on each package):

```bash
# build, bump patch version in package.json, create VSIX
yarn package:vsix         # or: npm run package:vsix

# install locally
code --install-extension devmate-ai-chat-*.vsix
```

Notes:
- The package:vsix script runs webpack production build, then scripts/bump-version.js to increment the patch (x.y.Z), then runs vsce package.
- package.json is modified; commit the version bump as needed.

Legacy/manual packaging (kept for reference):

```bash
npm install -g @vscode/vsce

# production bundle (prepublish)
yarn compile              # or: npm run compile

# bump version yourself (REQUIRED; vsce won't do it for you)
npm version patch         # or update "version" in package.json manually

# create VSIX
vsce package

# install locally
code --install-extension devmate-ai-chat-*.vsix
```

Warning: Running vsce package directly will NOT bump the version, and the Marketplace requires a monotonically increasing version.

vsce runs the vscode:prepublish script automatically if defined.

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
- addResponse / updateResponse / clearResponse
- setPrompt
- updateStats
- resetCollapseState
- setCollapsedForIndex
- setMoveRefToEndForIndex
- streamStart / appendDelta / appendReasoningDelta / streamEnd

### Providers & APIs

- Chat Completions: openai.chat.completions.create({ stream: true, ... })
- Responses: openai.responses.stream({ model, input, tools?, reasoning?, ... })
- Tools: Server‑side tools (e.g., web_search) are handled by the provider. Client‑side custom tools are stubbed so the model can proceed.
- File references: Lightweight markers (e.g., <!--FILE:relative/path.ext-->) expand on send to current file contents.

### Compatibility Notes

- OpenAI SDK v6+ recommended for Responses API support:
	```bash
	npm install openai@^6
	# or
	yarn add openai@^6
	```
- If lockfiles pull older versions, align and rebuild.

---

## Changelog

- 1.1.0
	- Provider/Model selectors (Chat Completions & Responses)
	- Streaming + reasoning deltas + token stats
	- File references with “move to end” + clickable path handling
	- YAML import/export; Markdown selection import
	- Image paste; inline editing; collapse/expand; stream watchdog

---

## Credits

This project started as a fork of the following repository. Huge thanks to the original author(s) for the groundwork:
- Original project: [timkmecl chatgpt-vscode]( https://github.com/timkmecl/chatgpt-vscode )

If you were involved in the original project and want specific attribution, please open an issue or PR.

---

## License

MIT © Diego Alfonso Aguilar Cardona