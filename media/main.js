// @ts-ignore

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
    const vscode = acquireVsCodeApi();

    let response = '';
    let providers = []; // To store providers
    let prompts = []; 
    let models = []; // To store models for the selected provider
    let selectedProviderIndex = 0;

    // Streaming state and lightweight renderer
    let isStreaming = false;
    let streamBuffer = '';
    let pendingDelta = '';
    let pendingFinalResponse = false;
    let renderScheduled = false;
    const MAX_STREAM_LINES = 50;
    // Markers to denote reasoning segments inside the streaming buffer (not persisted)
    const REASON_START = '[[[__REASON_START__]]]';
    const REASON_END = '[[[__REASON_END__]]]';
    // Watchdog to auto-abort stalled streams
    const STREAM_IDLE_TIMEOUT_MS = 90000; // 90s without deltas => consider stalled
    let lastDeltaAt = 0;
    let streamWatchdog = null;

    // Remember per-message collapse state (keyed by message index)
    const collapseState = new Map(); // key: "messageIndex", value: boolean (true = collapsed)
    // Remember per-message "move ref to end" toggle
    const moveRefState = new Map(); // key: "messageIndex", value: boolean
    
    /**
     * Build a short preview from the message content's text
     */
    function makePreviewText(contentEl, maxLines = 3, maxChars = 300) {
        const text = (contentEl.innerText || '').trim();
        if (!text) return '[empty]';
    
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        let out = '';
        let usedLines = 0;
    
        for (const l of lines) {
            const candidate = out ? out + '\n' + l : l;
            if (candidate.length > maxChars || usedLines >= maxLines) break;
            out = candidate;
            usedLines++;
        }
        out = out.trim();
        if (out.length < text.length) out += ' …';
        return out || '[empty]';
    }
    
    
    function scheduleStreamRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            // If streaming already ended before this RAF fires, do nothing
            if (!isStreaming) {
                renderScheduled = false;
                pendingDelta = '';
                return;
            }
            renderScheduled = false;
            if (pendingDelta) {
                streamBuffer += pendingDelta;
                pendingDelta = '';
            }
            renderTruncatedStream(streamBuffer);
        });
    }

    function escapeHtml(s) {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function markersToHtml(textWithMarkers) {
        // Convert our reasoning markers to colored spans, escaping all user text
        let html = '';
        let i = 0;
        while (i < textWithMarkers.length) {
            const start = textWithMarkers.indexOf(REASON_START, i);
            if (start === -1) {
                html += escapeHtml(textWithMarkers.slice(i));
                renderScheduled = false;
                break;
            }
            // normal segment before reasoning
            if (start > i) {
                html += escapeHtml(textWithMarkers.slice(i, start));
            }
            const end = textWithMarkers.indexOf(REASON_END, start + REASON_START.length);
            if (end === -1) {
                // No closing marker yet; treat rest as reasoning
                const reasonText = textWithMarkers.slice(start + REASON_START.length);
                html += `<span class="reasoning-delta">${escapeHtml(reasonText)}</span>`;
                break;
            } else {
                const reasonText = textWithMarkers.slice(start + REASON_START.length, end);
                html += `<span class="reasoning-delta">${escapeHtml(reasonText)}</span>`;
                i = end + REASON_END.length;
            }
        }
        return html;
    }

    function renderTruncatedStream(fullText) {
        const lines = fullText.split(/\r?\n/);
        const over = lines.length > MAX_STREAM_LINES;
        const prefixLines = over ? lines.slice(0, lines.length - MAX_STREAM_LINES) : [];
        const tailLines = over ? lines.slice(-MAX_STREAM_LINES) : lines;

        // If the tail starts inside a code fence, open a fence to keep rendering consistent
        const backticksInPrefix = (prefixLines.join('\n').match(/``​`/g) || []).length;
        const needsOpenFence = backticksInPrefix % 2 === 1;

        let snippet = (over ? '...\n' : '') + (needsOpenFence ? '``​`\n' : '') + tailLines.join('\n');
        snippet = fixCodeBlocks(snippet);

        // Plain text render (no Markdown conversion, no event handlers)
        const responseDiv = document.getElementById("response");
        if (!responseDiv) return;
        responseDiv.innerHTML = '';
        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        // Render with minimal HTML to colorize reasoning segments, escaping all user content
        pre.innerHTML = markersToHtml(snippet);
        responseDiv.appendChild(pre);

        responseDiv.scrollTop = responseDiv.scrollHeight;
    }

    // Function to populate the provider and model selectors
    function populateSelectors(providers, selectedProviderIndex = 0, selectedModelIndex = 0) {
        const providerSelector = document.getElementById('provider-selector');
        providerSelector.innerHTML = ''; // Clear existing options
        providers.forEach((provider, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = provider.name;
            providerSelector.appendChild(option);
        });

        if (providers.length > 0) {
            providerSelector.value = selectedProviderIndex; // Set default selection
            models = providers[selectedProviderIndex].models;
        }

        const modelSelector = document.getElementById('model-selector');
        modelSelector.innerHTML = ''; // Clear existing options
        models.forEach((model, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = model.name;
            modelSelector.appendChild(option);
        });

        if (models.length > 0) {
            modelSelector.value = selectedModelIndex; // Set default selection
        }
    }

    function populatePrompts(prompts, selectedPromptIndex = 0) {
        const promptSelector = document.getElementById('system-prompt-selector');
        promptSelector.innerHTML = ''; // Clear existing options
        prompts.forEach((prompt, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = prompt.name;
            promptSelector.appendChild(option);
        });

        if (prompts.length > 0) {
            promptSelector.value = selectedPromptIndex; // Set default selection
            //models = providers[selectedProviderIndex].models;
        }
    }

    window.addEventListener('load', () => {
        // Notify the extension that the webview is ready
        vscode.postMessage({ type: 'ready' });
    });
    
    // Note: Ensure you import the vscode API object correctly in your web script.
    
    // Handle messages sent from the extension to the webview
    window.addEventListener("message", (event) => {
        const message = event.data;
        switch (message.type) {
            case "addResponse": {
                response = message.value;
                // If we're still streaming, decide whether to force-cancel or defer
                if (isStreaming) {
                    // Do not cancel streaming mid-flight; defer final render until streamEnd
                    pendingFinalResponse = true;
                } else {
                    setResponse();
                }
                break;
            }
            case "updateResponse": {
                console.log("Update Response!!!!!");
                setResponse();
                console.log("After Update Response !!!!!!!!!");
                break;                
            }
            case "updateStats": {
                const v = message.value || {};
                const total = v.totalTokens ?? 0;
                const used = v.usedTokens ?? 0;
                const p = v.promptTokens ?? 0;
                const c = v.completionTokens ?? 0;
                const model = v.model ?? '-';
            
                const elTotal = document.getElementById('stats-total');
                const elUsed = document.getElementById('stats-used');
                const elModel = document.getElementById('stats-model');
            
                if (elTotal) elTotal.textContent = `Total Tokens: ${total}`;
                if (elUsed) elUsed.textContent = `Used: ${used} (${p}+${c})`;
                if (elModel) elModel.textContent = `Model: ${model}`;
                break;
            }
            case "clearResponse": {
                response = '';
                break;
            }
            case "setPrompt": {
                document.getElementById("prompt-input").value = message.value;
                break;
            }
            case "initialize": { 
                providers = message.value;
                populateSelectors(providers);
                break;
            }

            case "initialize_prompts": {
                console.log("Initialize Prompts:", message.value); 
                prompts = message.value;
                populatePrompts(prompts);
                break;
            }

            case "resetCollapseState": {
                // Clear remembered collapse/expand states (e.g., on chat reset)
                collapseState.clear();
                moveRefState.clear();
                break;
            }
            case "setCollapsedForIndex": {
                // Mark a specific message index as collapsed by default
                const idx = message.index;
                if (idx !== undefined && idx !== null) {
                    collapseState.set(String(idx), true);
                }
                break;
            }
            case "setMoveRefToEndForIndex": {
                // Initialize the 'move reference to end' toggle for a message index
                const idx = message.index;
                const val = !!message.value;
                moveRefState.set(String(idx), val);
                break;
            }
            case "streamStart": {
                isStreaming = true;
                streamBuffer = '';
                pendingDelta = '';
                lastDeltaAt = Date.now();
                // Start/Reset watchdog
                if (streamWatchdog) { clearInterval(streamWatchdog); streamWatchdog = null; }
                streamWatchdog = setInterval(() => {
                    if (!isStreaming) return;
                    const now = Date.now();
                    if (now - lastDeltaAt > STREAM_IDLE_TIMEOUT_MS) {
                        // Consider the stream stalled; finalize with what we have
                        const raw = (streamBuffer || '') + (pendingDelta || '');
                        // Strip reasoning markers before sending partial back to extension,
                        // so they never leak into saved chat history.
                        const stripMarkers = (s) =>
                            s.replaceAll(REASON_START, '').replaceAll(REASON_END, '');
                        const partial = stripMarkers(raw);
                        isStreaming = false;
                        pendingDelta = '';
                        renderScheduled = false;
                        if (streamWatchdog) { clearInterval(streamWatchdog); streamWatchdog = null; }
                        vscode.postMessage({ type: 'forceFinalizePartial', value: partial });
                    }
                }, 1000);                
                const responseDiv = document.getElementById("response");
                if (responseDiv) responseDiv.innerHTML = '...';
                break;
            }
            case "appendDelta": {
                if (!isStreaming) break;
                pendingDelta += message.value || '';
                lastDeltaAt = Date.now();
                scheduleStreamRender();
                break;
            }
            case "appendReasoningDelta": {
                if (!isStreaming) break;
                // Wrap reasoning chunks with markers for colored rendering
                pendingDelta += REASON_START + (message.value || '') + REASON_END;
                lastDeltaAt = Date.now();
                scheduleStreamRender();
                break;
            }
            case "streamEnd": {
                isStreaming = false;
                // Clear any pending streaming buffers and cancel scheduled render
                pendingDelta = '';
                streamBuffer = '';
                renderScheduled = false;
                if (streamWatchdog) { clearInterval(streamWatchdog); streamWatchdog = null; }
                // If a final full response was received during streaming, render it now
                if (pendingFinalResponse) {
                    pendingFinalResponse = false;
                    setResponse();
                }                
                break;
            }            
        }
    });

    showdown.extension('thinkExtension', function() {
        return [
          {
            type: 'lang', // Process block-level syntax
            regex: /<think>([\s\S]*?)<\/think>/g,
            replace: function(match, content) {
              // Trim and process lines, ensuring let's handle `<p>` tags ourselves
              const pTags = content.trim().split('\n').map(line => {
                if (line.trim()) {
                  return `<p>${line.trim()}</p>`;
                }
                return '';
              }).join('');
      
              return `<think>${pTags}</think>`;
            }
          },
          {
            type: 'output', // After markdown is converted to HTML
            filter: function(text) {
              // Remove wrapping <p> tags around <think> elements
              return text.replace(/<p><think>/g, '<think>').replace(/<\/think><\/p>/g, '</think>');
            }
          }
        ];
    });

    function fixCodeBlocks(response) {
        const REGEX_CODEBLOCK = new RegExp('```', 'g');
        const matches = response.match(REGEX_CODEBLOCK);

        const count = matches ? matches.length : 0;
        return count % 2 === 0 ? response : response.concat('\n```');
    }

    function replaceInlineFileCodeWithLinks(container) {
        // Regex: most simple file paths like 'foo.ext', 'dir/file.ext', etc.
        const filePattern = /^[\w\-./]+\.[a-zA-Z0-9]+$/;
        // Only affect <code> that is NOT inside a <pre> (pre/code = code block, just code = inline code)
        container.querySelectorAll('code').forEach(codeElem => {
            if (codeElem.closest('pre')) return; // skip code blocks
            const text = codeElem.textContent.trim();
            if (filePattern.test(text)) {
                const a = document.createElement('a');
                a.textContent = text;
                a.href = "#";
                a.className = "file-link";
                a.tabIndex = 0;
                a.dataset.filepath = text;
                a.addEventListener('click', function(e) {
                    e.preventDefault();
                    window.lastClickedFileLink = this;
                    window.lastClickedScrollTop = this.closest("#response").scrollTop;
                    vscode.postMessage({
                        type: 'fileClicked',
                        value: text
                    });
                });
                codeElem.replaceWith(a);
            }
        });
    }
    
    function sanitizeHtml(html) {
        const purifier = window.DOMPurify; // global from purify.min.js
        if (!purifier) {
            console.warn('DOMPurify not found. Rendering without sanitization.');
            return html; // fallback so the chat still renders
        }
        return purifier.sanitize(html, {
            FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta'],
            FORBID_ATTR: [
                'onerror','onload','onclick','onfocus','onblur','onmouseover','onmouseenter',
                'onmouseleave','onmouseup','onmousedown','onkeypress','onkeydown','onkeyup'
            ],
            ALLOW_UNKNOWN_PROTOCOLS: false
        });
    }
    
    // Detect nested code fences and neutralize inner ``` so they render as plain text
    // within the outer fenced block (prevents prematurely closing the outer fence).
    // Improved logic:
    // - Track we are inside an outer fence and its length.
    // - Maintain an innerDepth counter for any inner "opening" we neutralize (e.g., ```python).
    // - When we encounter a pure backtick fence line while innerDepth > 0, neutralize it
    //   as the inner closing and decrement. Only close the outer fence when innerDepth == 0.
    // - Also neutralize any stray runs of >=3 backticks within lines to avoid accidental closures.
    function preprocessNestedCodeFences(md) {
        const ZWSP = "\u200B";
        const lines = md.split(/\r?\n/);
        let inFence = false;
        let fenceLen = 0;
        let innerDepth = 0;
    
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
    
            if (!inFence) {
                // Opening outer fence: ```lang or ````lang (captures fence length)
                const open = line.match(/^\s*(`{3,})([^`]*)$/);
                if (open) {
                    inFence = true;
                    fenceLen = open[1].length;
                }
                continue;
            }
    
            // Inside an outer fence:
            // 1) Inner "opening" like ```python (backticks + non-empty info string)
            const innerOpen = line.match(/^\s*(`{3,})(\S.*)$/);
            if (innerOpen) {
                lines[i] = line.replace(/^\s*`{3,}/, (m) => m.slice(0, 2) + ZWSP + m.slice(2));
                innerDepth++;
                continue;
            }
    
            // 2) Candidate closing line for fences: only backticks and optional spaces
            const isClosing = new RegExp("^\\s*`{" + fenceLen + ",}\\s*$").test(line);
            if (isClosing) {
                if (innerDepth > 0) {
                    // Treat as inner closing; neutralize instead of closing the outer
                    lines[i] = line.replace(/`{3,}/g, (m) => m.slice(0, 2) + ZWSP + m.slice(2));
                    innerDepth--;
                    continue;
                } else {
                    // Real closing of the outer fence
                    inFence = false;
                    fenceLen = 0;
                    continue;
                }
            }
    
            // 3) Neutralize any other runs of >=3 backticks within the content line
            if (/`{3,}/.test(line)) {
                lines[i] = line.replace(/`{3,}/g, (m) => m.slice(0, 2) + ZWSP + m.slice(2));
            }
        }
        return lines.join('\n');
    }
    // Split the overall HTML (all messages) into separate message chunks.
    // We detect a new message when we see an <h1> that contains the checkbox input
    // id="message-checkbox-...". This relies on the structure generated by _updateChatMessages.
    function chunkHtmlIntoMessageBlocks(fullHtml) {
        const tmp = document.createElement('div');
        tmp.innerHTML = fullHtml;

        const blocks = [];
        let current = [];

        const isMsgHeader = (node) =>
            node.nodeType === 1 &&
            /^H[1-6]$/.test(node.tagName) &&
            node.querySelector &&
            node.querySelector("input[id^='message-checkbox-']");

        const nodes = Array.from(tmp.childNodes);
        for (const n of nodes) {
            if (isMsgHeader(n)) {
                if (current.length) {
                    blocks.push(nodesToHtml(current));
                    current = [];
                }
                current.push(n);
            } else {
                if (current.length) current.push(n);
            }
        }
        if (current.length) blocks.push(nodesToHtml(current));
        return blocks;

        function nodesToHtml(list) {
            const w = document.createElement('div');
            list.forEach(x => w.appendChild(x.cloneNode(true)));
            return w.innerHTML;
        }
    }

    // Render a single message block into its own Shadow DOM and re-bind interactions.
    function renderMessageBlock(container, blockHtml) {
        const host = document.createElement('div');
        host.className = 'message-host';
        container.appendChild(host);
    
        const shadow = host.attachShadow({ mode: 'open' });
    
        const baseStyles = `
            :host {
                color: var(--vscode-editor-foreground);
                font-size: 12px;
                font-family: var(--vscode-editor-font-family, Menlo, Monaco, Consolas, 'Courier New', monospace);
            }
            .chat-content { line-height: 1.4; word-break: break-word; }
            .chat-content img { max-width: 100%; height: auto; }
            .chat-content pre { white-space: pre-wrap; }
            .chat-content code {
                display: inline-flex; max-width: 100%; overflow: hidden; border-radius: .125rem;
                cursor: pointer; background: rgba(127,127,127,.1); padding: 0 .2rem;
            }
            .chat-content [id^='message-content-'] { white-space: pre-wrap; }                
            .chat-content pre code {
                display: block; padding: .5rem; margin: .5rem 0; overflow-x: auto; background: rgba(127,127,127,.08);
            }
            .chat-content a { color: var(--vscode-textLink-foreground); text-decoration: underline; }
    
            .chat-content h1, .chat-content h2, .chat-content h3,
            .chat-content h4, .chat-content h5, .chat-content h6 {
                font-weight: 700;
                margin: 0 0 6px 0;
                line-height: 1.2;
                display: flex;
                align-items: center;
                gap: .5rem;
            }
            .chat-content h1 { font-size: 0.95rem; }
            .chat-content h2 { font-size: 0.92rem; }
            .chat-content h3 { font-size: 0.90rem; }
            .chat-content h4 { font-size: 0.88rem; }
            .chat-content h5 { font-size: 0.86rem; }
            .chat-content h6 { font-size: 0.84rem; }
    
            .collapse-toggle {
                margin-left: auto;
                font-size: 0.8rem;
                width: 1.5rem;
                height: 1.5rem;
                line-height: 1.3rem;
                text-align: center;
                border: 1px solid var(--vscode-editorGroup-border);
                border-radius: 3px;
                background: transparent;
                color: inherit;
                cursor: pointer;
            }
            .move-ref-toggle {
                margin-left: .25rem;
                width: 1.1rem;
                height: 1.1rem;
                vertical-align: middle;
            }
            .move-ref-label {
                font-size: 0.75rem;
                opacity: 0.85;
            }
            .message-preview {
                color: var(--vscode-descriptionForeground);
                white-space: pre-wrap;
                border-left: 2px solid var(--vscode-editorGroup-border);
                padding-left: .5rem;
                margin: .25rem 0 .5rem .25rem;
            }
        `;
    
        shadow.innerHTML = `<style>${baseStyles}</style><div class="chat-content">${blockHtml}</div>`;
        const root = shadow.querySelector('.chat-content');
    
        // Re-bind checkbox changes (onchange attribute was stripped by sanitizer)
        root.querySelectorAll("input[type='checkbox'][id^='message-checkbox-']").forEach(cb => {
            cb.addEventListener('change', function () {
                vscode.postMessage({
                    type: 'checkboxChanged',
                    id: this.id,
                    checked: this.checked
                });
            });
        });
    
        // Re-bind editable content (onclick/onblur attributes were stripped)
        root.querySelectorAll("[id^='message-content-']").forEach(el => {
            el.addEventListener('click', function () {
                this.contentEditable = 'true';
                this.focus();
            });
            el.addEventListener('blur', function () {
                this.contentEditable = 'false';
                vscode.postMessage({
                    type: 'messageContentChanged',
                    id: this.id,
                    value: this.innerText
                });
            });
        });
    
        // Turn inline `code` that looks like file paths into clickable links
        replaceInlineFileCodeWithLinks(root);
    
        // Click-to-paste code (same message back to the extension)
        root.querySelectorAll('code').forEach(codeBlock => {
            if (codeBlock.innerText.startsWith("Copy code")) {
                codeBlock.innerText = codeBlock.innerText.replace("Copy code", "");
            }
            codeBlock.addEventListener('click', function (e) {
                e.preventDefault();
                vscode.postMessage({
                    type: 'codeSelected',
                    value: this.innerText
                });
            });
    
            const d = document.createElement('div');
            d.innerHTML = codeBlock.innerHTML;
            codeBlock.innerHTML = '';
            codeBlock.appendChild(d);
            d.classList.add("code");
        });
    
        // Optional: syntax highlight inside Shadow DOM (best-effort)
        try {
            if (window.microlight && typeof window.microlight.reset === 'function') {
                const codes = root.querySelectorAll('code');
                window.microlight.reset(codes);
            }
        } catch (_) {}
    
        // ---- New: Collapse/Expand per message block ----
        const headingEl = root.querySelector('h1, h2, h3, h4, h5, h6');
        if (headingEl) {
            // Collect all siblings after the heading as the message content
            const contentNodes = [];
            let n = headingEl.nextSibling;
            while (n) {
                const next = n.nextSibling;
                contentNodes.push(n);
                root.removeChild(n);
                n = next;
            }
    
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-body';
            contentNodes.forEach(node => contentDiv.appendChild(node));
            root.appendChild(contentDiv);
    
            // Figure out a stable-ish key for this message (use the checkbox id index)
            const check = headingEl.querySelector("input[id^='message-checkbox-']");
            let msgKey = null;
            if (check && check.id) {
                const m = check.id.match(/message-checkbox-(\d+)/);
                if (m) msgKey = m[1]; // a string index
            }
    
            // Create preview when collapsed
            const previewDiv = document.createElement('div');
            previewDiv.className = 'message-preview';
            previewDiv.textContent = makePreviewText(contentDiv, 3, 300);
            root.insertBefore(previewDiv, contentDiv);
    
            // Toggle button
            const btn = document.createElement('button');
            btn.className = 'collapse-toggle';
            btn.title = 'Collapse/Expand';
            btn.setAttribute('aria-expanded', 'true');
            btn.textContent = '−';
            headingEl.appendChild(btn);

            // "Move reference to end" checkbox only for reference messages
            if (msgKey && contentDiv && /^File reference:/i.test((contentDiv.innerText || '').trim())) {
                const moveWrap = document.createElement('span');
                moveWrap.style.display = 'inline-flex';
                moveWrap.style.alignItems = 'center';
                moveWrap.style.gap = '.25rem';
                moveWrap.style.marginLeft = '.25rem';
                
                const moveCb = document.createElement('input');
                moveCb.type = 'checkbox';
                moveCb.className = 'move-ref-toggle';
                moveCb.title = 'Move this file reference to the end before each send';
                const prev = moveRefState.get(msgKey);
                if (prev) moveCb.checked = true;
                moveCb.addEventListener('change', function () {
                    moveRefState.set(msgKey, !!this.checked);
                    vscode.postMessage({ type: 'toggleMoveRefToEnd', index: parseInt(msgKey, 10), checked: !!this.checked });
                });
                moveWrap.appendChild(moveCb);
                headingEl.appendChild(moveWrap);
            }    
            // Restore previous state or default to expanded
            let collapsed = msgKey ? !!collapseState.get(msgKey) : false;
            applyCollapsed(collapsed);
    
            function applyCollapsed(c) {
                if (c) {
                    contentDiv.style.display = 'none';
                    previewDiv.style.display = 'block';
                    btn.textContent = '+';
                    btn.setAttribute('aria-expanded', 'false');
                } else {
                    contentDiv.style.display = 'block';
                    previewDiv.style.display = 'none';
                    btn.textContent = '−';
                    btn.setAttribute('aria-expanded', 'true');
                }
            }
    
            // Button toggles
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                collapsed = !collapsed;
                applyCollapsed(collapsed);
                if (msgKey) collapseState.set(msgKey, collapsed);
                // Notify extension to persist collapsed state for YAML export
                if (msgKey) {
                    vscode.postMessage({
                        type: 'collapseChanged',
                        index: parseInt(msgKey, 10), collapsed
                    });
                }
            });
    
            // Optional: clicking the header (not on the checkbox) toggles as well
            headingEl.addEventListener('click', (e) => {
                const target = e.target;
                if (target && target.tagName === 'INPUT') return; // don't toggle when clicking the checkbox
                if (target === btn) return; // already handled
                collapsed = !collapsed;
                applyCollapsed(collapsed);
                if (msgKey) collapseState.set(msgKey, collapsed);
                // Notify extension to persist collapsed state for YAML export
                if (msgKey) {
                    vscode.postMessage({
                        type: 'collapseChanged',
                        index: parseInt(msgKey, 10), collapsed
                    });
                }                
            });
        }
    }

    // Recognize our generated header line
    function isHeaderMarkdownLine(line) {
      // e.g.: "### <u> <input id='message-checkbox-0' ...> SYSTEM </u>:"
      return /^#{1,6}\s*<u>\s*<input[^>]*id=['"]message-checkbox-/.test(line);
    }

    // Escape only literal <style>...</style> occurrences outside code fences/inline code,
    // but keep our header lines intact.
    function escapeLiteralStyleTagsOutsideCodeExceptHeader(md) {
      let inFence = false;
      const lines = md.split(/\r?\n/);

      // Replace <style ...> -> &lt;style ...&gt; and </style> -> &lt;/style&gt;
      const escapeStyleTagsInPlain = (text) => {
        return text
          .replace(/<\s*style\b([^>]*)>/gi, (m, attrs) => `&lt;style${attrs || ''}&gt;`)
          .replace(/<\s*\/\s*style\s*>/gi, '&lt;/style&gt;');
      };

      // Preserve inline code (`...`) segments as-is; escape only the rest of the line
      const escapeOutsideInlineCode = (line) => {
        const parts = line.split(/(`[^`]*`)/g);
        return parts
          .map((part, idx) => (idx % 2 === 1 ? part : escapeStyleTagsInPlain(part)))
          .join('');
      };

      const processed = lines.map((line) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          return line; // leave fence markers unchanged
        }
        if (inFence) return line; // leave fenced code unchanged
        if (isHeaderMarkdownLine(line)) return line; // keep header line intact
        return escapeOutsideInlineCode(line);
      });

      return processed.join('\n');
    }

    function setResponse() {
        var converter = new showdown.Converter({
            omitExtraWLInCodeBlocks: true,
            simplifiedAutoLink: true,
            excludeTrailingPunctuationFromURLs: true,
            literalMidWordUnderscores: true,
            simpleLineBreaks: true,
            extensions: ['thinkExtension']
        });

        // 1) Convert markdown to HTML for the entire chat content
        const fixed = fixCodeBlocks(response);
        // Escape only literal <style> tags in prose (not in code / header)
        const escapedMd = escapeLiteralStyleTagsOutsideCodeExceptHeader(fixed);
        // Neutralize nested code fences so inner fences stay as text within the outer block
        const normalizedMd = preprocessNestedCodeFences(escapedMd);

        const rawHtml = converter.makeHtml(normalizedMd);
        const safeHtml = sanitizeHtml(rawHtml);
        
        // 3) Split into per-message chunks and render each in its own Shadow DOM
        const responseDiv = document.getElementById("response");
        responseDiv.innerHTML = '';

        const blocks = chunkHtmlIntoMessageBlocks(safeHtml);
        if (blocks.length === 0) {
            // Fallback: render everything in a single isolated block
            renderMessageBlock(responseDiv, safeHtml);
        } else {
            blocks.forEach(b => renderMessageBlock(responseDiv, b));
        }

        // 4) Preserve scroll behavior
        if (window.lastClickedFileLink && typeof window.lastClickedScrollTop === "number") {
            responseDiv.scrollTop = window.lastClickedScrollTop;
            window.lastClickedFileLink = null;
            window.lastClickedScrollTop = null;
        } else {
            responseDiv.scrollTop = responseDiv.scrollHeight;
        }
    }

    document.getElementById('prompt-input').addEventListener('paste', async function (e) {
        const clipboardItems = e.clipboardData.items;
        for (const item of clipboardItems) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                const reader = new FileReader();
                reader.onload = function (event) {
                    const base64Data = event.target.result;
                    vscode.postMessage({
                        type: 'pasteImage',
                        value: base64Data
                    });
                };
                reader.readAsDataURL(file);
            }
        }
    });

    document.getElementById('prompt-input').addEventListener('keyup', function (e) {
        if (e.key === "Enter" && !e.ctrlKey) {
            vscode.postMessage({
                type: 'prompt',
                value: this.value
            });
        }
        else if (e.key === "Enter" && e.ctrlKey) {
            vscode.postMessage({
                type: 'promptNoQuery',
                value: this.value
            });
        }
    });

    document.getElementById('provider-selector').addEventListener('change', function () {
        selectedProviderIndex = parseInt(this.value, 10);
        models = providers[selectedProviderIndex].models;
        populateSelectors(providers, selectedProviderIndex, 0);
        vscode.postMessage({
            type: 'providerModelChanged',
            providerIndex: selectedProviderIndex,
            modelIndex: 0
        });
    });

    document.getElementById('model-selector').addEventListener('change', function () {
        const selectedModelIndex = parseInt(this.value, 10);
        vscode.postMessage({
            type: 'providerModelChanged',
            providerIndex: selectedProviderIndex,
            modelIndex: selectedModelIndex,
        });
    });

    document.getElementById('system-prompt-selector').addEventListener('change', function () {
        const systemPromptIndex = parseInt(this.value, 10);
        vscode.postMessage({
            type: 'systemPromptChanged',
            systemPromptIndex: systemPromptIndex
        });
    });

    //document.getElementById('temperature-slider').addEventListener('input', function () {
    //    const temperature = parseInt(this.value, 10) / 100;
    //    vscode.postMessage({
    //        type: 'temperatureChanged',
    //        temperature: temperature,
    //    });
    //});

    window.myFunction = function (checkboxElem) {
        vscode.postMessage({
            type: 'checkboxChanged',
            id: checkboxElem.id,
            checked: checkboxElem.checked
        });
    }

    window.makeEditable = function (element) {
        element.contentEditable = 'true';
        element.focus();
    }

    window.saveContent = function (element) {
        element.contentEditable = 'false';
        const updatedContent = element.innerText;
        vscode.postMessage({
            type: 'messageContentChanged',
            id: element.id,
            value: updatedContent,
        });
    }

})();