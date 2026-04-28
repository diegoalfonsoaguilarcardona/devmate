import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as yaml from 'js-yaml';
import OpenAI from "openai";
import { AuthInfo, Settings, Message, Provider, Prompt, UserMessage, SystemMessage, AssistantMessage, BASE_URL, ModelPricing, SessionCostTotals, TokenUsage } from './types';
import { newUnifiedDiffStrategy } from 'diff-apply';
import { ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionContentPartText } from 'openai/resources/chat/completions';
import { TextDecoder } from 'util';

export class ChatGPTViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'devmate.chatView';
  private _view?: vscode.WebviewView;

  private _conversation?: any;
  private _messages?: Message[];
  private _openai?: OpenAI;

  private _response?: string;
  private _totalNumberOfTokens = 0;
  private _lastUsedTokens = 0;
  private _lastPromptTokens = 0;
  private _lastCompletionTokens = 0;
  private _prompt?: string;
  private _fullPrompt?: string;
  private _currentMessageNumber = 0;
  private _lastResponsesByModel: Map<string, Record<string, string>> = new Map();
  private _workspaceFolderForRelPath: Map<string, string> = new Map();
  private _sessionCostTotals: SessionCostTotals = {
    requestCount: 0,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0
  };
  private _lastRequestCost = 0;

  private _settings: Settings = {
    selectedInsideCodeblock: false,
    codeblockWithLanguageId: false,
    pasteOnClick: true,
    keepConversation: true,
    timeoutLength: 60,
    apiUrl: BASE_URL,
    apiType: 'chatCompletions',
    model: 'gpt-3.5-turbo',
    pricing: undefined,
    options: {
    },
  };
  private _authInfo?: AuthInfo;

  // In the constructor, we store the URI of the extension
  constructor(private readonly _extensionUri: vscode.Uri) {
    this._messages = [];
    this._messages?.push({ role: "system", content: this.getStartSystemPrompt(), selected: true });
    console.log("constructor....");
    console.log("messages:", this._messages);
  }

  // Set the API key and create a new API instance based on this key
  public setAuthenticationInfo(authInfo: AuthInfo) {
    this._authInfo = authInfo;
    this._newAPI();
  }

  public setSettings(settings: Settings) {
    let changeModel = false;

    // Check if there are any keys in the options object of the settings
    if (settings.apiUrl || settings.model || (settings.options && Object.keys(settings.options).length > 0)) {
      changeModel = true;
    }

    // Update settings with the new values
    this._settings = { ...this._settings, ...settings };

    if (changeModel) {
      //this._newAPI();
    }
  }

  public getSettings() {
    return this._settings;
  }

  // This private method initializes a new ChatGPTAPI instance
  private _newAPI() {
    console.log("New API");
    console.log("Messages:", this._messages);
    if (!this._authInfo || !this._settings?.apiUrl) {
      console.warn("API key or API URL not set, please go to extension settings (read README.md for more info)");
    } else {
      console.log("apiUrl:", this._settings?.apiUrl);
      this._openai = new OpenAI(
        {
          apiKey: this._authInfo?.apiKey,
          baseURL: this._authInfo?.apiUrl
        }
      );
    }
    setTimeout(() => {
      const chat_response = this._updateChatMessages(
        this._getMessagesNumberOfTokens(),
        0
      );
      this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
    }, 2000);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    // set options for the webview, allow scripts
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    // set the HTML for the webview
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // add an event listener for messages received by the webview
    webviewView.webview.onDidReceiveMessage(async data => {
      switch (data.type) {
        case 'ready':
          {
            const config = vscode.workspace.getConfiguration('devmate');
            let providers: Provider[] = config.get('providers') || [];
            let prompts: Prompt[] = config.get('prompts') || [];
            this.set_providers(providers);
            this.set_prompts(prompts);
            break;
          }
        case 'codeSelected':
          {
            // Handle structured code blocks from chat first; otherwise keep the paste behavior
            const code = String(data.value || '');
            const searchReplacePath = typeof data.searchReplacePath === 'string' ? data.searchReplacePath : undefined;
            const addFilePath = typeof data.addFilePath === 'string' ? data.addFilePath : undefined;
            if (addFilePath) {
              await this.handleAddFileBlockClick(addFilePath);
              break;
            }
            if (searchReplacePath || this.isLikelyDiffContent(code)) {
              const choice = await vscode.window.showInformationMessage(
                'Detected patch content from chat. Do you want to apply this patch to the workspace?',
                { modal: true },
                'Apply Patch',
                'Insert as Text',
                'Cancel'
              );
              if (choice === 'Apply Patch') {
                const patchText = searchReplacePath
                  ? `\`\`\`search-replace:${searchReplacePath}\n${code}\n\`\`\``
                  : code;
                const res = await this.applyPatchText(patchText);
                if (res.success) {
                  vscode.window.showInformationMessage(`Patch applied: ${res.details}`);
                } else {
                  vscode.window.showErrorMessage(`Patch failed: ${res.details}`);
                }
                break;
              } else if (choice === 'Insert as Text') {
                const snippet = new vscode.SnippetString();
                snippet.appendText(code);
                vscode.window.activeTextEditor?.insertSnippet(snippet);
                break;
              } else {
                // Cancel
                break;
              }
            }
            // Non-diff: keep existing "paste on click" behavior
            if (!this._settings.pasteOnClick) {
              break;
            }
            const snippet = new vscode.SnippetString();
            snippet.appendText(code);
            vscode.window.activeTextEditor?.insertSnippet(snippet);
            break;
          }
        case 'pasteImage':
          {
            const base64Data = data.value;
            const imageType = base64Data.substring(base64Data.indexOf(':') + 1, base64Data.indexOf(';'));
            const fileType = imageType.split('/')[1];
            const fileName = `clipboard_image.${fileType}`;
            this.addImageToChat(base64Data, fileName);
            break;
          }
        case 'prompt':
          {
            console.log("prompt");
            this.search(data.value);
            break;
          }
        case 'promptNoQuery':
          {
            console.log("promptNoQuery");

            let searchPrompt = await this._generate_search_prompt(data.value);

            this._messages?.push({ role: "user", content: searchPrompt, selected: true })
            let chat_response = this._updateChatMessages(
              this._getMessagesNumberOfTokens(),
              0
            );
            this._response = chat_response;
            this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
            break;
          }
        case 'checkboxChanged':
          {
            console.log("checkboxChanged:", data);
            const idParts = data.id.split('-'); // Split the id into parts
            if (idParts.length === 3) {
              const indexStr = idParts[2]; // Grab the last part, which should contain the index
              const index = parseInt(indexStr, 10); // Convert the index to an integer and adjust if necessary

              if (this._messages && index >= 0 && index < this._messages.length) {
                // If the index is within the bounds of the array, update the checked status
                this._messages[index].selected = data.checked;
              } else {
                // Handle cases where index is out of bounds or _messages is not an array
                console.error('Index is out of bounds or _messages is not properly defined.');
              }
            } else {
              // Handle cases where data.id does not follow the expected format
              console.error('data.id is not in the expected format.');
            }
            break;
          }
        case 'messageContentChanged':
          {
            console.log("messageContentChanged:", data);
            const idParts = data.id.split('-'); // Split the id into parts
            if (idParts.length === 3) {
              const indexStr = idParts[2]; // Grab the last part, which should contain the index
              const index = parseInt(indexStr, 10); // Convert the index to an integer and adjust if necessary

              if (this._messages && index >= 0 && index < this._messages.length) {
                // If the index is within the bounds of the array, update the checked status
                this._messages[index].content = data.value;
              } else {
                // Handle cases where index is out of bounds or _messages is not an array
                console.error('Index is out of bounds or _messages is not properly defined.');
              }
            } else {
              // Handle cases where data.id does not follow the expected format
              console.error('data.id is not in the expected format.');
            }
            console.log("messages:", this._messages);
            break;
          }
        case 'collapseChanged':
          {
            // Persist collapsed state changes from the webview so YAML export reflects it
            const index = Number(data.index);
            const collapsed = !!data.collapsed;
            if (Number.isInteger(index) && this._messages && index >= 0 && index < this._messages.length) {
              (this._messages[index] as any).collapsed = collapsed;
            } else {
              console.error(
                'collapseChanged: Index out of bounds or _messages undefined.',
                { index, hasMessages: !!this._messages, length: this._messages?.length }
              );
            }
            // No need to re-render; the webview already updated its UI.
            break;
          }
        case 'toggleMoveRefToEnd':
          {
            const index = Number(data.index);
            const checked = !!data.checked;
            if (Number.isInteger(index) && this._messages && index >= 0 && index < this._messages.length) {
              (this._messages[index] as any).moveToEnd = checked;
            } else {
              console.error('toggleMoveRefToEnd: Index is out of bounds or _messages undefined.');
            }
            break;
          }
        case 'codeBlockSelectionChanged':
          {
            const index = Number(data.index);
            const codeBlockIndex = Number(data.codeBlockIndex);
            const checked = !!data.checked;
            if (
              Number.isInteger(index)
              && Number.isInteger(codeBlockIndex)
              && this._messages
              && index >= 0
              && index < this._messages.length
            ) {
              const message: any = this._messages[index];
              const nextSelections = Array.isArray(message.codeBlockSelections) ? [...message.codeBlockSelections] : [];
              for (let i = 0; i < codeBlockIndex; i++) {
                if (typeof nextSelections[i] !== 'boolean') nextSelections[i] = false;
              }
              nextSelections[codeBlockIndex] = checked;
              message.codeBlockSelections = this.normalizeCodeBlockSelections(nextSelections);
            } else {
              console.error('codeBlockSelectionChanged: Index is out of bounds or invalid.');
            }
            break;
          }
          case "providerModelChanged":
          {
            const providerIndex = data.providerIndex;
            const modelIndex = data.modelIndex;
            console.log("Provider Changed, providerIndex:", providerIndex, ", model:", modelIndex);

            const config = vscode.workspace.getConfiguration('devmate');
            let providers: Provider[] = config.get('providers') || [];

            if (providers && providers.length > providerIndex) {
              const provider_data = providers[providerIndex];
              if (provider_data.models && provider_data.models.length > modelIndex) {
                const model_data = provider_data.models[modelIndex];
                const apiType = (model_data as any).api || 'chatCompletions';
                // Choose base URL according to apiType, with sensible fallbacks
                let selectedApiUrl = provider_data.apiUrl;
                if (apiType === 'responses') {
                  selectedApiUrl = provider_data.responsesUrl || provider_data.apiUrl;
                } else {
                  selectedApiUrl = provider_data.chatCompletionsUrl || provider_data.apiUrl;
                }
                const provider_settings = {
                  model: model_data.model_name,
                  apiUrl: selectedApiUrl,
                  apiKey: provider_data.apiKey,
                  apiType,
                  reasoningOutputDeltaPath: (model_data as any).reasoning_output_delta_path,
                  options: {
                    ...model_data.options, // assuming model_data contains options and it includes maxModelTokens, maxResponseTokens, and temperature
                    // If tools are configured at model level, pass them via options for Responses API usage
                    ...((model_data as any).tools ? { tools: (model_data as any).tools } : {})
                  },
                };
                this.setSettings({
                  apiUrl: provider_settings.apiUrl,
                  model: provider_settings.model,
                  apiType: provider_settings.apiType,
                  reasoningOutputDeltaPath: provider_settings.reasoningOutputDeltaPath,
                  options: {
                    ...provider_settings.options, // Spread operator to include all keys from options
                  },
                });
                // Put configuration settings into the provider
                this.setAuthenticationInfo({
                  apiKey: provider_settings.apiKey,
                  apiUrl: provider_settings.apiUrl
                });
              }
            }
            break;
          }
        case "systemPromptChanged":
          {
            const systemPromptIndex = data.systemPromptIndex;
            console.log("systemPrompt Changed, providerIndex:", systemPromptIndex);

            const config = vscode.workspace.getConfiguration('devmate');
            let prompts: Prompt[] = config.get('prompts') || [];

            if (prompts && prompts.length > systemPromptIndex) {
              const prompt_data = prompts[systemPromptIndex];
              if (prompt_data.name && prompt_data.prompt) {
                this.set_prompt(prompt_data);
              }
            }
            break;
          }
        case 'forceFinalizePartial': {
          // Webview detected a stalled stream and is sending us the buffered text
          try {
            const partial = typeof data.value === 'string' ? data.value : '';
            // Ensure UI streaming state is cleared
            this._view?.webview.postMessage({ type: 'streamEnd' });
            if (partial) {
              this._messages?.push({ role: "assistant", content: partial, selected: true });
              const chat_response = this._updateChatMessages(0, 0);
              this._response = chat_response;
              this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
            }
          } catch (e) {
            console.warn('forceFinalizePartial handling failed:', e);
            this._view?.webview.postMessage({ type: 'addResponse', value: '[WARN] Could not finalize partial output.' });
          }
          break;
        }
        case 'fileClicked': {
          console.log("file Clicked!!!!!");
          const filePath = data.value; // e.g., 'src/extension.ts' (relative to workspace)
          if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open.');
            break;
          }
          const workspaceFolder = vscode.workspace.workspaceFolders[0];
          const absolutePath = path.join(workspaceFolder.uri.fsPath, filePath);
          try {
            const fileContent = fs.readFileSync(absolutePath, 'utf-8');
            const fileExt = path.extname(filePath).slice(1) || '';
            // New behavior: if this looks like a diff/patch, ask to apply it
            if (this.isLikelyDiffPath(filePath) || this.isLikelyDiffContent(fileContent)) {
              const choice = await vscode.window.showInformationMessage(
                `Detected diff file: ${filePath}. Do you want to apply this patch to the workspace?`,
                { modal: true },
                'Apply Patch',
                'Open Only',
                'Cancel'
              );
              if (choice === 'Apply Patch') {
                const res = await this.applyPatchText(fileContent);
                if (res.success) {
                  vscode.window.showInformationMessage(`Patch applied: ${res.details}`);
                } else {
                  vscode.window.showErrorMessage(`Patch failed: ${res.details}`);
                }
                // Also append the diff content to chat for auditing
                this.addFileToChat(filePath, fileContent, fileExt);
              } else if (choice === 'Open Only') {
                this.addFileToChat(filePath, fileContent, fileExt);
              } else {
                // Cancel: do nothing
              }
              break;
            }
            // Non-diff files keep existing behavior
            this.addFileToChat(filePath, fileContent, fileExt);
          } catch (e) {
            vscode.window.showErrorMessage(`Could not read file: ${filePath} (${e instanceof Error ? e.message : String(e)})`);
          }
          break;
        }
      }
    });
  }

  public getStartSystemPrompt() {
    const config = vscode.workspace.getConfiguration('devmate');
    let prompts: Prompt[] = config.get('prompts') || [];
    let start_system_prompt = "You are a helpful assistant.";
    if (prompts && prompts.length > 0) {
      const prompt_data = prompts[0];
      if (prompt_data.name && prompt_data.prompt) {
        start_system_prompt = prompt_data.prompt;
      }
    }
    return start_system_prompt;
  }


  public async resetConversation() {
    console.log(this, this._conversation);
    if (this._conversation) {
      this._conversation = null;
    }
    this._prompt = '';
    this._response = '';
    this._fullPrompt = '';
    this._totalNumberOfTokens = 0;
    this._lastUsedTokens = 0;
    this._lastPromptTokens = 0;
    this._lastCompletionTokens = 0;
    this._lastRequestCost = 0;
    this._sessionCostTotals = {
      requestCount: 0,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      inputAudioTokens: 0,
      outputAudioTokens: 0
    };
    this._view?.webview.postMessage({ type: 'setPrompt', value: '' });
    this._messages = [];

    this._messages?.push({ role: "system", content: this.getStartSystemPrompt(), selected: true });
    const chat_response = this._updateChatMessages(
      this._getMessagesNumberOfTokens(),
      0
    );
    this._view?.webview.postMessage({ type: 'resetCollapseState' });
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
  }

  public async pasteChat() {
    console.log("pasteChat");

    // Ensure there is an active text editor where we can paste the YAML
    if (!vscode.window.activeTextEditor) {
      vscode.window.showErrorMessage('No active text editor!');
      return;
    }

    try {
      // Get the original _messages object
      // If you want to exclude any other properties from the YAML, you can map and remove them here
      const messagesForYaml = this._messages?.map((m) => {
        const { role, content, selected, collapsed } = m as any;
        const out: any = { role, content, selected, collapsed: !!collapsed };
        if ((m as any).moveToEnd) out.moveToEnd = true;
        const codeBlockSelections = this.normalizeCodeBlockSelections((m as any).codeBlockSelections);
        if (codeBlockSelections.length) out.codeBlockSelections = codeBlockSelections;
        return out;
      });

      // Convert messages to a YAML string
      const messagesYaml = yaml.dump(messagesForYaml, { noRefs: true, lineWidth: -1 });

      // Create a new snippet and append the YAML string
      const snippet = new vscode.SnippetString();
      snippet.appendText(messagesYaml);

      // Insert the snippet into the active text editor
      await vscode.window.activeTextEditor.insertSnippet(snippet);

      console.log("Chat pasted as YAML successfully.");
    } catch (error) {
      console.error("Failed to paste chat as YAML:", error);
      vscode.window.showErrorMessage('Failed to paste chat as YAML: ' + error);
    }
  }

  public async useSelectionAsChat() {
    console.log("use selection as chat");

    // Ensure there is an active text editor with a selection
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage('No active text editor with a selection!');
      return;
    }

    const selection = activeEditor.selection;
    if (selection.isEmpty) {
      vscode.window.showErrorMessage('No text selected!');
      return;
    }

    // Get the selected text
    const selectedText = activeEditor.document.getText(selection);

    try {
      // Parse the selected text as YAML
      const parsedMessages = yaml.load(selectedText);

      // Validate the parsed YAML structure
      if (!Array.isArray(parsedMessages)) {
        throw new Error('Selected text is not an array of messages.');
      }

      // Validation of each message in the array
      for (const msg of parsedMessages) {
        if (typeof msg !== 'object' || !('role' in msg) || !('content' in msg) || !('selected' in msg)) {
          throw new Error('Invalid message format. Each message must have role, content, and selected properties.');
        }
      }

      // Normalize messages and default collapsed=false if missing
      const normalized = parsedMessages.map((msg: any) => {
        const collapsed = ('collapsed' in msg) ? !!msg.collapsed : false;
        const moveToEnd = ('moveToEnd' in msg) ? !!msg.moveToEnd : false;
        const codeBlockSelections = this.normalizeCodeBlockSelections((msg as any).codeBlockSelections);
        return { ...msg, collapsed, moveToEnd, codeBlockSelections };
      });

      // If valid, update the _messages array with new data
      this._messages = normalized;

      // Update the webview visualization
      const chat_response = this._updateChatMessages(
        this._getMessagesNumberOfTokens(),
        0
      );
      this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });

      console.log("Updated messages from selection successfully.");
    } catch (error) {
      console.error("Failed to use selection as chat:", error);
      vscode.window.showErrorMessage('Failed to use selection as chat: ' + error);
    }
  }

  public async appendSelectionAsChat() {
    console.log("append selection as chat");

    // Ensure there is an active text editor with a selection
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage('No active text editor with a selection!');
      return;
    }

    const selection = activeEditor.selection;
    if (selection.isEmpty) {
      vscode.window.showErrorMessage('No text selected!');
      return;
    }

    // Get the selected text
    const selectedText = activeEditor.document.getText(selection);

    try {
      // Parse the selected text as YAML
      const parsedMessages = yaml.load(selectedText);

      // Validate the parsed YAML structure
      if (!Array.isArray(parsedMessages)) {
        throw new Error('Selected text is not an array of messages.');
      }

      // Normalize and validate messages; default selected=true if missing
      const normalizedMessages: Message[] = parsedMessages.map((msg: any) => {
        if (typeof msg !== 'object' || !('role' in msg) || !('content' in msg)) {
          throw new Error('Invalid message format. Each message must have role and content properties.');
        }
        const selected = ('selected' in msg) ? !!msg.selected : true;
        const collapsed = ('collapsed' in msg) ? !!msg.collapsed : false;
        const moveToEnd = ('moveToEnd' in msg) ? !!msg.moveToEnd : false;
        const codeBlockSelections = this.normalizeCodeBlockSelections((msg as any).codeBlockSelections);
        return { ...msg, selected, collapsed, moveToEnd, codeBlockSelections } as Message;
      });

      // Append to the existing _messages
      if (!this._messages) this._messages = [];
      this._messages.push(...normalizedMessages);

      // Update the webview visualization
      const chat_response = this._updateChatMessages(
        this._getMessagesNumberOfTokens(),
        0
      );
      this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
    } catch (error) {
      console.error("Failed to append selection as chat:", error);
      vscode.window.showErrorMessage('Failed to append selection as chat: ' + error);
    }
  }

  public importMessages(messages: Message[], mode: 'replace' | 'append' = 'replace') {
    const normalized = messages.map((msg: any) => {
      const selected = ('selected' in msg) ? !!msg.selected : true;
      const collapsed = ('collapsed' in msg) ? !!msg.collapsed : false;
      const moveToEnd = ('moveToEnd' in msg) ? !!msg.moveToEnd : false;
      const codeBlockSelections = this.normalizeCodeBlockSelections((msg as any).codeBlockSelections);
      return { ...msg, selected, collapsed, moveToEnd, codeBlockSelections } as Message;
    });

    if (mode === 'append') {
      if (!this._messages) this._messages = [];
      this._messages.push(...normalized);
    } else {
      this._messages = normalized;
    }

    const chat_response = this._updateChatMessages(
      this._getMessagesNumberOfTokens(),
      0
    );
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
  }

  public async appendSelectionMarkdownAsChat() {
    console.log("append markdown selection as chat");

    // Ensure there is an active text editor with a selection
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage('No active text editor with a selection!');
      return;
    }

    const selection = activeEditor.selection;
    if (selection.isEmpty) {
      vscode.window.showErrorMessage('No text selected!');
      return;
    }

    // Get the selected markdown text
    const selectedText = activeEditor.document.getText(selection);

    try {
      // Split markdown by images, capturing text and image segments
      type Part = { type: 'text', text: string } | { type: 'image', url: string, alt: string };
      const parts: Part[] = [];
      const md = selectedText;
      const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = imgRe.exec(md)) !== null) {
        const before = md.slice(lastIndex, m.index);
        if (before && before.trim().length > 0) {
          parts.push({ type: 'text', text: before });
        }
        // m[1] = alt text, m[2] = inside () which can be: url [optional title]
        let inside = (m[2] || '').trim();
        // Remove enclosing angle brackets if present
        if (inside.startsWith('<') && inside.includes('>')) {
          inside = inside.slice(1, inside.indexOf('>'));
        }
        // Extract URL (first token before whitespace), strip quotes if any
        let url = inside.split(/\s+/)[0] || '';
        url = url.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        const alt = (m[1] || '').trim();
        if (url) parts.push({ type: 'image', url, alt });
        lastIndex = m.index + m[0].length;
      }
      const tail = md.slice(lastIndex);
      if (tail && tail.trim().length > 0) {
        parts.push({ type: 'text', text: tail });
      }

      if (!this._messages) this._messages = [];

      for (const p of parts) {
        if (p.type === 'text') {
          const content = `\`\`\`markdown\n${p.text}\n\`\`\``;
          const newMessage: UserMessage = { role: "user", content, selected: true };
          this._messages.push(newMessage);
        } else {
          const url = p.url;
          const alt = p.alt || 'image';
          let fileName = alt;
          // Derive a filename for display
          const mData = url.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/i);
          if (mData) {
            const ext = mData[1] || 'png';
            fileName = `${alt || 'image'}.${ext}`;
          } else {
            try {
              const u = new URL(url);
              const base = (u.pathname || '').split('/').filter(Boolean).pop() || '';
              if (base) fileName = base;
            } catch { /* ignore URL parse errors */ }
          }
          const newMessage: UserMessage = {
            role: "user",
            content: [
              { type: "text", text: `${fileName}:` },
              { type: "image_url", image_url: { url } }
            ] as any,
            selected: true
          };
          this._messages.push(newMessage);
        }
      }

      // Update the webview visualization once
      const chat_response = this._updateChatMessages(this._getMessagesNumberOfTokens(), 0);
      this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
    } catch (error) {
      console.error("Failed to append markdown selection as chat:", error);
      vscode.window.showErrorMessage('Failed to append markdown selection as chat: ' + error);
    }
  }

  public fixCodeBlocks(response: string) {
    // Use a regular expression to find all occurrences of the substring in the string
    const REGEX_CODEBLOCK = new RegExp('\`\`\`', 'g');
    const matches = response.match(REGEX_CODEBLOCK);

    // Return the number of occurrences of the substring in the response, check if even
    const count = matches ? matches.length : 0;
    if (count % 2 === 0) {
      return response;
    } else {
      // else append ``` to the end to make the last code block complete
      console.log("Warning - code block not complete");
      return response.concat('\n\`\`\`');
    }

  }

  private normalizeCodeBlockSelections(value: any): boolean[] {
    if (!Array.isArray(value)) return [];
    return Array.from({ length: value.length }, (_unused, index) => !!value[index]);
  }

  private buildCodeBlockReferenceSummary(infoString: string, bodyLines: string[], codeBlockIndex: number): string {
    const label = infoString.trim() || 'text';
    const normalizedBodyLines = [...bodyLines];
    while (normalizedBodyLines.length > 0 && normalizedBodyLines[normalizedBodyLines.length - 1] === '') {
      normalizedBodyLines.pop();
    }
    const previewLines = normalizedBodyLines.slice(0, 3);
    const hasMore = normalizedBodyLines.length > previewLines.length;
    const omittedCount = Math.max(normalizedBodyLines.length - previewLines.length, 0);
    const summaryLines = [
      `[Code block reference #${codeBlockIndex + 1}; type: ${label}; ${normalizedBodyLines.length} line(s)]`,
      `\`\`\`${label}`,
      ...previewLines,
      ...(hasMore ? ['...'] : []),
      '\`\`\`'
    ];
    if (hasMore) {
      summaryLines.push(`[${omittedCount} more line(s) omitted from this request; full block remains visible in chat.]`);
    }
    return summaryLines.join('\n');
  }

  private summarizeSelectedCodeBlocksInString(
    input: string,
    selections: boolean[],
    startIndex = 0
  ): { text: string; nextIndex: number } {
    if (!input) return { text: input, nextIndex: startIndex };
    if (!Array.isArray(selections) || !selections.some(Boolean)) {
      return { text: input, nextIndex: startIndex };
    }

    const lines = input.replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let fenceInfo = '';
    let openLine = '';
    let fenceBody: string[] = [];
    let blockIndex = startIndex;

    const flushFence = (closeLine: string) => {
      if (selections[blockIndex]) {
        out.push(this.buildCodeBlockReferenceSummary(fenceInfo, fenceBody, blockIndex));
      } else {
        out.push(openLine);
        out.push(...fenceBody);
        out.push(closeLine);
      }
      blockIndex++;
      inFence = false;
      fenceChar = '';
      fenceLen = 0;
      fenceInfo = '';
      openLine = '';
      fenceBody = [];
    };

    for (const line of lines) {
      if (!inFence) {
        const open = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (!open) {
          out.push(line);
          continue;
        }
        inFence = true;
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        fenceInfo = (open[2] || '').trim();
        openLine = line;
        fenceBody = [];
        continue;
      }

      const closeRe = new RegExp('^\\s*' + fenceChar + '{' + fenceLen + ',}\\s*$');
      if (closeRe.test(line)) {
        flushFence(line);
        continue;
      }
      fenceBody.push(line);
    }

    if (inFence) {
      if (selections[blockIndex]) {
        out.push(this.buildCodeBlockReferenceSummary(fenceInfo, fenceBody, blockIndex));
      } else {
        out.push(openLine);
        out.push(...fenceBody);
      }
      blockIndex++;
    }

    return { text: out.join('\n'), nextIndex: blockIndex };
  }

  private applyCodeBlockSelectionsToMessages(msgs: ReadonlyArray<Message>): Message[] {
    return msgs.map((msg) => {
      const selections = this.normalizeCodeBlockSelections((msg as any).codeBlockSelections);
      if (!selections.length || !selections.some(Boolean)) {
        return msg;
      }

      if (typeof msg.content === 'string') {
        const summarized = this.summarizeSelectedCodeBlocksInString(msg.content, selections).text;
        return { ...msg, content: summarized } as Message;
      }

      if (Array.isArray(msg.content)) {
        let blockIndex = 0;
        const newParts = msg.content.map((part) => {
          if (this.isChatCompletionContentPartText(part)) {
            const result = this.summarizeSelectedCodeBlocksInString(part.text, selections, blockIndex);
            blockIndex = result.nextIndex;
            return { ...part, text: result.text };
          }
          return part;
        });
        return { ...msg, content: newParts } as Message;
      }

      return msg;
    });
  }

  private _messageContentToTokenString(content: any): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map((part) => {
        if (this.isChatCompletionContentPartText(part)) {
          return part.text;
        }
        if (this.isChatCompletionContentPartImage(part)) {
          return `[image:${part.image_url.url}]`;
        }
        return this.safeStringify(part, 500);
      }).join('\n');
    }

    return this.safeStringify(content, 1000);
  }

  private _getMessagesNumberOfTokens(_messages?: ReadonlyArray<Message>) {
    return 0;
  }

  private _toNumber(value: any): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  private _hasPricingConfigured(): boolean {
    const pricing = this._settings.pricing;
    if (!pricing) return false;
    return [
      pricing.input,
      pricing.output,
      pricing.cached_input,
      pricing.cache_write,
      pricing.cache_read,
      pricing.reasoning,
      pricing.input_audio,
      pricing.output_audio
    ].some(value => typeof value === 'number' && Number.isFinite(value));
  }

  private _ratePerToken(value?: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return this._settings.pricing?.unit === 'per_token' ? value : value / 1_000_000;
  }

  private _getCurrency(): string {
    return this._settings.pricing?.currency || 'USD';
  }

  private _getPromptTokensFromUsage(usage: TokenUsage): number {
    return this._toNumber(usage.inputTokens)
      + this._toNumber(usage.cachedInputTokens)
      + this._toNumber(usage.cacheWriteTokens)
      + this._toNumber(usage.cacheReadTokens)
      + this._toNumber(usage.inputAudioTokens);
  }

  private _getCompletionTokensFromUsage(usage: TokenUsage): number {
    return this._toNumber(usage.outputTokens)
      + this._toNumber(usage.reasoningTokens)
      + this._toNumber(usage.outputAudioTokens);
  }

  private _getRequestTotalTokensFromUsage(usage: TokenUsage): number {
    const reportedTotal = this._toNumber(usage.totalTokens);
    if (reportedTotal > 0) return reportedTotal;
    return this._getPromptTokensFromUsage(usage) + this._getCompletionTokensFromUsage(usage);
  }

  private _setLastRequestTokenUsage(usage: TokenUsage | null): void {
    if (!usage) {
      this._lastPromptTokens = 0;
      this._lastCompletionTokens = 0;
      this._lastUsedTokens = 0;
      return;
    }

    this._lastPromptTokens = this._getPromptTokensFromUsage(usage);
    this._lastCompletionTokens = this._getCompletionTokensFromUsage(usage);
    this._lastUsedTokens = this._getRequestTotalTokensFromUsage(usage);
  }

  private _extractResponsesTokenUsage(usage: any): TokenUsage | null {
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = this._toNumber(usage.input_tokens);
    const cachedInputTokens = this._toNumber(
      usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens
    );
    const outputTokens = this._toNumber(usage.output_tokens);
    const reasoningTokens = this._toNumber(
      usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens
    );
    const inputAudioTokens = this._toNumber(
      usage.input_tokens_details?.audio_tokens ?? usage.prompt_tokens_details?.audio_tokens
    );
    const outputAudioTokens = this._toNumber(
      usage.output_tokens_details?.audio_tokens ?? usage.completion_tokens_details?.audio_tokens
    );

    // Many providers (e.g., OpenRouter) report cost in USD in the usage object.
    const providerCost = typeof usage.cost === 'number' ? usage.cost : undefined;

    return {
      inputTokens: Math.max(inputTokens - cachedInputTokens, 0),
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      inputAudioTokens,
      outputAudioTokens,
      totalTokens: this._toNumber(usage.total_tokens) || undefined,
      costUSD: providerCost
    };
  }

  private _extractChatCompletionTokenUsage(usage: any): TokenUsage | null {
    if (!usage || typeof usage !== 'object') return null;
    const promptTokens = this._toNumber(usage.prompt_tokens);
    const cachedTokens = this._toNumber(usage.prompt_tokens_details?.cached_tokens);
    const cacheWriteTokens = this._toNumber(usage.prompt_tokens_details?.cache_write_tokens);
    const outputTokens = this._toNumber(usage.completion_tokens);
    const reasoningTokens = this._toNumber(usage.completion_tokens_details?.reasoning_tokens);
    const inputAudioTokens = this._toNumber(usage.prompt_tokens_details?.audio_tokens);
    const outputAudioTokens = this._toNumber(usage.completion_tokens_details?.audio_tokens);
    const hasExplicitCachePricing = Object.prototype.hasOwnProperty.call(usage.prompt_tokens_details || {}, 'cache_write_tokens');

    // Many providers (e.g., OpenRouter) report authoritative cost in USD in the usage object.
    const providerCost = typeof usage.cost === 'number' ? usage.cost : undefined;

    return {
      inputTokens: Math.max(promptTokens - cachedTokens - cacheWriteTokens, 0),
      cachedInputTokens: hasExplicitCachePricing ? 0 : cachedTokens,
      cacheReadTokens: hasExplicitCachePricing ? cachedTokens : 0,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      inputAudioTokens,
      outputAudioTokens,
      totalTokens: this._toNumber(usage.total_tokens) || undefined,
      costUSD: providerCost
    };
  }

  private _extractGeminiTokenUsage(usageMetadata: any): TokenUsage | null {
    if (!usageMetadata || typeof usageMetadata !== 'object') return null;
    const promptTokenCount = this._toNumber(usageMetadata.promptTokenCount);
    const cachedContentTokenCount = this._toNumber(usageMetadata.cachedContentTokenCount);
    const toolUsePromptTokenCount = this._toNumber(usageMetadata.toolUsePromptTokenCount);
    const candidatesTokenCount = this._toNumber(usageMetadata.candidatesTokenCount);
    const thoughtsTokenCount = this._toNumber(usageMetadata.thoughtsTokenCount);

    // Gemini does not currently expose per-request cost directly; fall back to configured pricing.
    return {
      inputTokens: Math.max(promptTokenCount - cachedContentTokenCount, 0) + toolUsePromptTokenCount,
      cachedInputTokens: cachedContentTokenCount,
      outputTokens: candidatesTokenCount,
      reasoningTokens: thoughtsTokenCount,
      totalTokens: this._toNumber(usageMetadata.totalTokenCount) || undefined
    };
  }

  private _extractAnthropicTokenUsage(usage: any): TokenUsage | null {
    if (!usage || typeof usage !== 'object') return null;
    return {
      inputTokens: this._toNumber(usage.input_tokens),
      cacheWriteTokens: this._toNumber(usage.cache_creation_input_tokens),
      cacheReadTokens: this._toNumber(usage.cache_read_input_tokens),
      outputTokens: this._toNumber(usage.output_tokens)
    };
  }

  private _extractOllamaNativeTokenUsage(payload: any): TokenUsage | null {
    if (!payload || typeof payload !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(payload, 'prompt_eval_count') && !Object.prototype.hasOwnProperty.call(payload, 'eval_count')) {
      return null;
    }

    const inputTokens = this._toNumber(payload.prompt_eval_count);
    const outputTokens = this._toNumber(payload.eval_count);

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    };
  }

  private _extractTokenUsage(payload: any): TokenUsage | null {
    if (!payload || typeof payload !== 'object') return null;

    if (payload.usageMetadata) {
      return this._extractGeminiTokenUsage(payload.usageMetadata);
    }

    const usage = payload.usage || payload.message?.usage || payload.response?.usage || payload;
    if (usage && typeof usage === 'object') {
      if (
        Object.prototype.hasOwnProperty.call(usage, 'cache_creation_input_tokens')
        || Object.prototype.hasOwnProperty.call(usage, 'cache_read_input_tokens')
      ) {
        return this._extractAnthropicTokenUsage(usage);
      }

      if (
        Object.prototype.hasOwnProperty.call(usage, 'input_tokens')
        || Object.prototype.hasOwnProperty.call(usage, 'output_tokens')
      ) {
        return this._extractResponsesTokenUsage(usage);
      }

      if (
        Object.prototype.hasOwnProperty.call(usage, 'prompt_tokens')
        || Object.prototype.hasOwnProperty.call(usage, 'completion_tokens')
      ) {
        return this._extractChatCompletionTokenUsage(usage);
      }
    }

    return this._extractOllamaNativeTokenUsage(payload);
  }

  private _calculateRequestCost(usage: TokenUsage | null): number {
    if (!usage) return 0;

    // If provider reported explicit cost (e.g., OpenRouter), use it as authoritative.
    // This accounts for tiered pricing, BYOK, cache discounts, and provider-specific rates.
    if (typeof usage.costUSD === 'number' && Number.isFinite(usage.costUSD)) {
      return usage.costUSD;
    }

    // Fall back to token-based calculation using configured pricing.
    if (!this._hasPricingConfigured()) return 0;

    const pricing: ModelPricing = this._settings.pricing || {};
    const inputTokens = this._toNumber(usage.inputTokens);
    const cachedInputTokens = this._toNumber(usage.cachedInputTokens);
    const cacheWriteTokens = this._toNumber(usage.cacheWriteTokens);
    const cacheReadTokens = this._toNumber(usage.cacheReadTokens);
    const reasoningTokens = this._toNumber(usage.reasoningTokens);
    const inputAudioTokens = this._toNumber(usage.inputAudioTokens);
    const outputAudioTokens = this._toNumber(usage.outputAudioTokens);

    let outputTokens = this._toNumber(usage.outputTokens);
    if (typeof pricing.reasoning === 'number' && Number.isFinite(pricing.reasoning)) {
      outputTokens = Math.max(outputTokens - reasoningTokens, 0);
    }

    let total = 0;
    total += inputTokens * this._ratePerToken(pricing.input);
    total += cachedInputTokens * this._ratePerToken(pricing.cached_input ?? pricing.cache_read ?? pricing.input);
    total += cacheReadTokens * this._ratePerToken(pricing.cache_read ?? pricing.cached_input ?? pricing.input);
    total += cacheWriteTokens * this._ratePerToken(pricing.cache_write ?? pricing.input);
    total += outputTokens * this._ratePerToken(pricing.output);
    total += reasoningTokens * this._ratePerToken(pricing.reasoning ?? pricing.output);
    total += inputAudioTokens * this._ratePerToken(pricing.input_audio ?? pricing.input);
    total += outputAudioTokens * this._ratePerToken(pricing.output_audio ?? pricing.output);

    return total;
  }

  private _addRequestUsageToSession(usage: TokenUsage, cost: number): void {
    this._sessionCostTotals.requestCount += 1;
    this._sessionCostTotals.totalCost += cost;
    this._totalNumberOfTokens += this._getRequestTotalTokensFromUsage(usage);
    this._sessionCostTotals.inputTokens += this._toNumber(usage.inputTokens);
    this._sessionCostTotals.outputTokens += this._toNumber(usage.outputTokens);
    this._sessionCostTotals.cachedInputTokens += this._toNumber(usage.cachedInputTokens);
    this._sessionCostTotals.cacheWriteTokens += this._toNumber(usage.cacheWriteTokens);
    this._sessionCostTotals.cacheReadTokens += this._toNumber(usage.cacheReadTokens);
    this._sessionCostTotals.reasoningTokens += this._toNumber(usage.reasoningTokens);
    this._sessionCostTotals.inputAudioTokens += this._toNumber(usage.inputAudioTokens);
    this._sessionCostTotals.outputAudioTokens += this._toNumber(usage.outputAudioTokens);
  }

  private _postStats(_promptTokens?: number, _completionTokens?: number): void {
    this._view?.webview.postMessage({
      type: 'updateStats',
      value: {
        totalTokens: this._totalNumberOfTokens,
        usedTokens: this._lastUsedTokens,
        promptTokens: this._lastPromptTokens,
        completionTokens: this._lastCompletionTokens,
        model: this._settings.model,
        sessionCost: this._sessionCostTotals.totalCost,
        lastRequestCost: this._lastRequestCost,
        requestCount: this._sessionCostTotals.requestCount,
        currency: this._getCurrency(),
        pricingConfigured: this._hasPricingConfigured()
      }
    });
  }

  public getSelectedMessagesWithoutSelectedProperty(): Omit<Message, 'selected'>[] {
    let ret = this._messages?.filter(message => message.selected).map(({ role, content }) => ({
      role, content
    })) || [];
    return ret;
  }

  private _containsCodeBlockOrListItems(content: string): boolean {
    // Regex pattern to match code blocks.
    const codeBlockPattern = /```[\s\S]*?```/;

    // Regex pattern to match bullet points or numbered list items.
    const listItemPattern = /^(?:\s*(?:[-*+]|\d+\.)\s+.+)$/m;

    // Test if the content contains a code block or list items.
    return codeBlockPattern.test(content) || listItemPattern.test(content);
  }


  private isChatCompletionContentPart(value: any): value is ChatCompletionContentPart {
    return this.isChatCompletionContentPartImage(value);
  }


  private isChatCompletionContentPartText(value: any): value is ChatCompletionContentPartText {
    return typeof value === 'object'
      && value != null
      && typeof value.text === 'string'
      && value.type === 'text';
  }
  private isChatCompletionContentPartImage(value: any): value is ChatCompletionContentPartImage {
    return typeof value === 'object'
      && value !== null
      && typeof value.image_url === 'object'
      && typeof value.image_url.url === 'string'
      && value.type === 'image_url';
  }

  private _updateChatMessages(promtNumberOfTokens: number, completionTokens: number) {
    let chat_response = "";
    if (this._messages) {
      this._messages.forEach((message, index) => {
        const selected = message.selected;
        const checked_string = selected ? "checked" : "";
        if (typeof message.content === 'string') {
          if (this._containsCodeBlockOrListItems(message.content)) {
            chat_response +=
              "\n### <u> <input id='message-checkbox-" + index + "' type='checkbox' " + checked_string + " onchange='myFunction(this)'> " +
              message.role.toUpperCase() + "</u>:\n" + message.content;
          } else {
            chat_response +=
              "\n### <u> <input id='message-checkbox-" + index + "' type='checkbox' " + checked_string + " onchange='myFunction(this)'> " +
              message.role.toUpperCase() + "</u>:\n" +
              "<div id='message-content-" + index + "' contenteditable='false' onclick='makeEditable(this)' onblur='saveContent(this)'>" +
              message.content + "</div>";
          }
        } else if (Array.isArray(message.content)) {
          chat_response +=
            "\n### <u> <input id='message-checkbox-" + index + "' type='checkbox' " + checked_string + " onchange='myFunction(this)'> " +
            message.role.toUpperCase() + "</u>:\n" +
            "<div id='message-content-" + index + "' contenteditable='false'>";
          message.content.forEach(part => {
            if (this.isChatCompletionContentPartImage(part)) {
              chat_response += "<img src='" + part.image_url.url + "' alt='Base64 Image'/>";
            }
            if (this.isChatCompletionContentPartText(part)) {
              chat_response += part.text;
            }
          });
          chat_response += "</div>";
        }
      });
    }

    // Mark collapsed messages so the webview renders them collapsed by default
    if (this._messages && this._messages.length > 0) {
      this._messages.forEach((m, idx) => {
        if ((m as any).collapsed) {
          this._view?.webview.postMessage({ type: 'setCollapsedForIndex', index: idx });
        }
        this._view?.webview.postMessage({ type: 'setMoveRefToEndForIndex', index: idx, value: !!(m as any).moveToEnd });
        this._view?.webview.postMessage({
          type: 'setCodeBlockSelectionsForIndex',
          index: idx,
          value: this.normalizeCodeBlockSelections((m as any).codeBlockSelections)
        });
      });
    }

    this._postStats();

    return chat_response;
  }

  // Expand file reference markers in strings to current file contents.
  // Supported markers:
  //   [[FILE:relative/path.ext]]
  //   <!--FILE:relative/path.ext-->
  private expandFileReferencesInString(input: string): string {
    const regex = /(?:\[\[FILE:([^\]]+)\]\])|(?:<!--\s*FILE:([^>]+?)\s*-->)/g;
    const replaced = input.replace(regex, (_m, g1, g2) => {
      const relPath = (g1 || g2 || '').trim();
      if (!relPath) return _m;
      const fileContent = this.readWorkspaceFile(relPath);
      if (fileContent == null) {
        // If file not found, keep the original marker
        return _m;
      }
      const ext = path.extname(relPath).slice(1);
      return `**${relPath}**\n\`\`\`${ext}\n${fileContent}\n\`\`\``;
    });
    return replaced;
  }

  // Reorder references in visible state: move refs marked moveToEnd to just before
  // the latest user query and leave a small note in their original positions.
  // Returns true if any references were moved.
  private reorderMoveRefsInStateBeforeLastMessage(): boolean {
    if (!this._messages || this._messages.length < 2) return false;
    const lastIdx = this._messages.length - 1;
    const lastMsg = this._messages[lastIdx];
    // Only if the last message is a user query we just added
    if ((lastMsg as any)?.role !== 'user') return false;
    const core = this._messages.slice(0, lastIdx);
    // First pass: determine which indices would be moved
    const pinnedIdxs: number[] = [];
    for (let i = 0; i < core.length; i++) {
      const m = core[i];
      const move = (m as any).moveToEnd === true;
      const c: any = (m as any).content;
      const refPath = move && typeof c === 'string' ? this.extractReferencePathFromString(c) : null;
      if (move && refPath) pinnedIdxs.push(i);
    }
    if (pinnedIdxs.length === 0) return false;
    // If already a contiguous tail at the end of core, nothing to move
    const k = pinnedIdxs.length;
    const isContiguousTail = pinnedIdxs.every((idx, j) => idx === core.length - k + j);
    if (isContiguousTail) return false;

    // Second pass: actually rebuild with placeholders and move pinned to end
    const pinned: Message[] = [];
    const coreWithPlaceholders: Message[] = [];
    for (let i = 0; i < core.length; i++) {
      const m = core[i];
      const move = (m as any).moveToEnd === true;
      const c: any = (m as any).content;
      const refPath = move && typeof c === 'string' ? this.extractReferencePathFromString(c) : null;
      if (move && refPath) {
        pinned.push(m);
        coreWithPlaceholders.push({
          role: 'user',
          content: `Note: reference to ${refPath} was here.`,
          selected: true,
          collapsed: true
        } as any);
      } else {
        coreWithPlaceholders.push(m);
      }
    }
    this._messages = [...coreWithPlaceholders, ...pinned, lastMsg];
    const chat_progress = this._updateChatMessages(0, 0);
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
    return true;
  }

  // Extract a referenced path from our lightweight reference format
  private extractReferencePathFromString(input: string): string | null {
    if (typeof input !== 'string' || !input) return null;
    const m1 = input.match(/<!--\s*FILE:([^>]+?)\s*-->/);
    if (m1 && m1[1]) return String(m1[1]).trim();
    const m2 = input.match(/File reference:\s*`([^`]+)`/);
    if (m2 && m2[1]) return String(m2[1]).trim();
    return null;
  }

  // Read a file from any workspace folder by relative path.
  private readWorkspaceFile(relPath: string): string | null {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders) {
      try {
        const abs = path.join(f.uri.fsPath, relPath);
        if (fs.existsSync(abs)) {
          return fs.readFileSync(abs, 'utf8');
        }
      } catch (_e) {
        // ignore and try next folder
      }
    }
    return null;
  }

  // Produce a deep-copied messages array with references expanded in string/text parts.
  private expandFileReferencesInMessages(msgs: ReadonlyArray<Message>): Message[] {
    return msgs.map((msg) => {
      // If content is a string, we can safely expand for any role (system/user/assistant)
      if (typeof msg.content === 'string') {
        const newContent = this.expandFileReferencesInString(msg.content);
        if (msg.role === 'system') {
          const sys: SystemMessage = { ...msg, content: newContent };
          return sys;
        }
        if (msg.role === 'assistant') {
          const asst: AssistantMessage = { ...msg, content: newContent };
          return asst;
        }
        // user
        const user: UserMessage = { ...msg, content: newContent };
        return user;
      }

      // If content is an array, only user messages are allowed to have array content
      if (Array.isArray(msg.content)) {
        if (msg.role === 'user') {
          const newParts = msg.content.map((part) => {
            if (this.isChatCompletionContentPartText(part)) {
              return { ...part, text: this.expandFileReferencesInString(part.text) };
            }
            return part;
          });
          const user: UserMessage = { ...msg, content: newParts };
          return user;
        }
        // For system/assistant, array content is not valid per Chat Completions params; keep as-is
        return msg as Message;
      }

      // Fallback: unchanged
      return msg;
    });
  }

  // Safely stringify arbitrary values, limited length to avoid flooding UI.
  private safeStringify(value: any, maxLen = 2000): string {
    let s: string;
    try {
      if (typeof value === 'string') s = value;
      else s = JSON.stringify(value, null, 2);
    } catch {
      s = String(value);
    }
    if (s.length > maxLen) {
      return s.slice(0, maxLen) + ' …';
    }
    return s;
  }
  // Build a detailed, human-readable error report including status, code, headers,
  // response body (if available), and stack. Works with OpenAI APIError, fetch errors,
  // and generic JS errors. Limits very long bodies safely.
  private async describeError(err: any): Promise<string> {
    const lines: string[] = [];
    const name = (err && err.name) ? String(err.name) : 'Error';
    const msg = (err && err.message) ? String(err.message) : String(err);
    lines.push(`[${name}] ${msg}`);
    // Common properties
    if (err && typeof err.status !== 'undefined') lines.push(`status: ${String(err.status)}`);
    if (err && typeof err.statusText !== 'undefined') lines.push(`statusText: ${String(err.statusText)}`);
    if (err && typeof err.code !== 'undefined') lines.push(`code: ${String(err.code)}`);
    // OpenAI APIError body (err.error) if present
    if (err && err.error) {
      try {
        const bodyStr = JSON.stringify(err.error, null, 2);
        lines.push(`error (body):\n${bodyStr}`);
      } catch {
        lines.push(`error (body): ${this.safeStringify(err.error, 4000)}`);
      }
    }
    // Headers of interest
    const hdrs = err && err.headers ? err.headers : (err && err.response && err.response.headers ? err.response.headers : undefined);
    if (hdrs) {
      const readHeader = (k: string) => {
        try {
          if (typeof hdrs.get === 'function') return hdrs.get(k);
          const v = hdrs[k] || hdrs[k.toLowerCase()];
          return Array.isArray(v) ? v.join(', ') : v;
        } catch { return undefined; }
      };
      const maybeHeaders: Array<[string, string | undefined]> = [
        ['x-request-id', readHeader('x-request-id')],
        ['openai-request-id', readHeader('openai-request-id')],
        ['cf-ray', readHeader('cf-ray')],
        ['date', readHeader('date')],
        ['content-type', readHeader('content-type')]
      ];
      const present = maybeHeaders.filter(([, v]) => !!v);
      if (present.length) {
        lines.push('headers:');
        for (const [k, v] of present) lines.push(`  ${k}: ${String(v)}`);
      }
    }
    // Try to read response text if available (e.g., fetch Response on errors)
    const resp = err && err.response ? err.response : undefined;
    if (resp && typeof resp.text === 'function') {
      try {
        const txt = await resp.text();
        if (txt && txt.trim().length) {
          lines.push('response body (text):');
          lines.push(this.safeStringify(txt, 4000));
        }
      } catch { /* ignore */ }
    }
    // Fallback: include any data/body fields if present
    if (err && err.data) lines.push(`data: ${this.safeStringify(err.data, 4000)}`);
    if (err && err.body && !err.error) lines.push(`body: ${this.safeStringify(err.body, 4000)}`);
    // Stack (trim to avoid flooding)
    if (err && err.stack) {
      const stack = String(err.stack).split('\n').slice(0, 20).join('\n');
      lines.push('stack:');
      lines.push(stack);
    }
    return lines.join('\n');
  }
  // Build a stable key for "current model" (provider+model) using base URL and model id
  private currentModelKey(): string {
    const api = (this._authInfo?.apiUrl || this._settings.apiUrl || '').trim();
    const model = (this._settings.model || '').trim();
    return `${api}::${model}`;
  }

  // Resolve a friendly label for a response type using per-model options.responseTypeLabels
  private labelForResponseType(type: string): string {
    const opt: any = this._settings?.options || {};
    const labels = opt.responseTypeLabels || {};
    const v = labels[type];
    return (typeof v === 'string' && v) ? v : type;
  }



  // Get nested value from an object using a dot/bracket path, e.g. "choices[0].delta.reasoning"
  private getValueAtPath(obj: any, path: string | undefined): any {
    if (!obj || !path) return undefined;
    const tokens: Array<string | number> = [];
    const re = /([^[.\]]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(path)) !== null) {
      if (m[1] !== undefined) tokens.push(m[1]);
      else if (m[2] !== undefined) tokens.push(Number(m[2]));
    }
    let cur: any = obj;
    for (const t of tokens) {
      if (cur == null) return undefined;
      if (typeof t === 'number') {
        if (!Array.isArray(cur) || t < 0 || t >= cur.length) return undefined;
        cur = cur[t];
      } else {
        cur = cur[t];
      }
    }
    return cur;
  }
  // Minimal tool-call runner: if a tool requires client output (custom tool),
  // provide a deterministic stub so the model can proceed. We do NOT implement
  // external tools here (e.g., web search).
  private async runToolCallStub(name: string, argsJsonText: string): Promise<string> {
    let args: any = {};
    try {
      args = argsJsonText ? JSON.parse(argsJsonText) : {};
    } catch {
      args = { raw: String(argsJsonText || '').trim() };
    }
    return `Client has no implementation for tool "${name}". Args: ${this.safeStringify(args)}`;
  }

  // Extract tool-call properties from a Responses stream event (best-effort).
  private extractToolEventInfo(ev: any): { id?: string, name?: string, argumentsDelta?: string, completed?: boolean } {
    const id =
      ev?.tool_call?.id ||
      ev?.id ||
      ev?.delta?.id ||
      ev?.data?.id;
    const name =
      ev?.tool_call?.name ||
      ev?.tool_call?.type ||
      ev?.delta?.name ||
      ev?.name;
    const argumentsDelta =
      ev?.delta?.arguments ||
      ev?.arguments_delta ||
      ev?.delta?.input ||
      undefined;
    const completed = ev?.type === 'response.tool_call.completed' || ev?.completed === true;
    return { id, name, argumentsDelta, completed };
  }

  // Detect server-side tools that do not require client-side tool outputs
  private isServerSideToolName(name?: string): boolean {
    return typeof name === 'string' && /web_search/i.test(name);
  }

  private normalizeWorkspaceRelativePath(relPath: string): string {
    return String(relPath || '').replace(/\r\n/g, '\n').trim().replace(/^[.][\\/]/, '').replace(/\\/g, '/');
  }

  private async handleAddFileBlockClick(requestedPath: string): Promise<void> {
    const relPath = this.normalizeWorkspaceRelativePath(requestedPath);
    if (!relPath) return;

    const choice = await vscode.window.showInformationMessage(
      `Detected add-file request for ${relPath}. What do you want to do?`,
      { modal: true },
      'Add File Reference',
      'Add File Content',
      'Cancel'
    );

    if (!choice || choice === 'Cancel') {
      return;
    }

    const fileContent = await this.readWorkspaceFileOptional(relPath);
    if (fileContent == null) {
      vscode.window.showErrorMessage(`Could not find file in workspace: ${relPath}`);
      return;
    }

    const fileExtension = path.extname(relPath).slice(1);

    if (choice === 'Add File Reference') {
      this.addFileReferenceToChat(relPath, fileExtension);
      vscode.window.setStatusBarMessage(`[DevMate AI Chat] Added file reference: ${relPath}`, 3000);
      return;
    }

    this.addFileToChat(relPath, fileContent, fileExtension);
    vscode.window.setStatusBarMessage(`[DevMate AI Chat] Added file content: ${relPath}`, 3000);
  }

  private async _generate_search_prompt(prompt: string) {
    this._prompt = prompt;
    if (!prompt) {
      prompt = '';
    }

    // Focus the ChatGPT view
    if (!this._view) {
      await vscode.commands.executeCommand('devmate.chatView.focus');
    } else {
      this._view?.show?.(true);
    }

    // Initialize response and token count

    if (!this._response) {
      this._response = '';
    }
    if (!this._totalNumberOfTokens) {
      this._totalNumberOfTokens = 0;
    }

    // Get selected text and language ID (if applicable)
    const selection = vscode.window.activeTextEditor?.selection;
    const selectedText = vscode.window.activeTextEditor?.document.getText(selection);
    const languageId =
      (this._settings.codeblockWithLanguageId
        ? vscode.window.activeTextEditor?.document?.languageId
        : undefined) || '';

    // Build the search prompt
    let searchPrompt = '';
    if (selection && selectedText) {
      if (this._settings.selectedInsideCodeblock) {
        searchPrompt = `${prompt}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;
      } else {
        searchPrompt = `${prompt}\n${selectedText}\n`;
      }
    } else {
      searchPrompt = prompt;
    }
    this._fullPrompt = searchPrompt;

    // Increment message number and store for tracking
    this._currentMessageNumber++;
    return searchPrompt;

  }

  public set_providers(providers: Provider[]): void {
    this._view?.webview.postMessage({ type: 'initialize', value: providers });
  }

  public set_prompts(prompts: Prompt[]): void {
    console.log("Set Prompts:", prompts);
    this._view?.webview.postMessage({ type: 'initialize_prompts', value: prompts });
  }

  public set_prompt(prompt: Prompt): void {
    // Check if _messages is defined
    if (this._messages) {
      this._messages[0] = { role: "system", content: prompt.prompt, selected: true };
    } else {
      this._messages = [{ role: "system", content: prompt.prompt, selected: true }];
    }
    console.log("calling updateResponse");
    let chat_response = this._updateChatMessages(0, 0)

    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
    this._view?.webview.postMessage({ type: 'setPrompt', value: '' });
  }

  public async search(prompt?: string) {
    // Check if the API key and URL are set
    if (!this._authInfo || !this._settings?.apiUrl) {
      this._view?.webview.postMessage({
        type: 'addResponse',
        value: '[ERROR] "API key or API URL not set, please go to extension settings (read README.md for more info)"',
      });
      return;
    }

    let chat_response = '';
    let searchPrompt = "";
    let movedInState = false;
    let requestUsage: TokenUsage | null = null;
    let finalPromptTokens = 0;
    let finalCompletionTokens = 0;
    this._lastRequestCost = 0;
    this._lastUsedTokens = 0;
    this._lastPromptTokens = 0;
    this._lastCompletionTokens = 0;
    // Local collector of streamed responses by type for this run/model
    const buckets: Record<string, string> = {};
    const put = (t: string, s: string) => { if (!s) return; buckets[t] = (buckets[t] || '') + s; };

    if (prompt != undefined) {
      searchPrompt = await this._generate_search_prompt(prompt);
    }
    // Show loading indicator
    this._view?.webview.postMessage({ type: 'setPrompt', value: this._prompt });
    this._view?.webview.postMessage({ type: 'addResponse', value: '...' });

    if (searchPrompt != "") {
      this._messages?.push({ role: "user", content: searchPrompt, selected: true })
      // Move marked references to just before the new query in state and UI
      try {
        movedInState = this.reorderMoveRefsInStateBeforeLastMessage();
      } catch (_) { movedInState = false; }
    }

    if (!this._openai) {
      throw new Error('OpenAI instance is not initialized.');
    }

    if (typeof this._settings.model !== 'string') {
      throw new Error('Model identifier is not valid or not defined.');
    }

    // Only if you can't change the Message interface
    const isValidRole = (role: any): role is 'user' | 'assistant' | 'system' => {
      return ['user', 'assistant', 'system'].includes(role);
    };

    // Validate and type narrow `this._messages` before sending
    if (!this._messages || !Array.isArray(this._messages) ||
      (!this._messages.every(msg => isValidRole(msg.role)))) {
      throw new Error('Messages have invalid roles.');
    }

    const promtNumberOfTokens = this._getMessagesNumberOfTokens();
    let full_message = "";
    finalPromptTokens = promtNumberOfTokens;
    try {
      console.log("Creating message sender...");

      let messagesToSend: Array<Message> = [];

      // Assuming this._messages is defined and is an array
      for (const message of this._messages) {
        // Check if 'selected' is true; undefined or false values will be considered false
        if (message.selected) {
          //if (messagesToSend.length > 0 && messagesToSend[messagesToSend.length - 1].role === message.role) {
          //  // Append the content to the previous message if the role is the same
          //  messagesToSend[messagesToSend.length - 1] = {
          //	...messagesToSend[messagesToSend.length - 1],
          //	content: messagesToSend[messagesToSend.length - 1].content + '\n' + message.content,
          //  };
          //} else {
          // Add the message as a new entry, omitting the 'selected' key
          const { selected, collapsed, ...messageWithoutFlags } = message as any; // Omit UI-only flags
          // Explicitly preserve moveToEnd so reordering can work on the send payload
          const moveToEnd = (message as any).moveToEnd === true;
          messagesToSend.push(
            moveToEnd ? ({ ...messageWithoutFlags, moveToEnd: true } as any) : messageWithoutFlags
          );
          //}
        }
      }

      if (!movedInState) {
      // Reorder: move marked file references to just before the new user query; leave a note in original place.
      try {
        if (messagesToSend.length >= 1) {
          const lastIdx = messagesToSend.length - 1;
          const lastMsg = messagesToSend[lastIdx];
          const core = messagesToSend.slice(0, lastIdx);
          // Determine which indices would be moved
          const pinnedIdxs: number[] = [];
          for (let i = 0; i < core.length; i++) {
            const m: any = core[i];
            const move = m?.moveToEnd === true;
            const c = m?.content;
            const refPath = move && typeof c === 'string' ? this.extractReferencePathFromString(c) : null;
            if (move && refPath) pinnedIdxs.push(i);
          }
          if (pinnedIdxs.length) {
            const k = pinnedIdxs.length;
            const isContiguousTail = pinnedIdxs.every((idx, j) => idx === core.length - k + j);
            if (!isContiguousTail) {
              const pinned: Message[] = [];
              const coreWithPlaceholders: Message[] = [];
              for (let i = 0; i < core.length; i++) {
                const m: any = core[i];
                const move = m?.moveToEnd === true;
                const c = m?.content;
                const refPath = move && typeof c === 'string' ? this.extractReferencePathFromString(c) : null;
                if (move && refPath) {
                  pinned.push(m);
                  coreWithPlaceholders.push({
                    role: 'user',
                    content: `Note: reference to ${refPath} was here.`,
                  } as any);
                } else {
                  coreWithPlaceholders.push(m);
                }
              }
              messagesToSend = [...coreWithPlaceholders, ...pinned, lastMsg];
            }
          }
        }
      } catch (_) { /* no-op */ }
      }

      // Summarize large code blocks that were explicitly marked as references in the UI
      messagesToSend = this.applyCodeBlockSelectionsToMessages(messagesToSend);

      // Expand any file reference markers to current file contents
      messagesToSend = this.expandFileReferencesInMessages(messagesToSend);
      finalPromptTokens = this._getMessagesNumberOfTokens(messagesToSend);

      // Choose API flow based on settings.apiType
      if (this._settings.apiType === 'responses') {
        // Build Responses API "input" with images and text parts
        const buildResponsesInput = (msgs: Array<Message>) => {
          const input: any[] = [];
          for (const m of msgs) {
            const role = (m as any).role || 'user';
            const parts: any[] = [];
            const c: any = (m as any).content;
            if (typeof c === 'string') {
              if (c.trim()) {
                // Assistant history must be output_text; user/system are input_text
                if (role === 'assistant') {
                  parts.push({ type: 'output_text', text: c });
                } else {
                  parts.push({ type: 'input_text', text: c });
                }
              }
            } else if (Array.isArray(c)) {
              for (const part of c) {
                if (this.isChatCompletionContentPartText(part)) {
                  if (role === 'assistant') {
                    parts.push({ type: 'output_text', text: part.text });
                  } else {
                    parts.push({ type: 'input_text', text: part.text });
                  }
                } else if (this.isChatCompletionContentPartImage(part)) {
                  const url: string = part.image_url.url;
                  // Images are inputs; only attach for non-assistant roles
                  if (role !== 'assistant') {
                    parts.push({ type: 'input_image', image_url: url });
                  }
                }
              }
            }
            if (parts.length) {
              input.push({ role, content: parts });
            }
          }
          return input;
        };

        const { tools, tool_choice, reasoning, ...restOptions } = this._settings.options || {};
        const responsesInput = buildResponsesInput(messagesToSend);

        // Use OpenAI v6 Responses client
        const responsesClient: any = (this._openai as any).responses;
        if (!responsesClient || typeof responsesClient.stream !== 'function') {
          throw new Error('Responses API client not available. Ensure "openai" >= 6.0.0 is installed.');
        }

        let responsesStream: any = null;
        let finalResponsesPayload: any = null;

        console.log(">>>>>>>>>>>>>>>>> responsesInput:", responsesInput);

        try {
          responsesStream = await responsesClient.stream({
            model: this._settings.model,
            input: responsesInput,
            ...(tools ? { tools } : {}),
            ...(tool_choice ? { tool_choice } : {}),
            // Request reasoning summary unless explicitly provided in options
            ...(reasoning ? { reasoning } : { reasoning: { summary: 'auto' } }),
            ...restOptions,
            stream: true
          });
        } catch (err) {
          throw err;
        }

        if (responsesStream && (Symbol.asyncIterator in Object(responsesStream))) {
          console.log("Responses stream created");
          this._view?.webview.postMessage({ type: 'streamStart' });

          // Track tool calls and outputs
          const toolCalls: Record<string, {
            id: string,
            name: string,
            args: string,
            completed: boolean,
            submitted: boolean,
            hasServerOutput: boolean,
            output?: string
          }> = {};
          // Detect available SDK helper(s)
          const inputToolOutputsFn =
            (responsesStream as any)?.inputToolOutputs?.bind(responsesStream);
          const submitToolOutputsFn = (responsesStream as any)?.submitToolOutputs?.bind(responsesStream);

          full_message = "";
          let reasoningDelta = "";

          let deltaAccumulator = "";
          let lastSend = 0;
          const flushDelta = (force = false) => {
            if (!deltaAccumulator) return;
            const now = Date.now();
            if (force || now - lastSend > 50) {
              this._view?.webview.postMessage({ type: 'appendDelta', value: deltaAccumulator });
              deltaAccumulator = "";
              lastSend = now;
            }
          };

          // Collectors for post-stream insertion
          const webSearchQueries: string[] = [];
          const messageOutputItems: any[] = [];

          const postProgress = (line: string) => {
            this._view?.webview.postMessage({ type: 'appendDelta', value: (line.endsWith('\n') ? line : line + '\n') });
          };
          const trySubmitMissingToolOutputs = async () => {
            if (typeof inputToolOutputsFn !== 'function' && typeof submitToolOutputsFn !== 'function') return;
            const ready = Object.values(toolCalls).filter(
              c => c.completed && !c.submitted && !c.hasServerOutput && !this.isServerSideToolName(c.name)
            );
            if (!ready.length) return;
            try {
              const outs = await Promise.all(ready.map(async (c) => {
                const out = await this.runToolCallStub(c.name || 'tool', c.args);
                this._messages?.push({
                  role: "assistant",
                  content: `Tool ${c.name || 'tool'} output (stub):\n${out}`,
                  selected: true
                });
                const chat_progress = this._updateChatMessages(0, 0);
                this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
                postProgress(`📥 tool.output (stub): ${out}`);
                // Responses API expects tool outputs as output items (e.g., output_text or refusal)
                return {
                  tool_call_id: c.id,
                  output: [{ type: 'output_text', text: out }]
                };
              }));
              // Use the correct helper shape depending on SDK
              if (typeof inputToolOutputsFn === 'function') {
                // Newer SDK: pass array directly
                await inputToolOutputsFn(outs);
              } else if (typeof submitToolOutputsFn === 'function') {
                // Older SDK: expects an object with tool_outputs
                await submitToolOutputsFn({ tool_outputs: outs });
              }
              ready.forEach(c => { c.submitted = true; });
            } catch (e) {
              console.warn('Submitting stub tool outputs failed:', e);
            }
          };
          try {

            for await (const event of responsesStream) {
              const t = (event && event.type) || '';
              if (t === 'response.created') { postProgress('▶️ response.created'); continue; }
              if (t === 'response.completed') { postProgress('✅ response.completed'); continue; }
              if (t === 'step.started') { const step = (event as any)?.step; postProgress(`🟡 step.started: ${step?.type || 'unknown'}`); continue; }
              if (t === 'step.completed') { const step = (event as any)?.step; postProgress(`🟢 step.completed: ${step?.type || 'unknown'}`); continue; }
              if (t === 'response.output_text.delta') {
                const content = (event as any).delta || "";
                if (!content) continue;
                put('output_text', String(content));
                full_message += content;
                deltaAccumulator += content;
                flushDelta(false);
                continue;
              }
              if (t === 'response.output_text.done') { postProgress('--- output_text.done ---'); continue; }
              // Reasoning summary text stream (new event names)
              if (t === 'response.reasoning_summary_text.delta') {
                const d = (event as any)?.delta ?? '';
                if (d) put('reasoning_summary', String(d));
                if (d) {
                  reasoningDelta += String(d);
                  // Stream reasoning brief text to UI as it arrives (like stdout.write in example)
                  this._view?.webview.postMessage({ type: 'appendReasoningDelta', value: String(d) });
                }
                continue;
              }
              if (t === 'response.reasoning_summary_text.done') {
                postProgress('📥 reasoning summary done');
                continue;
              }
              // Web search tool progress (new event names) – concise messages only
              if (t === 'response.web_search_call.in_progress') {
              put('web_search', 'in_progress\n');
              put('web_search', 'searching\n');
              put('web_search', 'completed\n');
                postProgress('🔎 web search: in progress');
                continue;
              }
              if (t === 'response.web_search_call.searching') {
                // Mark corresponding tool call (if tracked) as server-handled
                const id = (event as any)?.item_id;
                if (id && toolCalls[id]) {
                  toolCalls[id].hasServerOutput = true;
                }
                postProgress('🔎 web search: searching');
                continue;
              }
              if (t === 'response.web_search_call.completed') {
                const id = (event as any)?.item_id;
                if (id && toolCalls[id]) {
                  toolCalls[id].hasServerOutput = true;
                }
                postProgress('🔎 web search: completed');
                continue;
              }
              // Fallback: older/general tool events (kept for compatibility)
              if (t.startsWith('response.tool_call')) {
                // Accumulate tool call info and arguments; when completed, we may need to submit outputs for custom tools.
                const info = this.extractToolEventInfo(event);
                if (!info.id) {
                  continue;
                }
                if (!toolCalls[info.id]) {
                  toolCalls[info.id] = {
                    id: info.id,
                    name: info.name || '',
                    args: '',
                    completed: false,
                    submitted: false,
                    hasServerOutput: false,
                    // initialize accumulator
                    output: ''
                  };
                }
                if (info.name && !toolCalls[info.id].name) {
                  toolCalls[info.id].name = info.name;
                }
                // If this is a known server-side tool (e.g., web_search), don't submit client outputs
                if (this.isServerSideToolName(toolCalls[info.id].name)) {
                  toolCalls[info.id].hasServerOutput = true;
                }
                if (info.argumentsDelta) {
                  toolCalls[info.id].args += String(info.argumentsDelta);
                }
                if (t === 'response.tool_call.started') {
                  postProgress(`🔧 tool_call.started: ${toolCalls[info.id].name || 'tool'}`);
                }
                if (t === 'response.tool_call.delta') {
                  const argsDelta = (event as any)?.delta ?? '';
                  const shown = this.safeStringify(argsDelta, 400);
                  postProgress(`   … tool_call.delta (${toolCalls[info.id].name || 'tool'}) args += ${shown}`);
                }
                if (t === 'response.tool_call.completed' || info.completed) {
                  toolCalls[info.id].completed = true;
                  postProgress(`✅ tool_call.completed: ${toolCalls[info.id].name || 'tool'}`);
                  // If this is a custom tool (no server output), submit a stub so the model can continue
                  await trySubmitMissingToolOutputs();
                }
                continue;
              } else if (t === 'response.tool_output' || t.startsWith('response.tool_output')) {
                // Handle tool output events (may be delta/done or a single event)
                const toolCallId =
                  (event as any)?.tool_call_id ||
                  (event as any)?.tool_call?.id ||
                  (event as any)?.id;
                const rec = toolCallId ? toolCalls[toolCallId] : undefined;
                const name = rec?.name || 'tool';
                if (t === 'response.tool_output.delta') {
                  // Streamed tool output chunk
                  const delta =
                    (event as any)?.delta ??
                    (event as any)?.output_delta ??
                    '';
                    if (delta) put('tool_output', String(delta));
                  if (rec) {
                    rec.output = (rec.output || '') + String(delta);
                    rec.hasServerOutput = true;
                  }
                  const shown = this.safeStringify(delta, 400);
                  postProgress(`📥 tool.output.delta (${name}): ${shown}`);
                  continue;
                }
                // Final output or single-shot output
                let out = (event as any)?.output;
                if (!out && rec && rec.output) {
                  out = rec.output;
                }
                if (rec) {
                  rec.hasServerOutput = true;
                }
                const outStr = this.safeStringify(out ?? '', 2000);
                put('tool_output', outStr + '\n');
                postProgress(`📥 tool.output (${name}): ${outStr}`);
                // Add to chat history as an assistant message (selectable for later context)
                this._messages?.push({
                  role: "assistant",
                  content: `Tool ${name} output:\n${outStr}`,
                  selected: true
                });
                const chat_progress = this._updateChatMessages(0, 0);
                this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
                continue;
              } else if (t === 'response.output_item.done') {
                // Display results of web_search (concise summary without raw object)
                const item = (event as any)?.item;
                if (item?.type === 'web_search_call') {
                  // Mark matching tool call (if present) as having server output
                  const tid = item?.id;
                  if (tid && toolCalls[tid]) toolCalls[tid].hasServerOutput = true;

                  const q = item?.action?.query || '';
                  postProgress(`🔎 web search executed: ${q}`);
                  // Collect queries to aggregate later into a single message (not selected)
                  if (q) put('web_search', `query: ${q}\n`);
                  if (q) webSearchQueries.push(q);
                } else if (item?.type === 'message') {
                  // Capture message output items (with annotations) to add after stream, not selected
                  messageOutputItems.push(item);
                }
                continue;
              } else if (t === 'response.error') {
                const msg = (event as any)?.error?.message || 'Responses stream error';
                throw new Error(msg);
              } else if (t === 'response.refusal.delta') {
                const d = (event as any)?.delta ?? '';
                postProgress(`⚠️ refusal.delta: ${d}`);
                continue;
              } else if (t === 'response.refusal.done') {
                postProgress('⚠️ refusal.done');
                continue;
              } else {
                // handle other events silently (tool calls, etc.) for now
              }
            }

          } finally {
            flushDelta(true);
            this._view?.webview.postMessage({ type: 'streamEnd' });
          }

          // After streaming, add aggregated web searches (not selected)
          if (webSearchQueries.length) {
            const content = `Web searches executed:\n` + webSearchQueries.map(q => `- ${q}`).join('\n');
            this._messages?.push({ role: "assistant", content, selected: false, collapsed: true });
            const chat_progress = this._updateChatMessages(0, 0);
            this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
          }


          // Add any captured message output items with full annotations (not selected)
          for (const mi of messageOutputItems) {
            const contentJson = JSON.stringify(mi, null, 2);
            const content = `Responses message output item:\n\`\`\`json\n${contentJson}\n\`\`\``;
            this._messages?.push({ role: "assistant", content, selected: false, collapsed: true });
            const chat_progress = this._updateChatMessages(0, 0);
            this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
          }

          // After streaming, fetch final response to extract reasoning summary if available
          try {
            const finalResp = await responsesStream.finalResponse();
            finalResponsesPayload = finalResp;
            const outputArr: any[] = (finalResp as any)?.output || [];
            const reasoningItem = outputArr.find((o: any) => o?.type === 'reasoning');
            const summaryText =
              (reasoningItem?.summary || [])
                .map((p: any) => p?.text || '')
                .filter(Boolean)
                .join('\n') || '';
                if (summaryText) put('reasoning_summary_final', summaryText + '\n');
            if (summaryText || reasoningDelta) {
              const thinkText = summaryText || reasoningDelta;
              this._messages?.push({
                role: "assistant",
                content: `<think>${thinkText}</think>`,
                selected: false,
                collapsed: true
              });
            }
          } catch (e) {
            console.warn('Could not get final response for reasoning summary:', e);
          }

          // Add the final assistant answer as a message
          this._messages?.push({ role: "assistant", content: full_message, selected: true });
          if (full_message) put('output_text', full_message);
          requestUsage = requestUsage || this._extractTokenUsage(finalResponsesPayload);
          if (requestUsage) {
            finalPromptTokens = this._getPromptTokensFromUsage(requestUsage);
            finalCompletionTokens = this._getCompletionTokensFromUsage(requestUsage);
          } else {
            finalPromptTokens = 0;
            finalCompletionTokens = 0;
          }
          chat_response = this._updateChatMessages(finalPromptTokens, finalCompletionTokens);
        } else {
          throw new Error('Responses API stream() not available in this SDK/version.');
        }
        } else {
        // Branch here for Gemini; otherwise fall back to Chat Completions
        if (this._settings.apiType === 'gemini') {
          // Native Gemini API via REST SSE (streamGenerateContent)
          // Docs: google_search tool and REST streaming endpoints.
          // Sources: Grounding with Google Search guide and API reference. ([ai.google.dev](https://ai.google.dev/gemini-api/docs/google-search))
          const mapOptionsToGenerationConfig = (opts: any) => {
            if (!opts) return undefined;
            const gc: any = {};
            if (typeof opts.temperature === 'number') gc.temperature = opts.temperature;
            if (typeof opts.top_p === 'number') gc.topP = opts.top_p;
            if (typeof opts.topP === 'number') gc.topP = opts.topP;
            if (typeof opts.top_k === 'number') gc.topK = opts.top_k;
            if (typeof opts.topK === 'number') gc.topK = opts.topK;
            if (typeof opts.max_tokens === 'number') gc.maxOutputTokens = opts.max_tokens;
            if (typeof opts.maxOutputTokens === 'number') gc.maxOutputTokens = opts.maxOutputTokens;
            if (Array.isArray(opts.stop) && opts.stop.length) gc.stopSequences = opts.stop;
            if (Array.isArray(opts.stopSequences) && opts.stopSequences.length) gc.stopSequences = opts.stopSequences;
            return Object.keys(gc).length ? gc : undefined;
          };
          const toGeminiParts = (c: any): any[] => {
            const parts: any[] = [];
            if (typeof c === 'string') {
              if (c.trim()) parts.push({ text: c });
            } else if (Array.isArray(c)) {
              for (const p of c) {
                if (this.isChatCompletionContentPartText(p)) {
                  if (p.text && p.text.trim()) parts.push({ text: p.text });
                } else if (this.isChatCompletionContentPartImage(p)) {
                  const url: string = p.image_url.url;
                  // Expect data URL (we generate those for pasted files)
                  const m = /^data:(.+);base64,(.*)$/i.exec(url || '');
                  if (m && m[1] && m[2]) {
                    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
                  } else if (url) {
                    // Fallback: send URL as text reference
                    parts.push({ text: `Image: ${url}` });
                  }
                }
              }
            }
            return parts;
          };
          // Split selected messages into system instruction and conversational contents
          let systemText = '';
          const contents: any[] = [];
          for (const m of messagesToSend) {
            if ((m as any).role === 'system') {
              const t = typeof (m as any).content === 'string'
                ? String((m as any).content)
                : '';
              if (t.trim()) {
                systemText = systemText ? `${systemText}\n\n${t}` : t;
              }
              continue;
            }
            const role = (m as any).role === 'assistant' ? 'model' : 'user';
            const parts = toGeminiParts((m as any).content);
            if (parts.length) contents.push({ role, parts });
          }
          // Tools mapping: accept either "google_search" or generic "web_search" from settings
          const toolsIn = (this._settings.options && (this._settings.options as any).tools) || [];
          const tools: any[] = [];
          if (Array.isArray(toolsIn)) {
            if (toolsIn.some((t: any) => (t?.type || '').toLowerCase() === 'google_search'
              || (t?.type || '').toLowerCase() === 'web_search')) {
              tools.push({ google_search: {} });
            }
          }
          const generationConfig = mapOptionsToGenerationConfig(this._settings.options || {});
          const payload: any = {
            contents,
          };
          if (systemText) {
            payload.system_instruction = { parts: [{ text: systemText }] };
          }
          if (tools.length) payload.tools = tools;
          if (generationConfig) payload.generationConfig = generationConfig;

          const base = (this._settings.apiUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
          const modelId = this._settings.model || 'gemini-2.5-flash';
          const url = `${base}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
          const fetchImpl: any = (globalThis as any).fetch || (await import('node-fetch')).default;
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': String(this._authInfo?.apiKey || '')
            },
            body: JSON.stringify(payload)
          });
          if (!res.ok || !res.body) {
            let errText = '';
            try {
              errText = await res.text();
            } catch {
              // ignore
            }
            throw new Error(`Gemini request failed (${res.status || 0}): ${errText}`);
          }
          this._view?.webview.postMessage({ type: 'streamStart' });
          // Stream-time progress helpers for reasoning-style updates
          let reasoningStream = '';
          const postReason = (s: string) => {
            const line = s.endsWith('\n') ? s : s + '\n';
            this._view?.webview.postMessage({ type: 'appendReasoningDelta', value: line });
            put('reasoning_stream', line);
            reasoningStream += line;
          };
          const reader = (res as any).body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buf = '';
          let full_message_g = '';
          let lastSend = 0;
          let deltaAccumulator = '';
          let finalGrounding: any = null;
          let lastUsageMetadata: any = null;
          // Deduplicate streamed queries/sources so we only print each once
          const seenQueries = new Set<string>();
          const seenSources = new Set<string>();
          const flushDelta = (force = false) => {
            if (!deltaAccumulator) return;
            const now = Date.now();
            if (force || now - lastSend > 50) {
              this._view?.webview.postMessage({ type: 'appendDelta', value: deltaAccumulator });
              deltaAccumulator = '';
              lastSend = now;
            }
          };
          // If grounding is enabled, give the user an immediate heads-up
          if (tools.length) {
            postReason('🔎 Google Search grounding enabled; model may issue queries…');
          }
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                if (!line.startsWith('data:')) continue;
                const json = line.slice(5).trim();
                if (!json || json === '[DONE]') continue;
                let obj: any;
                try { obj = JSON.parse(json); } catch { continue; }
                if (obj?.usageMetadata) {
                  lastUsageMetadata = obj.usageMetadata;
                }
                // Extract delta text
                const cand = obj?.candidates?.[0];
                const parts = cand?.content?.parts || [];
                let delta = '';
                for (const p of parts) {
                  if (typeof p?.text === 'string') delta += p.text;
                }
                if (delta) {
                  full_message_g += delta;
                  put('assistant_text', delta);
                  deltaAccumulator += delta;
                  flushDelta(false);
                }
                // Capture/stream grounding progress if present in this chunk
                if (cand?.groundingMetadata) {
                  const gm = cand.groundingMetadata;
                  // Stream any newly observed search queries
                  if (Array.isArray(gm.webSearchQueries)) {
                    for (const q of gm.webSearchQueries) {
                      if (typeof q === 'string' && !seenQueries.has(q)) {
                        seenQueries.add(q);
                        postReason(`🔎 web search: ${q}`);
                      }
                    }
                  }
                  // Stream any newly observed sources
                  if (Array.isArray(gm.groundingChunks)) {
                    for (const ch of gm.groundingChunks) {
                      const uri = ch?.web?.uri || ch?.uri || '';
                      const title = ch?.web?.title || ch?.title || '';
                      const key = uri || title;
                      if (key && !seenSources.has(key)) {
                        seenSources.add(key);
                        postReason(`🔗 source: ${title ? title + ' — ' : ''}${uri}`);
                      }
                    }
                  }
                  // Keep the latest grounding for the final collapsed summary
                  finalGrounding = gm;
                }
              }
            }
          } finally {
            flushDelta(true);
            this._view?.webview.postMessage({ type: 'streamEnd' });
          }
          // Attach grounding summary (queries + sources) as collapsed assistant message
          if (finalGrounding) {
            const queries: string[] = Array.isArray(finalGrounding.webSearchQueries) ? finalGrounding.webSearchQueries : [];
            const chunks: any[] = Array.isArray(finalGrounding.groundingChunks) ? finalGrounding.groundingChunks : [];
            const lines: string[] = [];
            if (queries.length) {
              lines.push('Web searches executed:');
              for (const q of queries) lines.push(`- ${q}`);
            }
            if (chunks.length) {
              lines.push('', 'Sources:');
              for (let i = 0; i < chunks.length; i++) {
                const uri = chunks[i]?.web?.uri || chunks[i]?.uri || '';
                const title = chunks[i]?.web?.title || chunks[i]?.title || '';
                if (uri || title) lines.push(`- ${title ? title + ' — ' : ''}${uri}`);
              }
            }
            if (lines.length) {
            put('grounding_summary', lines.join('\n') + '\n');
              this._messages?.push({ role: "assistant", content: lines.join('\n'), selected: false, collapsed: true });
              const chat_progress = this._updateChatMessages(0, 0);
              this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
            }
          }
          // Final assistant message
          this._messages?.push({ role: "assistant", content: full_message_g, selected: true });
          if (full_message_g) put('assistant_text', full_message_g);
          requestUsage = requestUsage || this._extractTokenUsage(lastUsageMetadata ? { usageMetadata: lastUsageMetadata } : null);
          if (requestUsage) {
            finalPromptTokens = this._getPromptTokensFromUsage(requestUsage);
            finalCompletionTokens = this._getCompletionTokensFromUsage(requestUsage);
          } else {
            finalPromptTokens = 0;
            finalCompletionTokens = 0;
          }
          chat_response = this._updateChatMessages(finalPromptTokens, finalCompletionTokens);
        } else {
        // Default Chat Completions flow
        const chatCompletionOptions = {
          ...(this._settings.options || {}),
        } as any;
        chatCompletionOptions.stream_options = {
          ...(chatCompletionOptions.stream_options || {}),
          include_usage: true
        };

        const stream: any = await (this._openai as any).chat.completions.create({
          model: this._settings.model,
          messages: messagesToSend,
          stream: true,
          ...chatCompletionOptions, // Spread operator to include all keys from options
        });

        console.log("Message sender created");

        this._view?.webview.postMessage({ type: 'streamStart' });

        full_message = "";
        // Collect reasoning deltas if configured (e.g., OpenRouter reasoning models)
        let reasoningDeltaCC = "";
        let lastUsageChunk: any = null;

        // Throttled delta accumulator to reduce IPC messages
        let deltaAccumulator = "";
        let lastSend = 0;
        const flushDelta = (force = false) => {
          if (!deltaAccumulator) return;
          const now = Date.now();
          if (force || now - lastSend > 50) { // ~20 fps
            this._view?.webview.postMessage({ type: 'appendDelta', value: deltaAccumulator });
            deltaAccumulator = "";
            lastSend = now;
          }
        };

        try {
          for await (const chunk of stream) {
            const chunkUsage = (chunk as any)?.usage;
            if (chunkUsage) {
              lastUsageChunk = chunkUsage;
            }
            const content = (chunk as any).choices?.[0]?.delta?.content || "";
            console.log("chunk:", chunk);
            console.log("content:", content);
            // Extract reasoning delta if a path was configured
            if (this._settings.reasoningOutputDeltaPath) {
              try {
                const rv = this.getValueAtPath(chunk, this._settings.reasoningOutputDeltaPath);
                if (rv !== undefined && rv !== null) {
                  const piece = (typeof rv === 'string') ? rv : this.safeStringify(rv, 1000);
                        put('reasoning_delta', piece);
                  put('assistant_text', content);
                  reasoningDeltaCC += piece;
                  // Stream reasoning delta to the UI with special styling
                  this._view?.webview.postMessage({
                    type: 'appendReasoningDelta',
                    value: piece
                  });
                }
              } catch (_) { /* ignore */ }
            }
            if (!content) continue;

            full_message += content;

            // stream delta (throttled)
            deltaAccumulator += content;
            flushDelta(false);
          }
        } finally {
          // Ensure last delta is flushed and end the stream even on errors
          flushDelta(true);
          this._view?.webview.postMessage({ type: 'streamEnd' });
        }

        // If we captured reasoning deltas, add them as a separate unselected/collapsed assistant message
        if (reasoningDeltaCC && reasoningDeltaCC.trim()) {
          this._messages?.push({
            role: "assistant",
            content: `<think><p>${reasoningDeltaCC}</p></think>`,
            selected: false,
            collapsed: true
          });
        }
        this._messages?.push({ role: "assistant", content: full_message, selected: true })
        console.log("Full message:", full_message);
          if (full_message) put('assistant_text', full_message);
        // Store latest buckets for this provider+model
        this._lastResponsesByModel.set(this.currentModelKey(), buckets);
        requestUsage = requestUsage || this._extractTokenUsage(lastUsageChunk);
        if (requestUsage) {
          finalPromptTokens = this._getPromptTokensFromUsage(requestUsage);
          finalCompletionTokens = this._getCompletionTokensFromUsage(requestUsage);
        } else {
          finalPromptTokens = 0;
          finalCompletionTokens = 0;
        }
          chat_response = this._updateChatMessages(finalPromptTokens, finalCompletionTokens)
        }
      }
    } catch (e: any) {
      console.error(e);
      try {
        const details = await this.describeError(e);
        // Preserve any partial assistant output if we captured it
        if (full_message && full_message.trim().length) {
          this._messages?.push({ role: "assistant", content: full_message, selected: true });
        }
        // Add a rich error report for debugging/diagnostics
        this._messages?.push({
          role: "assistant",
          content: `Request failed. Full error details:\n\`\`\`text\n${details}\n\`\`\``,
          selected: true
        });
        chat_response = this._updateChatMessages(promtNumberOfTokens, 0);
      } catch (_fmtErr) {
        const fallback = (e && e.message) ? String(e.message) : String(e);
        this._messages?.push({ role: "assistant", content: `Request failed: ${fallback}`, selected: true });
        chat_response = this._updateChatMessages(promtNumberOfTokens, 0);
      }
    }
    this._setLastRequestTokenUsage(requestUsage);
    if (requestUsage) {
      const requestCost = this._calculateRequestCost(requestUsage);
      this._lastRequestCost = requestCost;
      this._addRequestUsageToSession(requestUsage, requestCost);
    }
    this._postStats();
    this._response = chat_response;
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
    this._view?.webview.postMessage({ type: 'setPrompt', value: '' });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'styles.css'));
    const microlightUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'microlight.min.js'));
    const tailwindUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'tailwind.min.js'));
    const showdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'showdown.min.js'));
    const dompurifyUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scripts', 'purify.min.js'));

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="${tailwindUri}"></script>
      <script src="${showdownUri}"></script>
      <script src="${microlightUri}"></script>
      <script src="${dompurifyUri}"></script>
      <link rel="stylesheet" href="${stylesUri}">
    </head>
    <body>
      <div id="container">
        <div id="top-wrapper">
          <label for="provider-selector">Provider:</label>
          <select id="provider-selector"></select>
          <label for="model-selector">Model:</label>
          <select id="model-selector"></select>
        </div>
  
        <div id="response" class="text-sm"></div>
  
        <!-- NEW: always-visible stats bar -->
        <div id="stats-bar">
          <span id="stats-total">Total Tokens: 0</span>
          <span class="stats-sep">|</span>
          <span id="stats-used">Used: 0 (0+0)</span>
          <span class="stats-sep">|</span>
          <span id="stats-model">Model: -</span>
          <span class="stats-sep">|</span>
          <span id="stats-session-cost">Session Cost: n/a</span>
          <span class="stats-sep">|</span>
          <span id="stats-last-cost">Last Request: n/a</span>
        </div>
  
        <div id="input-wrapper">
          <div>
            <label for="system-prompt-selector">System Prompt:</label>
            <select id="system-prompt-selector"></select>
          </div>
          <input type="text" id="prompt-input" placeholder="Ask ChatGPT something">
        </div>
      </div>
      <script src="${scriptUri}"></script>
    </body>
    </html>`;
  }

  public addImageToChat(imageDataUrl: string, fileName: string) {
    const imageMarkdown = `![${fileName}](${imageDataUrl})`;
    let newMessage: UserMessage = {
      role: "user",
      content: [
        {
          "type": "text",
          "text": fileName + ":"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": imageDataUrl
          }
        }
      ],
      selected: true
    };


    this._messages?.push(newMessage);

    const chat_response = this._updateChatMessages(this._getMessagesNumberOfTokens(), 0);
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
  }

  // Show a Quick Pick of the last captured response types for the current model/provider
  public async pasteLastResponses(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active text editor!');
      return;
    }
    const key = this.currentModelKey();
    const buckets = this._lastResponsesByModel.get(key);
    if (!buckets || !Object.keys(buckets).length) {
      vscode.window.showInformationMessage('No recent DevMate responses captured for this model yet.');
      return;
    }
    const types = Object.keys(buckets);
    const items = types.map(t => ({
      label: this.labelForResponseType(t),
      description: t
    }));
    let picked: { label: string; description?: string } | undefined;
    if (items.length === 1) {
      picked = items[0];
    } else {
      picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select which last response to paste'
      });
      if (!picked) return;
    }
    const typeKey = picked.description || picked.label;
    const text = buckets[typeKey] || '';
    if (!text) {
      vscode.window.showWarningMessage('Selected response is empty.');
      return;
    }
    const sel = editor.selection;
    await editor.edit(edit => edit.replace(sel, text));
    vscode.window.setStatusBarMessage(`[DevMate AI Chat] Inserted "${picked.label}" response.`, 3000);
  }

  // Return all indices where a line matches (exact or whitespace-normalized)
  private findAllLineMatches(lines: string[], needle: string): number[] {
    const out: number[] = [];
    const normNeedle = this.normalizeWs(needle);
    for (let i = 0; i < lines.length; i++) {
      const li = lines[i];
      if (li === needle || this.normalizeWs(li) === normNeedle) {
        out.push(i);
      }
    }
    return out;
  }

  // Simple wrapper using the advanced comparator for convenience
  private findSubsequence(hay: string[], needle: string[], ignoreWs: boolean): number {
    return this.findSubsequenceAdv(hay, needle, { ignoreWs, trimRight: true });
  }

  // Ordered-with-slop finder: keeps the order of needle items, allows gaps,
  // and confines match within a bounded window.
  private findOrderedWithSlop(
    hay: string[],
    needle: string[],
    opts?: { ignoreWs?: boolean; ignoreIndent?: boolean; trimRight?: boolean },
    maxGap = 3,
    maxWindowLen = 500
  ): { start: number; end: number; indexes: number[] } | null {
    if (!needle.length) return null;
    const norm = (s: string) => this.normalizeLineForCompare(s, opts);
    const n0 = norm(needle[0]);
    const starts: number[] = [];
    for (let i = 0; i < hay.length; i++) {
      if (norm(hay[i]) === n0) starts.push(i);
    }
    for (const sIdx of starts) {
      const limit = Math.min(hay.length, sIdx + maxWindowLen);
      let curPos = sIdx;
      const idxs = [sIdx];
      let ok = true;
      for (let k = 1; k < needle.length; k++) {
        const target = norm(needle[k]);
        let found = -1;
        const maxSearchTo = Math.min(limit, curPos + 1 + 1 + maxGap + (k === needle.length - 1 ? maxGap : maxGap));
        for (let j = curPos + 1; j < limit && j <= maxSearchTo; j++) {
          if (norm(hay[j]) === target) { found = j; break; }
        }
        if (found === -1) { ok = false; break; }
        idxs.push(found);
        curPos = found;
      }
      if (ok) {
        return { start: idxs[0], end: idxs[idxs.length - 1], indexes: idxs };
    }
    }
    return null;
  }

  // Legacy/global hunk applier used as a fallback when hinted/windowed attempts fail.
  private applyHunkToText(
    current: string,
    hunkLines: string[]
  ): { ok: boolean; text?: string; via?: 'exact' | 'whitespace' | 'indent' | 'anchor' | 'ordered' | 'insert' | 'delete' | 'fuzzy'; note?: string } {
    const curLines = current.replace(/\r\n/g, '\n').split('\n');
    const oldItems = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('-'))
      .map(l => ({ kind: l[0] as ' ' | '-', text: l.slice(1) }));
    const newSeq = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('+'))
      .map(l => l.slice(1));
    const { oldSeq, minusOnly, plusOnly, leadingCtx, trailingCtx } = this.buildHunkSequences(hunkLines);


    // Idempotency guards
    const hasNewExact = newSeq.length ? this.findSubsequence(curLines, newSeq, false) !== -1 : false;
    const hasNewWs = newSeq.length ? this.findSubsequence(curLines, newSeq, true) !== -1 : false;
    if (minusOnly.length === 0 && plusOnly.length > 0) {
      if (hasNewExact || hasNewWs) {
        return { ok: true, text: current, note: 'Insertion already present; skipping' };
      }
    }
    if (minusOnly.length > 0 && plusOnly.length > 0) {
      // Only skip if the new exists AND the old/removed lines are not present anymore.
      const opts = { ignoreWs: true, trimRight: true };
      const oldStillThere = (oldSeq.length ? this.findSubsequenceAdv(curLines, oldSeq, opts) !== -1 : false);
      const minusStillThere = (minusOnly.length ? this.findSubsequenceAdv(curLines, minusOnly, opts) !== -1 : false);
      if ((hasNewExact || hasNewWs) && !oldStillThere && !minusStillThere) {
        return { ok: true, text: current, note: 'Replacement already present; skipping' };
      }
    }
    if (plusOnly.length === 0 && minusOnly.length > 0) {
      const minusContigExact = this.findSubsequence(curLines, minusOnly, false) !== -1;
      const minusContigWs = this.findSubsequence(curLines, minusOnly, true) !== -1;
      if (!minusContigExact && !minusContigWs) {
        return { ok: true, text: current, note: 'Deletion already applied; skipping' };
      }
    }

    const accept = (nextLines: string[], via: any, note?: string) => {
      const v = this.validateHunkEffect(curLines, nextLines, { oldSeq, newSeq, minusOnly, plusOnly });
      if (!v.ok) return null;
      return { ok: true, text: nextLines.join('\n'), via, note };
    };


    // Pure deletion
    if (plusOnly.length === 0 && minusOnly.length > 0 && oldSeq.length === minusOnly.length) {
      let idx = this.findSubsequence(curLines, minusOnly, false);
      if (idx !== -1) {
        const nextLines = [...curLines.slice(0, idx), ...curLines.slice(idx + minusOnly.length)];
        const r = accept(nextLines, 'delete');
        if (r) return r;
      }
      idx = this.findSubsequence(curLines, minusOnly, true);
      if (idx !== -1) {
        const nextLines = [...curLines.slice(0, idx), ...curLines.slice(idx + minusOnly.length)];
        const r = accept(nextLines, 'whitespace');
        if (r) return r;
      }
    }

    // Pure insertion: anchor by leading or trailing context
    if (minusOnly.length === 0 && plusOnly.length > 0) {
      const leadingCtx: string[] = [];
      for (const l of hunkLines) { if (l.startsWith(' ')) leadingCtx.push(l.slice(1)); else break; }
      let insertPos = -1;
      if (leadingCtx.length > 0) {
        let idx = this.findSubsequenceAdv(curLines, leadingCtx, { ignoreWs: true, trimRight: true });
        if (idx !== -1) insertPos = idx + leadingCtx.length;
      }
      if (insertPos === -1) {
        const trailingCtx: string[] = [];
        for (let i = hunkLines.length - 1; i >= 0; i--) {
          const l = hunkLines[i];
          if (l.startsWith(' ')) trailingCtx.unshift(l.slice(1));
          else break;
        }
        if (trailingCtx.length > 0) {
          const idx2 = this.findSubsequenceAdv(curLines, trailingCtx, { ignoreWs: true, trimRight: true });
          if (idx2 !== -1) insertPos = idx2;
        }
      }
      if (insertPos !== -1) {
        const nextLines = [...curLines.slice(0, insertPos), ...plusOnly, ...curLines.slice(insertPos)];
        const r = accept(nextLines, 'insert', 'Pure insertion (verbatim)');
        if (r) return r;
      }
    }

    // Replacement: try contiguous exact, whitespace, indentation, then ordered-with-slop
    if (oldSeq.length > 0) {
      let idx = this.findSubsequence(curLines, oldSeq, false);
      if (idx !== -1) {
        const nextLines = [...curLines.slice(0, idx), ...newSeq, ...curLines.slice(idx + oldSeq.length)];
        const r = accept(nextLines, 'exact');
        if (r) return r;
      }
      idx = this.findSubsequence(curLines, oldSeq, true);
      if (idx !== -1) {
        const nextLines = [...curLines.slice(0, idx), ...newSeq, ...curLines.slice(idx + oldSeq.length)];
        const r = accept(nextLines, 'whitespace');
        if (r) return r;
      }
      const idxIndent = this.findSubsequenceAdv(curLines, oldSeq, { ignoreIndent: true, trimRight: true });
      if (idxIndent !== -1) {
        const nextLines = [...curLines.slice(0, idxIndent), ...newSeq, ...curLines.slice(idxIndent + oldSeq.length)];
        const r = accept(nextLines, 'indent');
        if (r) return r;
      }
      const ordered = this.findOrderedWithSlop(curLines, oldSeq, { ignoreWs: true, trimRight: true }, 3, 1200);
      if (ordered) {
        const nextLines = [
          ...curLines.slice(0, ordered.start),
          ...newSeq,
          ...curLines.slice(ordered.end + 1)
        ];
        const r = accept(nextLines, 'ordered');
        if (r) return r;
      }

      // Fallback for replacements: try minusOnly (context-anchored) and either delete-only (dup) or replace.
      if (minusOnly.length > 0 && plusOnly.length > 0) {
        const rep = this.tryReplacementByMinusOnly(curLines, { oldSeq, newSeq, minusOnly, plusOnly, leadingCtx, trailingCtx });
        if (rep.ok && rep.next) {
          const r = accept(rep.next, 'fuzzy', rep.note);
          if (r) return r;
        }
      }
    }
    return { ok: false, note: 'Legacy apply failed' };
  }

  // Minimal unified-diff parser for multiple files and hunks.
  private parseUnifiedDiff(diffText: string): Array<{
    oldPath: string;
    newPath: string;
    hunks: Array<{ header: string; lines: string[] }>;
  }> {
    const lines = diffText.replace(/\r\n/g, '\n').split('\n');
    const files: Array<{ oldPath: string; newPath: string; hunks: Array<{ header: string; lines: string[] }> }> = [];
    let curFile: { oldPath: string; newPath: string; hunks: Array<{ header: string; lines: string[] }> } | null = null;
    let curHunk: { header: string; lines: string[] } | null = null;
    let pendingOld: string | null = null;

    const cleanPath = (p: string) => {
      const s = p.trim();
      if (s === '/dev/null') return '/dev/null';
      return s.replace(/^a\//, '').replace(/^b\//, '');
    };

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('--- ')) {
        pendingOld = l.slice(4).trim();
        continue;
      }
      if (l.startsWith('+++ ')) {
        const newP = l.slice(4).trim();
        if (pendingOld === null) continue;
        curFile = {
          oldPath: cleanPath(pendingOld),
          newPath: cleanPath(newP),
          hunks: []
        };
        files.push(curFile);
        curHunk = null;
        pendingOld = null;
        continue;
      }
      // Treat any line that begins with "@@" as a hunk header, even if it
      // omits or misformats the -old,+new line/length metadata. This allows
      // "loose" diffs from LLMs (e.g., just "@@") to be recognized as hunks.
      if (l.startsWith('@@')) {
        if (!curFile) continue;
        curHunk = {
          header: l,    // may be malformed; we will fall back to fuzzy matching
          lines: []
        };
        curFile.hunks.push(curHunk);
        continue;
      }
      if (curHunk && (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-'))) {
        curHunk.lines.push(l);
        continue;
      }
      // ignore other lines (blank lines between hunks etc.)
    }
    return files;
  }

  // Workspace file helpers (async) used by patch applier
  private async readWorkspaceFileOptional(relPath: string): Promise<string | null> {
    const key = relPath.replace(/\\/g, '/');
    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders) {
      const abs = path.join(f.uri.fsPath, relPath);
      try {
        const data = await fsp.readFile(abs, 'utf8');
        this._workspaceFolderForRelPath.set(key, f.uri.fsPath);
        return data.replace(/\r\n/g, '\n');
      } catch {
        // try next folder
      }
    }
    return null;
  }
  private async writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const key = relPath.replace(/\\/g, '/');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('No workspace folder.');
    const mappedBase = this._workspaceFolderForRelPath.get(key);
    const base = mappedBase || folders[0].uri.fsPath;
    const abs = path.join(base, relPath);
    this._workspaceFolderForRelPath.set(key, base);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  private async deleteWorkspaceFile(relPath: string): Promise<void> {
    const key = relPath.replace(/\\/g, '/');
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('No workspace folder.');
    const mappedBase = this._workspaceFolderForRelPath.get(key);
    const base = mappedBase || folders[0].uri.fsPath;
    const abs = path.join(base, relPath);
    try {
      await fsp.unlink(abs);
    } catch {
      // ignore if already gone
    } finally {
      this._workspaceFolderForRelPath.delete(key);
    }
  }
  // ---------------------------
  // Diff/Patch application logic
  // ---------------------------
  private isLikelyDiffPath(relPath: string): boolean {
    return /\.(patch|diff)$/i.test(relPath);
  }

  private isLikelyDiffContent(s: string): boolean {
    if (!s) return false;
    // Unified diff markers or OpenAI Patch or EditBlock/search-replace block
    return (
      /^\s*---\s+(?:a\/|\/dev\/null|[^\s])/m.test(s) ||
      /^\s*\*\*\*\s+Begin Patch/m.test(s) ||
      /^\s*`{3,}search-replace:/m.test(s) ||
      /^(###\s+FILE: )/m.test(s) ||
      /^\s*<<<<<<<\s*SEARCH[\s\S]*?>>>>>>>\s*REPLACE/m.test(s)
    );
  }

  private async applyPatchText(rawText: string): Promise<{ success: boolean; details: string }> {
    try {
      // Extract one or more patch blocks we know how to process
      const unifiedBlocks = this.extractUnifiedDiffBlocks(rawText);
      const openAiBlocks = this.extractOpenAIPatchBlocks(rawText);
      const searchReplaceBlocks = this.extractSearchReplaceBlocks(rawText);
      const editBlocks = searchReplaceBlocks.length ? [] : this.extractEditBlocks(rawText);

      let appliedFiles = 0;
      let appliedVia = { udiff: 0, openai: 0, searchReplace: 0, edit: 0, fuzzy: 0, whitespace: 0 };

      // Apply unified diffs first
      for (const block of unifiedBlocks) {
        const result = await this.applyUnifiedDiffBlock(block, appliedVia);
        if (!result.success) {
          return { success: false, details: `[udiff] ${result.details}` };
        }
        appliedFiles += result.count;
      }

      // Convert OpenAI Patch to udiff and apply
      for (const upd of openAiBlocks) {
        const asUnified = this.convertOpenAIPatchUpdateToUnified(upd);
        const result = await this.applyUnifiedDiffBlock(asUnified, appliedVia);
        if (!result.success) {
          return { success: false, details: `[openai] ${result.details}` };
        }
        appliedFiles += result.count;
        appliedVia.openai += result.count;
      }

      // Apply fenced search-replace:path blocks
      if (searchReplaceBlocks.length > 0) {
        const result = await this.applySearchReplaceBlocks(searchReplaceBlocks);
        if (!result.success) {
          return { success: false, details: `[search-replace] ${result.details}` };
        }
        appliedFiles += result.count;
        appliedVia.searchReplace += result.count;
      }

      // Apply EditBlock SEARCH/REPLACE (possibly across files)
      for (const eb of editBlocks) {
        const result = await this.applyEditBlock(eb);
        if (!result.success) {
          return { success: false, details: `[editblock] ${result.details}` };
        }
        appliedFiles += result.count;
        appliedVia.edit += result.count;
      }

      if (appliedFiles === 0) {
        return { success: false, details: 'No recognizable patches found.' };
      }

      const detail = `changed ${appliedFiles} file(s) ` +
        `(udiff:${appliedVia.udiff}, openai:${appliedVia.openai}, searchReplace:${appliedVia.searchReplace}, edit:${appliedVia.edit},` +
        ` whitespace:${appliedVia.whitespace}, fuzzy:${appliedVia.fuzzy})`;
      return { success: true, details: detail };
    } catch (e: any) {
      return { success: false, details: `Unexpected error: ${e?.message || String(e)}` };
    }
  }

  // Extract fenced diff blocks after headings ### FILE: <path>, or whole text if it's a single diff.
  private extractUnifiedDiffBlocks(text: string): string[] {
    const blocks: string[] = [];
    // 1) ### FILE: <path> + fenced ``​`diff
    // Accept normal ``​` fences and the zero-width-space variant (``\u200B`)
    const re = /(^|\n)###\s+FILE:\s+([^\r\n]+)\s*\n+(?:``​`|``\u200B`)(?:diff)?\s*\n([\s\S]*?)\n(?:``​`|``\u200B`)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const diffBody = (m[3] || '').trim();
      if (diffBody && /(^|\n)---\s+/.test(diffBody) && /(^|\n)\+\+\+\s+/.test(diffBody)) {
        blocks.push(diffBody);
      }
    }
    // 2) If the whole text itself is a single diff
    if (blocks.length === 0 && /(^|\n)---\s+/.test(text) && /(^|\n)\+\+\+\s+/.test(text)) {
      blocks.push(text);
    }
    return blocks;
  }

  // Parse OpenAI Patch style: *** Begin Patch ... *** Update File: <path> ... @@ ... *** End Patch
  private extractOpenAIPatchBlocks(text: string): Array<{ path: string; body: string }> {
    const out: Array<{ path: string; body: string }> = [];
    const all = text.match(/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/g);
    if (!all) return out;
    for (const blk of all) {
      const reUpd = /\*\*\*\s+Update File:\s+([^\r\n]+)\s*([\s\S]*?)(?=(\*\*\*\s+Update File:|\*\*\*\s+End Patch))/g;
      let m: RegExpExecArray | null;
      while ((m = reUpd.exec(blk)) !== null) {
        const p = (m[1] || '').trim();
        const body = (m[2] || '').trim();
        if (p && /(^|\n)@@\s/.test(body)) out.push({ path: p, body });
      }
    }
    return out;
  }
  // Extract the old-start line number from a unified diff hunk header:
  // @@ -<oldStart>[,<oldLen>] +<newStart>[,<newLen}] @@
  private parseOldStartFromHunkHeader(header: string): number | null {
    if (typeof header !== 'string') return null;
    // Normalize any CRLF
    const h = header.replace(/\r\n/g, '\n');
    // Standard unified diff: @@ -<oldStart>[,<oldLen>] +<newStart>[,<newLen>] @@
    // Many LLMs emit "@@" with no numbers or with bogus numbers; in that case,
    // we return null so callers know they must *not* trust the header and
    // should fall back to header-less fuzzy matching instead of rejecting.
    const m = h.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  }
  // Convert an OpenAI Update File chunk into a unified diff string
  private convertOpenAIPatchUpdateToUnified(u: { path: string; body: string }): string {
    const p = u.path.replace(/^(\.\/)/, '');
    const header = `--- a/${p}\n+++ b/${p}\n`;
    // Body already contains @@ hunks with ' ', '-', '+'
    return header + u.body.replace(/\r\n/g, '\n') + '\n';
  }

  // Extract Aider/Cline style EditBlock SEARCH/REPLACE
  private extractEditBlocks(text: string): Array<{ file?: string; search: string; replace: string }> {
    const out: Array<{ file?: string; search: string; replace: string }> = [];
    // Try to pick up a preceding path line, else leave file undefined
    const re = /(?:^|\n)([^\n`*<>][^\n]*\.[A-Za-z0-9]+)?\s*\n+<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const fileLine = (m[1] || '').trim();
      const search = (m[2] || '').replace(/\r\n/g, '\n');
      const replace = (m[3] || '').replace(/\r\n/g, '\n');
      const file = fileLine && /[\/\\]/.test(fileLine) ? fileLine : undefined;
      if (search.length > 0) out.push({ file, search, replace });
    }
    return out;
  }

  private parseSearchReplaceBody(body: string): { search: string; replace: string } | null {
    const normalized = body.replace(/\r\n/g, '\n').trimEnd();
    const match = normalized.match(/^<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE$/);
    if (!match) return null;
    return { search: match[1], replace: match[2] };
  }

  private extractSearchReplaceBlocks(text: string, fallbackPath?: string): Array<{ path: string; search: string; replace: string }> {
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const out: Array<{ path: string; search: string; replace: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^\s*(`{3,})search-replace:(.+?)\s*$/);
      if (!open) continue;
      const fenceLen = open[1].length;
      const filePath = (open[2] || '').trim();
      const closeRe = new RegExp('^\\s*`{' + fenceLen + ',}\\s*$');
      const body: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      const parsed = this.parseSearchReplaceBody(body.join('\n'));
      if (parsed && filePath) {
        out.push({ path: filePath, ...parsed });
      }
    }
    if (!out.length && fallbackPath) {
      const parsed = this.parseSearchReplaceBody(normalized.trim());
      if (parsed) {
        out.push({ path: fallbackPath, ...parsed });
      }
    }
    return out;
  }

  private async applySearchReplaceBlocks(blocks: Array<{ path: string; search: string; replace: string }>): Promise<{ success: boolean; details: string; count: number }> {
    if (!blocks.length) {
      return { success: false, details: 'No SEARCH/REPLACE blocks found.', count: 0 };
    }
    const originalByPath = new Map<string, string | null>();
    const currentByPath = new Map<string, string>();
    const changedPaths = new Set<string>();

    for (const block of blocks) {
      const relPath = block.path.replace(/^[.][\\/]/, '').replace(/\\/g, '/');
      let currentText: string;
      if (currentByPath.has(relPath)) {
        currentText = currentByPath.get(relPath)!;
      } else {
        const existing = await this.readWorkspaceFileOptional(relPath);
        originalByPath.set(relPath, existing);
        currentText = existing ?? '';
      }

      let nextText = currentText;
      if (block.search === '') {
        if ((originalByPath.get(relPath) ?? null) !== null && currentText !== '') {
          return { success: false, details: `${relPath}: empty SEARCH is only supported when creating a new empty file.`, count: 0 };
        }
        nextText = block.replace;
      } else {
        const firstIdx = currentText.indexOf(block.search);
        if (firstIdx !== -1) {
          const secondIdx = currentText.indexOf(block.search, firstIdx + block.search.length);
          if (secondIdx !== -1) {
            return { success: false, details: `${relPath}: SEARCH block matched multiple times.`, count: 0 };
          }
          nextText = currentText.slice(0, firstIdx) + block.replace + currentText.slice(firstIdx + block.search.length);
        } else {
          const currentLines = currentText.split('\n');
          const searchLines = block.search.split('\n');
          const matches = this.findAllSubsequenceAdv(currentLines, searchLines, { ignoreWs: true, trimRight: true });
          if (matches.length !== 1) {
            return { success: false, details: `${relPath}: SEARCH block not found uniquely.`, count: 0 };
          }
          const replaceLines = block.replace.split('\n');
          nextText = [
            ...currentLines.slice(0, matches[0]),
            ...replaceLines,
            ...currentLines.slice(matches[0] + searchLines.length)
          ].join('\n');
        }
      }

      currentByPath.set(relPath, nextText);
      if (nextText !== currentText) {
        changedPaths.add(relPath);
      }
    }

    for (const [relPath, nextText] of currentByPath.entries()) {
      const originalText = originalByPath.get(relPath);
      if ((originalText ?? '') !== nextText || changedPaths.has(relPath)) {
        await this.writeWorkspaceFile(relPath, nextText);
      }
    }

    return {
      success: true,
      details: `Applied ${blocks.length} SEARCH/REPLACE block(s) across ${changedPaths.size} file(s).`,
      count: changedPaths.size
    };
  }

  private normalizeWs(s: string): string {
    return s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
  }

  // New: normalize a line with options for robust comparisons
  private normalizeLineForCompare(
    s: string,
    opts?: { ignoreWs?: boolean; ignoreIndent?: boolean; trimRight?: boolean }
  ): string {
    let out = s.replace(/\r\n/g, '\n');
    if (opts?.trimRight) out = out.replace(/[ \t]+$/g, '');
    if (opts?.ignoreIndent) out = out.replace(/^[ \t]+/g, '');
    if (opts?.ignoreWs) {
      out = out.replace(/[ \t]+/g, ' ');
    }
    return out;
  }

  // New: advanced subsequence search with compare options
  private findSubsequenceAdv(
    hay: string[],
    needle: string[],
    opts?: { ignoreWs?: boolean; ignoreIndent?: boolean; trimRight?: boolean }
  ): number {
    if (needle.length === 0) return 0;
    const normNeedle0 = this.normalizeLineForCompare(needle[0], opts);
    for (let i = 0; i + needle.length <= hay.length; i++) {
      const h0 = this.normalizeLineForCompare(hay[i], opts);
      if (h0 !== normNeedle0) continue;
      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        const hj = this.normalizeLineForCompare(hay[i + j], opts);
        const nj = this.normalizeLineForCompare(needle[j], opts);
        if (hj !== nj) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  // ---------- Patch safety helpers ----------
  private subseqEqualsAt(
    hay: string[],
    start: number,
    needle: string[],
    opts?: { ignoreWs?: boolean; ignoreIndent?: boolean; trimRight?: boolean }
  ): boolean {
    if (start < 0) return false;
    if (needle.length === 0) return true;
    if (start + needle.length > hay.length) return false;
    for (let j = 0; j < needle.length; j++) {
      const hj = this.normalizeLineForCompare(hay[start + j], opts);
      const nj = this.normalizeLineForCompare(needle[j], opts);
      if (hj !== nj) return false;
    }
    return true;
  }

  private findAllSubsequenceAdv(
    hay: string[],
    needle: string[],
    opts?: { ignoreWs?: boolean; ignoreIndent?: boolean; trimRight?: boolean }
  ): number[] {
    const out: number[] = [];
    if (needle.length === 0) return out;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (this.subseqEqualsAt(hay, i, needle, opts)) out.push(i);
    }
    return out;
  }

  private countSubsequenceAdv(
    hay: string[],
    needle: string[],
    opts?: { ignoreWs?: boolean; ignoreIndent?: boolean; trimRight?: boolean }
  ): number {
    if (needle.length === 0) return 0;
    let count = 0;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (this.subseqEqualsAt(hay, i, needle, opts)) {
        count++;
        i += Math.max(0, needle.length - 1); // non-overlapping by default
      }
    }
    return count;
  }

  private buildHunkSequences(hunkLines: string[]) {
    const oldSeq = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('-'))
      .map(l => l.slice(1));
    const newSeq = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('+'))
      .map(l => l.slice(1));
    const minusOnly = hunkLines.filter(l => l.startsWith('-')).map(l => l.slice(1));
    const plusOnly = hunkLines.filter(l => l.startsWith('+')).map(l => l.slice(1));

    const leadingCtx: string[] = [];
    for (const l of hunkLines) {
      if (l.startsWith(' ')) leadingCtx.push(l.slice(1));
      else break;
    }
    const trailingCtx: string[] = [];
    for (let i = hunkLines.length - 1; i >= 0; i--) {
      const l = hunkLines[i];
      if (l.startsWith(' ')) trailingCtx.unshift(l.slice(1));
      else break;
    }
    return { oldSeq, newSeq, minusOnly, plusOnly, leadingCtx, trailingCtx };
  }

  private ctxMatchesAroundMinusOnly(
    hay: string[],
    idxMinus: number,
    minusLen: number,
    leadingCtx: string[],
    trailingCtx: string[]
  ): boolean {
    const opts = { ignoreWs: true, ignoreIndent: false, trimRight: true };
    if (leadingCtx.length) {
      const start = idxMinus - leadingCtx.length;
      if (start < 0) return false;
      if (!this.subseqEqualsAt(hay, start, leadingCtx, opts)) return false;
    }
    if (trailingCtx.length) {
      const start = idxMinus + minusLen;
      if (start + trailingCtx.length > hay.length) return false;
      if (!this.subseqEqualsAt(hay, start, trailingCtx, opts)) return false;
    }
    return true;
  }

  private validateHunkEffect(
    before: string[],
    after: string[],
    seq: { oldSeq: string[]; newSeq: string[]; minusOnly: string[]; plusOnly: string[] }
  ): { ok: boolean; reason?: string } {
    const opts = { ignoreWs: true, trimRight: true };
    const beforeMinus = seq.minusOnly.length ? this.countSubsequenceAdv(before, seq.minusOnly, opts) : 0;
    const afterMinus = seq.minusOnly.length ? this.countSubsequenceAdv(after, seq.minusOnly, opts) : 0;
    const beforeOld = seq.oldSeq.length ? this.countSubsequenceAdv(before, seq.oldSeq, opts) : 0;
    const afterOld = seq.oldSeq.length ? this.countSubsequenceAdv(after, seq.oldSeq, opts) : 0;

    if (seq.minusOnly.length) {
      // MUST reduce either full-old match count or minus-only match count,
      // otherwise we likely inserted without removing (duplication).
      if (!(afterMinus < beforeMinus || afterOld < beforeOld)) {
        return { ok: false, reason: 'No removals detected; refusing to apply (would duplicate content)' };
      }
    }
    if (seq.plusOnly.length) {
      const hasNewSeq = seq.newSeq.length ? (this.findSubsequenceAdv(after, seq.newSeq, opts) !== -1) : true;
      const hasPlusOnly = this.findSubsequenceAdv(after, seq.plusOnly, opts) !== -1;
      if (!(hasNewSeq || hasPlusOnly)) {
        return { ok: false, reason: 'No additions detected after apply' };
      }
    }
    return { ok: true };
  }

  private tryReplacementByMinusOnly(
    curLines: string[],
    seq: { oldSeq: string[]; newSeq: string[]; minusOnly: string[]; plusOnly: string[]; leadingCtx: string[]; trailingCtx: string[] },
    hintIndex?: number
  ): { ok: boolean; next?: string[]; note?: string } {
    if (!seq.minusOnly.length) return { ok: false };
    const opts = { ignoreWs: true, trimRight: true };
    const idxs = this.findAllSubsequenceAdv(curLines, seq.minusOnly, opts);
    if (!idxs.length) return { ok: false };

    // Prefer indices where surrounding context matches (if context exists)
    const ctxIdxs = idxs.filter(i => this.ctxMatchesAroundMinusOnly(curLines, i, seq.minusOnly.length, seq.leadingCtx, seq.trailingCtx));
    const candidates = ctxIdxs.length ? ctxIdxs : (idxs.length === 1 ? idxs : []);
    if (!candidates.length) {
      return { ok: false, note: 'minusOnly matched multiple times but context did not disambiguate' };
    }

    // Choose nearest to hint if provided
    let chosen = candidates[0];
    if (typeof hintIndex === 'number' && Number.isFinite(hintIndex)) {
      let bestDist = Math.abs(chosen - hintIndex);
      for (const c of candidates) {
        const d = Math.abs(c - hintIndex);
        if (d < bestDist) { bestDist = d; chosen = c; }
      }
    }

    // Duplication guard: if plusOnly is immediately adjacent, prefer deletion-only
    const plusLen = seq.plusOnly.length;
    const minusLen = seq.minusOnly.length;
    const plusBefore = plusLen > 0 && this.subseqEqualsAt(curLines, chosen - plusLen, seq.plusOnly, opts);
    const plusAfter = plusLen > 0 && this.subseqEqualsAt(curLines, chosen + minusLen, seq.plusOnly, opts);

    if ((plusBefore || plusAfter) && plusLen > 0) {
      const next = [...curLines.slice(0, chosen), ...curLines.slice(chosen + minusLen)];
      return { ok: true, next, note: 'Detected duplicated apply (plus adjacent). Deleted minusOnly without reinserting.' };
    }

    // Normal: replace removed lines with added lines at same spot
    const next = [
      ...curLines.slice(0, chosen),
      ...seq.plusOnly,
      ...curLines.slice(chosen + minusLen)
    ];
    return { ok: true, next, note: 'Applied replacement via minusOnly match (context-anchored)' };
  }


  // Enhanced hunk applier variant that leverages the header's oldStart as a locality hint.
  // Falls back to the legacy applyHunkToText if needed.
  private applyHunkToTextWithHint(
    current: string,
    hunkLines: string[],
    hint?: { approxIndex?: number }
  ) {
    // Reuse the legacy implementation but first attempt localized windowed strategies.
    // Clone of core logic with window-constrained attempts and insertion reindent option.
    const beforeLinesSnapshot = current.replace(/\r\n/g, '\n').split('\n');
    const curLines = current.replace(/\r\n/g, '\n').split('\n');
    const oldItems = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('-'))
      .map(l => ({ kind: l[0] as ' ' | '-', text: l.slice(1) }));
    const newSeq = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('+'))
      .map(l => l.slice(1));
    
    const { oldSeq, minusOnly, plusOnly, leadingCtx, trailingCtx } = this.buildHunkSequences(hunkLines);

    // Idempotency/duplication guards (same as legacy)
    const hasNewExact = this.findSubsequence(curLines, newSeq, false) !== -1;
    const hasNewWs = this.findSubsequence(curLines, newSeq, true) !== -1;
    if (minusOnly.length === 0 && plusOnly.length > 0) {
      if (hasNewExact || hasNewWs) {
        return { ok: true as const, text: current, note: 'Insertion already present; skipping' };
      }
    }
    if (minusOnly.length > 0 && plusOnly.length > 0) {
      // Only skip if the NEW exists and the OLD (or removed lines) are not present anymore.
      const opts = { ignoreWs: true, trimRight: true };
      const oldStillThere = (oldSeq.length ? this.findSubsequenceAdv(curLines, oldSeq, opts) !== -1 : false);
      const minusStillThere = (minusOnly.length ? this.findSubsequenceAdv(curLines, minusOnly, opts) !== -1 : false);
      if ((hasNewExact || hasNewWs) && !oldStillThere && !minusStillThere) {
        return { ok: true as const, text: current, note: 'Replacement already present; skipping' };
      }
    }
    if (plusOnly.length === 0 && minusOnly.length > 0) {
      const minusContigExact = this.findSubsequence(curLines, minusOnly, false) !== -1;
      const minusContigWs = this.findSubsequence(curLines, minusOnly, true) !== -1;
      if (!minusContigExact && !minusContigWs) {
        return { ok: true as const, text: current, note: 'Deletion already applied; skipping' };
      }
    }

    // If we have an approxIndex hint, try localized windowed searches first
    const approx = hint?.approxIndex;
    const tryWindow = (radiusA: number, radiusB: number) => {
      if (approx == null || approx < 0) return null as { ok: boolean; text?: string; via?: any; note?: string } | null;
      const start = Math.max(0, approx - radiusA);
      const end = Math.min(curLines.length, approx + radiusB);
      const win = curLines.slice(start, end);

      const accept = (nextLines: string[], via: any, note?: string) => {
        const v = this.validateHunkEffect(curLines, nextLines, { oldSeq, newSeq, minusOnly, plusOnly });
        if (!v.ok) return null;
        return { ok: true, text: nextLines.join('\n'), via, note };
      };

      // A) exact contiguous in window
      let idx = this.findSubsequence(win, oldSeq, false);
      if (idx !== -1) {
        const abs = start + idx;
        const nextLines = [
          ...curLines.slice(0, abs),
          ...newSeq,
          ...curLines.slice(abs + oldSeq.length)
        ];
        const r = accept(nextLines, 'exact');
        if (r) return r;
      }
      // B) whitespace-insensitive contiguous in window
      idx = this.findSubsequence(win, oldSeq, true);
      if (idx !== -1) {
        const abs = start + idx;
        const nextLines = [
          ...curLines.slice(0, abs),
          ...newSeq,
          ...curLines.slice(abs + oldSeq.length)
        ];
        const r = accept(nextLines, 'whitespace');
        if (r) return r;
      }
      // C) indentation-insensitive contiguous in window
      {
        const idxIndent = this.findSubsequenceAdv(win, oldSeq, { ignoreIndent: true, trimRight: true });
        if (idxIndent !== -1) {
          const abs = start + idxIndent;
          const nextLines = [
            ...curLines.slice(0, abs),
            ...newSeq,
            ...curLines.slice(abs + oldSeq.length)
          ];
          const r = accept(nextLines, 'indent');
          if (r) return r;
        }
      }
      // D) ordered-with-slop in window (bounded)
      {
        const ordered = this.findOrderedWithSlop(win, oldSeq, { ignoreWs: true, trimRight: true }, 3, 500);
        if (ordered) {
          let startIdx = ordered.start;
          let endIdx = ordered.end;
          const ctxIdxsInSeq: number[] = [];
          oldItems.forEach((it, i) => { if (it.kind === ' ') ctxIdxsInSeq.push(i); });
          if (ctxIdxsInSeq.length >= 1) {
            const firstCtxIdx = ctxIdxsInSeq[0];
            const lastCtxIdx = ctxIdxsInSeq[ctxIdxsInSeq.length - 1];
            if (firstCtxIdx < ordered.indexes.length && lastCtxIdx < ordered.indexes.length) {
              startIdx = ordered.indexes[firstCtxIdx];
              endIdx = ordered.indexes[lastCtxIdx];
            }
          }
          const absStart = start + startIdx;
          const absEnd = start + endIdx;
          const nextLines = [
            ...curLines.slice(0, absStart),
            ...newSeq,
            ...curLines.slice(absEnd + 1)
          ];
          const r = accept(nextLines, 'ordered', 'Applied with slop window (hinted)');
          if (r) return r;
        }
      }
      return null;
    };

    // If pure insertion, try to anchor near hint via leading/trailing context and adjust indentation
    if (minusOnly.length === 0 && plusOnly.length > 0) {
      // Try windowed anchor first
      const tryIns = () => {
        const leadingCtx: string[] = [];
        for (const l of hunkLines) {
          if (l.startsWith(' ')) leadingCtx.push(l.slice(1)); else break;
        }
        let insertPos = -1;
        if (leadingCtx.length > 0) {
          // windowed search for leading context
          if (approx != null && approx >= 0) {
            const start = Math.max(0, approx - 80);
            const end = Math.min(curLines.length, approx + 300);
            const win = curLines.slice(start, end);
            let idx = this.findSubsequenceAdv(win, leadingCtx, { ignoreWs: true, trimRight: true });
            if (idx !== -1) insertPos = start + idx + leadingCtx.length;
          }
          if (insertPos === -1) {
            let idx = this.findSubsequenceAdv(curLines, leadingCtx, { ignoreWs: true, trimRight: true });
            if (idx !== -1) insertPos = idx + leadingCtx.length;
          }
        }
        if (insertPos === -1) {
          const trailingCtx: string[] = [];
          for (let i = hunkLines.length - 1; i >= 0; i--) {
            const l = hunkLines[i];
            if (l.startsWith(' ')) trailingCtx.unshift(l.slice(1));
            else break;
          }
          if (trailingCtx.length > 0) {
            if (approx != null && approx >= 0) {
              const start = Math.max(0, approx - 80);
              const end = Math.min(curLines.length, approx + 300);
              const win = curLines.slice(start, end);
              let idx = this.findSubsequenceAdv(win, trailingCtx, { ignoreWs: true, trimRight: true });
              if (idx !== -1) insertPos = start + idx; // before trailing
            }
            if (insertPos === -1) {
              let idx = this.findSubsequenceAdv(curLines, trailingCtx, { ignoreWs: true, trimRight: true });
              if (idx !== -1) insertPos = idx; // before trailing
            }
          }
        }
        if (insertPos === -1) return null;
        const next = [
          ...curLines.slice(0, insertPos),
          ...plusOnly,
          ...curLines.slice(insertPos)
        ];
        return { ok: true, text: next.join('\n'), via: 'insert', note: 'Pure insertion (verbatim)' };
      };
      const insRes = tryIns();
      if (insRes) return insRes;
    }

    // Replacement fallback: if we couldn't match full oldSeq, try context-anchored minusOnly.
    if (minusOnly.length > 0 && plusOnly.length > 0) {
      const rep = this.tryReplacementByMinusOnly(curLines, { oldSeq, newSeq, minusOnly, plusOnly, leadingCtx, trailingCtx }, approx);
      if (rep.ok && rep.next) {
        const v = this.validateHunkEffect(curLines, rep.next, { oldSeq, newSeq, minusOnly, plusOnly });
        if (v.ok) {
          return { ok: true, text: rep.next.join('\n'), via: 'fuzzy', note: rep.note };
        }
      }
    }

    // Localized replacement attempts (windowed)
    if (approx != null && approx >= 0 && oldSeq.length > 0) {
      // Try a small then larger window
      const small = tryWindow(30, 120);
      if (small) return small;
      const big = tryWindow(80, 400);
      if (big) return big;
    }

    // Fallback to legacy full-document strategies
    return this.applyHunkToText(current, hunkLines);
  }

  private async applyUnifiedDiffBlock(
    diffBlock: string,
    counters?: { udiff: number; openai: number; edit: number; whitespace: number; fuzzy: number }
  ): Promise<{ success: boolean; details: string; count: number }> {
    const files = this.parseUnifiedDiff(diffBlock);
    if (!files.length) return { success: false, details: 'Empty or invalid unified diff.', count: 0 };

    const strategy = newUnifiedDiffStrategy.create(0.8);
    let changed = 0;
    const errors: string[] = [];

    for (const file of files) {
      const oldP = file.oldPath;
      const newP = file.newPath;

      // Added file
      if (oldP === '/dev/null' && newP && newP !== '/dev/null') {
        const contentLines: string[] = [];
        for (const h of file.hunks) {
          for (const l of h.lines) {
            if (l.startsWith('+')) { contentLines.push(l.slice(1)); }
            else if (l.startsWith(' ')) { contentLines.push(l.slice(1)); }
          }
        }
        await this.writeWorkspaceFile(newP, contentLines.join('\n'));
        changed++;
        if (counters) { counters.udiff++; }
        continue;
      }

      // Deleted file
      if (newP === '/dev/null' && oldP && oldP !== '/dev/null') {
        await this.deleteWorkspaceFile(oldP);
        changed++;
        if (counters) { counters.udiff++; }
        continue;
      }

      const targetPath = newP || oldP;
      if (!targetPath) {
        errors.push('Missing target path in diff.');
        continue;
      }

      const originalContent = (await this.readWorkspaceFileOptional(targetPath)) ?? '';

      // Reconstruct a per-file unified diff to pass to diff-apply
      const perFileDiff =
        `--- a/${targetPath}\n+++ b/${targetPath}\n` +
        file.hunks.map(h => `${h.header}\n${h.lines.join('\n')}`).join('\n') + '\n';

      const result = await strategy.applyDiff({ originalContent, diffContent: perFileDiff });

      if (!result.success) {
        errors.push(`${targetPath}: ${result.error ?? 'Unknown error'}`);
        continue;
      }

      await this.writeWorkspaceFile(targetPath, result.content);
      changed++;
      if (counters) { counters.udiff++; }
    }

    if (changed === 0 && errors.length > 0) {
      return { success: false, details: errors.join('; '), count: 0 };
    }
    if (errors.length > 0) {
      return { success: true, details: `Applied with errors: ${errors.join('; ')}`, count: changed };
    }
    return { success: true, details: `Applied ${changed} file(s)`, count: changed };
  }

  private async applyEditBlock(eb: { file?: string; search: string; replace: string }): Promise<{ success: boolean; details: string; count: number }> {
    const relCandidates: string[] = [];
    if (eb.file) {
      relCandidates.push(eb.file.replace(/^[.][\\/]/, '').replace(/\\/g, '/'));
    } else {
      // Find a file in the workspace that contains the search block
      const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,build}/**', 10000);
      for (const u of files) relCandidates.push(vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'));
    }
    const explicitFile = !!eb.file;
    const search = eb.search.replace(/\r\n/g, '\n');
    const replace = eb.replace.replace(/\r\n/g, '\n');
    let changed = 0;
    let ambiguous = false;
    for (const rel of relCandidates) {
      const before = await this.readWorkspaceFileOptional(rel);
      if (before == null) continue;
      // Try exact match first (unique only)
      const firstIdx = before.indexOf(search);
      if (firstIdx !== -1) {
        const secondIdx = before.indexOf(search, firstIdx + search.length);
        if (secondIdx !== -1) {
          if (explicitFile) {
            return { success: false, details: `SEARCH block found multiple times in ${rel}; refusing to apply ambiguous EditBlock.`, count: 0 };
          }
          ambiguous = true;
          continue;
        }
        const after = before.slice(0, firstIdx) + replace + before.slice(firstIdx + search.length);
        if (after !== before) {
          await this.writeWorkspaceFile(rel, after);
          changed++;
          break; // one file is enough for this block
        }
      } else {
        // Whitespace-insensitive attempt
        const normBefore = this.normalizeWs(before);
        const normSearch = this.normalizeWs(search);
        const pos = normBefore.indexOf(normSearch);
        if (pos !== -1) {
          // Fallback: naive replacement by mapping positions in normalized space is tricky.
          // As a safer fallback, try to locate by first and last line of the search block.
          const sLines = search.split('\n');
          const first = sLines[0], last = sLines[sLines.length - 1];
          const beforeLines = before.split('\n');
          const firstIdxs = this.findAllLineMatches(beforeLines, first);
          let applied = false;
          for (const i of firstIdxs) {
            // check tail
            if (i + sLines.length <= beforeLines.length) {
              let ok = true;
              for (let k = 0; k < sLines.length; k++) {
                if (this.normalizeWs(beforeLines[i + k]) !== this.normalizeWs(sLines[k])) { ok = false; break; }
              }
              if (ok) {
                const afterLines = [
                  ...beforeLines.slice(0, i),
                  ...replace.split('\n'),
                  ...beforeLines.slice(i + sLines.length)
                ];
                await this.writeWorkspaceFile(rel, afterLines.join('\n'));
                changed++;
                applied = true;
                break;
              }
            }
          }
          if (applied) break;
        }
      }
    }
    if (changed === 0) {
      const extra = ambiguous ? ' (Note: found multiple ambiguous matches and refused to apply.)' : '';
      return { success: false, details: 'SEARCH block not found in workspace (even with whitespace tolerance).' + extra, count: 0 };
    }
    return { success: true, details: `EditBlock applied to ${changed} file(s).`, count: changed };
  }


  public addFileToChat(relativePath: string, fileContent: string, fileExtension: string) {
    let codeBlock = `**${relativePath}**\n\`\`\`${fileExtension}\n${fileContent}\n\`\`\``;

    let newMessage: UserMessage = {
      role: "user",
      content: codeBlock,
      selected: true
    };

    this._messages?.push(newMessage);
    const idx = this._messages ? this._messages.length - 1 : 0;
    this._view?.webview.postMessage({ type: 'setCollapsedForIndex', index: idx });

    const chat_response = this._updateChatMessages(this._getMessagesNumberOfTokens(), 0);
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
  }

  public addTreeToChat(treeText: string, title = 'Selected tree') {
    const content = `**${title}**\n\`\`\`text\n${treeText}\n\`\`\``;
    let newMessage: UserMessage = {
      role: "user",
      content,
      selected: true
    };

    this._messages?.push(newMessage);
    const idx = this._messages ? this._messages.length - 1 : 0;
    this._view?.webview.postMessage({ type: 'setCollapsedForIndex', index: idx });

    const chat_response = this._updateChatMessages(this._getMessagesNumberOfTokens(), 0);
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
  }

  // Adds a lightweight reference to a file; the actual content is injected only when sending.
  public addFileReferenceToChat(relativePath: string, _fileExtension: string) {
    // Show a readable reference and embed a hidden marker for later expansion.
    const content =
      `File reference: \`${relativePath}\`\n` +
      `<!--FILE:${relativePath}-->`;
    let newMessage: UserMessage = {
      role: "user",
      content,
      selected: true,
      moveToEnd: true
    };
    this._messages?.push(newMessage);
    const idx = this._messages ? this._messages.length - 1 : 0;
    this._view?.webview.postMessage({ type: 'setCollapsedForIndex', index: idx });
    const chat_response = this._updateChatMessages(this._getMessagesNumberOfTokens(), 0);
    this._view?.webview.postMessage({ type: 'addResponse', value: chat_response });
  }
}