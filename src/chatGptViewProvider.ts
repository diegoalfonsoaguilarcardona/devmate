import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as yaml from 'js-yaml';
import OpenAI from "openai";
import { encodingForModel } from "js-tiktoken";
import { AuthInfo, Settings, Message, Provider, Prompt, UserMessage, SystemMessage, AssistantMessage, BASE_URL } from './types';
import { ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionContentPartText } from 'openai/resources/chat/completions';
import { TextDecoder } from 'util';

export class ChatGPTViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'devmate.chatView';
  private _view?: vscode.WebviewView;

  private _conversation?: any;
  private _messages?: Message[];
  private _openai?: OpenAI;

  private _response?: string;
  private _totalNumberOfTokens?: number;
  private _prompt?: string;
  private _fullPrompt?: string;
  private _currentMessageNumber = 0;
  private _enc = encodingForModel("gpt-4"); //Hardcoded for now

  private _settings: Settings = {
    selectedInsideCodeblock: false,
    codeblockWithLanguageId: false,
    pasteOnClick: true,
    keepConversation: true,
    timeoutLength: 60,
    apiUrl: BASE_URL,
    apiType: 'chatCompletions',
    model: 'gpt-3.5-turbo',
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
            // If the clicked code is a diff/patch, ask to apply it; otherwise keep the paste behavior
            const code = String(data.value || '');
            if (this.isLikelyDiffContent(code)) {
              const choice = await vscode.window.showInformationMessage(
                'Detected diff content from chat. Do you want to apply this patch to the workspace?',
                { modal: true },
                'Apply Patch',
                'Insert as Text',
                'Cancel'
              );
              if (choice === 'Apply Patch') {
                const res = await this.applyPatchText(code);
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
              const tokenList = this._enc.encode(partial);
              const chat_response = this._updateChatMessages(this._getMessagesNumberOfTokens(), tokenList.length);
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
        return { ...msg, collapsed, moveToEnd };
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
        return { ...msg, selected, collapsed, moveToEnd } as Message;
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

  private _getMessagesNumberOfTokens() {

    let full_promt = "";
    if (this._messages) {
      for (const message of this._messages) {
        if (message.selected) {
          full_promt += "\n# <u>" + message.role.toUpperCase() + "</u>:\n" + message.content;
        }
      }
    }

    const tokenList = this._enc.encode(full_promt);
    return tokenList.length;
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
      });
    }

    // Inform the webview about "move reference to end" toggles so it can render checked states
    if (this._messages && this._messages.length > 0) {
      this._messages.forEach((m, idx) => {
        if ((m as any).moveToEnd) {
          this._view?.webview.postMessage({ type: 'setMoveRefToEndForIndex', index: idx, value: true });
        }
      });
    }

    if (this._totalNumberOfTokens !== undefined) {
      this._totalNumberOfTokens += promtNumberOfTokens + completionTokens;

      // NEW: send stats to the webview (always visible status row)
      this._view?.webview.postMessage({
        type: 'updateStats',
        value: {
          totalTokens: this._totalNumberOfTokens,
          usedTokens: promtNumberOfTokens + completionTokens,
          promptTokens: promtNumberOfTokens,
          completionTokens,
          model: this._settings.model
        }
      });
    }

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

      // Expand any file reference markers to current file contents
      messagesToSend = this.expandFileReferencesInMessages(messagesToSend);

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

          let completionTokens = 0;
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
                const tokenList = this._enc.encode(content);
                completionTokens += tokenList.length;
                full_message += content;
                deltaAccumulator += content;
                flushDelta(false);
                continue;
              }
              if (t === 'response.output_text.done') { postProgress('--- output_text.done ---'); continue; }
              // Reasoning summary text stream (new event names)
              if (t === 'response.reasoning_summary_text.delta') {
                const d = (event as any)?.delta ?? '';
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
            const outputArr: any[] = (finalResp as any)?.output || [];
            const reasoningItem = outputArr.find((o: any) => o?.type === 'reasoning');
            const summaryText =
              (reasoningItem?.summary || [])
                .map((p: any) => p?.text || '')
                .filter(Boolean)
                .join('\n') || '';
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
          const tokenList = this._enc.encode(full_message);
          chat_response = this._updateChatMessages(promtNumberOfTokens, tokenList.length);
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
          const postReason = (s: string) =>
            this._view?.webview.postMessage({ type: 'appendReasoningDelta', value: s.endsWith('\n') ? s : s + '\n' });
          const reader = (res as any).body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buf = '';
          let full_message_g = '';
          let lastSend = 0;
          let deltaAccumulator = '';
          let finalGrounding: any = null;
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
                // Extract delta text
                const cand = obj?.candidates?.[0];
                const parts = cand?.content?.parts || [];
                let delta = '';
                for (const p of parts) {
                  if (typeof p?.text === 'string') delta += p.text;
                }
                if (delta) {
                  full_message_g += delta;
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
              this._messages?.push({ role: "assistant", content: lines.join('\n'), selected: false, collapsed: true });
              const chat_progress = this._updateChatMessages(0, 0);
              this._view?.webview.postMessage({ type: 'addResponse', value: chat_progress });
            }
          }
          // Final assistant message
          this._messages?.push({ role: "assistant", content: full_message_g, selected: true });
          const tokenList = this._enc.encode(full_message_g);
          chat_response = this._updateChatMessages(promtNumberOfTokens, tokenList.length);
        } else {
        // Default Chat Completions flow
        const stream = await this._openai.chat.completions.create({
          model: this._settings.model,
          messages: messagesToSend,
          stream: true,
          ...this._settings.options, // Spread operator to include all keys from options
        });

        console.log("Message sender created");

        this._view?.webview.postMessage({ type: 'streamStart' });

        let completionTokens = 0;
        full_message = "";
        // Collect reasoning deltas if configured (e.g., OpenRouter reasoning models)
        let reasoningDeltaCC = "";

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
            const content = (chunk as any).choices?.[0]?.delta?.content || "";
            console.log("chunk:", chunk);
            console.log("content:", content);
            // Extract reasoning delta if a path was configured
            if (this._settings.reasoningOutputDeltaPath) {
              try {
                const rv = this.getValueAtPath(chunk, this._settings.reasoningOutputDeltaPath);
                if (rv !== undefined && rv !== null) {
                  const piece = (typeof rv === 'string') ? rv : this.safeStringify(rv, 1000);
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

            const tokenList = this._enc.encode(content);
            completionTokens += tokenList.length;
            console.log("tokens:", completionTokens);
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
        console.log("Full Number of tokens:", completionTokens);
        const tokenList = this._enc.encode(full_message);
        console.log("Full Number of tokens tiktoken:", tokenList.length);
          chat_response = this._updateChatMessages(promtNumberOfTokens, tokenList.length)
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
    const oldSeq = oldItems.map(x => x.text);
    const minusOnly = hunkLines.filter(l => l.startsWith('-')).map(l => l.slice(1));
    const plusOnly = hunkLines.filter(l => l.startsWith('+')).map(l => l.slice(1));

    // Idempotency guards
    const hasNewExact = newSeq.length ? this.findSubsequence(curLines, newSeq, false) !== -1 : false;
    const hasNewWs = newSeq.length ? this.findSubsequence(curLines, newSeq, true) !== -1 : false;
    const hasPlusExact = plusOnly.length ? this.findSubsequence(curLines, plusOnly, false) !== -1 : false;
    const hasPlusWs = plusOnly.length ? this.findSubsequence(curLines, plusOnly, true) !== -1 : false;
    if (minusOnly.length === 0 && plusOnly.length > 0) {
      if (hasNewExact || hasNewWs || hasPlusExact || hasPlusWs) {
        return { ok: true, text: current, note: 'Insertion already present; skipping' };
      }
    }
    if (minusOnly.length > 0 && plusOnly.length > 0) {
      if (hasNewExact || hasNewWs) {
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

    // Pure deletion
    if (plusOnly.length === 0 && minusOnly.length > 0) {
      let idx = this.findSubsequence(curLines, minusOnly, false);
      if (idx !== -1) {
        const next = [...curLines.slice(0, idx), ...curLines.slice(idx + minusOnly.length)];
        return { ok: true, text: next.join('\n'), via: 'delete' };
      }
      idx = this.findSubsequence(curLines, minusOnly, true);
      if (idx !== -1) {
        const next = [...curLines.slice(0, idx), ...curLines.slice(idx + minusOnly.length)];
        return { ok: true, text: next.join('\n'), via: 'whitespace' };
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
        // Try to preserve reasonable indentation relative to previous line
        const prevLine = insertPos > 0 ? curLines[insertPos - 1] : '';
        const targetIndent = this.getIndentString(prevLine);
        const baseIndent = this.minCommonIndent(plusOnly);
        const reindented = plusOnly.map(line => {
          if (line.trim().length === 0) return line;
          const curIndent = this.getIndentString(line);
          const delta = curIndent.length - baseIndent.length;
          if (delta <= 0) return targetIndent + line.slice(curIndent.length);
          return targetIndent + ' '.repeat(delta) + line.slice(curIndent.length);
        });
        const next = [...curLines.slice(0, insertPos), ...reindented, ...curLines.slice(insertPos)];
        return { ok: true, text: next.join('\n'), via: 'insert' };
      }
    }

    // Replacement: try contiguous exact, whitespace, indentation, then ordered-with-slop
    if (oldSeq.length > 0) {
      let idx = this.findSubsequence(curLines, oldSeq, false);
      if (idx !== -1) {
        const next = [...curLines.slice(0, idx), ...newSeq, ...curLines.slice(idx + oldSeq.length)];
        return { ok: true, text: next.join('\n'), via: 'exact' };
      }
      idx = this.findSubsequence(curLines, oldSeq, true);
      if (idx !== -1) {
        const next = [...curLines.slice(0, idx), ...newSeq, ...curLines.slice(idx + oldSeq.length)];
        return { ok: true, text: next.join('\n'), via: 'whitespace' };
      }
      const idxIndent = this.findSubsequenceAdv(curLines, oldSeq, { ignoreIndent: true, trimRight: true });
      if (idxIndent !== -1) {
        const next = [...curLines.slice(0, idxIndent), ...newSeq, ...curLines.slice(idxIndent + oldSeq.length)];
        return { ok: true, text: next.join('\n'), via: 'indent' };
      }
      const ordered = this.findOrderedWithSlop(curLines, oldSeq, { ignoreWs: true, trimRight: true }, 3, 1200);
      if (ordered) {
        const next = [
          ...curLines.slice(0, ordered.start),
          ...newSeq,
          ...curLines.slice(ordered.end + 1)
        ];
        return { ok: true, text: next.join('\n'), via: 'ordered' };
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
      if (l.startsWith('@@ ')) {
        if (!curFile) continue;
        curHunk = { header: l, lines: [] };
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
    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders) {
      const abs = path.join(f.uri.fsPath, relPath);
      try {
        const data = await fsp.readFile(abs, 'utf8');
        return data.replace(/\r\n/g, '\n');
      } catch {
        // try next folder
      }
    }
    return null;
  }

  private async writeWorkspaceFile(relPath: string, content: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('No workspace folder.');
    const base = folders[0].uri.fsPath;
    const abs = path.join(base, relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }

  private async deleteWorkspaceFile(relPath: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('No workspace folder.');
    const base = folders[0].uri.fsPath;
    const abs = path.join(base, relPath);
    try {
      await fsp.unlink(abs);
    } catch {
      // ignore if already gone
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
    // Unified diff markers or OpenAI Patch or EditBlock
    return (
      /^\s*---\s+(?:a\/|\/dev\/null|[^\s])/m.test(s) ||
      /^\s*\*\*\*\s+Begin Patch/m.test(s) ||
      /^(###\s+FILE: )/m.test(s) ||
      /^\s*<<<<<<<\s*SEARCH[\s\S]*?>>>>>>>\s*REPLACE/m.test(s)
    );
  }

  private async applyPatchText(rawText: string): Promise<{ success: boolean; details: string }> {
    try {
      // Extract one or more patch blocks we know how to process
      const unifiedBlocks = this.extractUnifiedDiffBlocks(rawText);
      const openAiBlocks = this.extractOpenAIPatchBlocks(rawText);
      const editBlocks = this.extractEditBlocks(rawText);

      let appliedFiles = 0;
      let appliedVia = { udiff: 0, openai: 0, edit: 0, fuzzy: 0, whitespace: 0 };

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
        `(udiff:${appliedVia.udiff}, openai:${appliedVia.openai}, edit:${appliedVia.edit},` +
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
    const re = /(^|\n)###\s+FILE:\s+([^\r\n]+)\s*\n+``​`(?:diff)?\s*([\s\S]*?)``​`/g;
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
    const m = h.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  }

  // Simple indentation helpers for insertion cases
  private getIndentString(s: string): string {
    const m = s.match(/^[ \t]*/);
    return m ? m[0] : '';
  }
  private minCommonIndent(lines: string[]): string {
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (!nonEmpty.length) return '';
    let min: number | null = null;
    for (const l of nonEmpty) {
      const ind = this.getIndentString(l).length;
      if (min === null || ind < min) min = ind;
    }
    return ' '.repeat(min || 0);
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
  // Enhanced hunk applier variant that leverages the header's oldStart as a locality hint.
  // Falls back to the legacy applyHunkToText if needed.
  private applyHunkToTextWithHint(
    current: string,
    hunkLines: string[],
    hint?: { approxIndex?: number }
  ) {
    // Reuse the legacy implementation but first attempt localized windowed strategies.
    // Clone of core logic with window-constrained attempts and insertion reindent option.
    const curLines = current.replace(/\r\n/g, '\n').split('\n');
    const oldItems = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('-'))
      .map(l => ({ kind: l[0] as ' ' | '-', text: l.slice(1) }));
    const newSeq = hunkLines
      .filter(l => l.startsWith(' ') || l.startsWith('+'))
      .map(l => l.slice(1));
    const oldSeq = oldItems.map(x => x.text);
    const minusOnly = hunkLines.filter(l => l.startsWith('-')).map(l => l.slice(1));
    const plusOnly = hunkLines.filter(l => l.startsWith('+')).map(l => l.slice(1));

    // Idempotency/duplication guards (same as legacy)
    const hasNewExact = this.findSubsequence(curLines, newSeq, false) !== -1;
    const hasNewWs = this.findSubsequence(curLines, newSeq, true) !== -1;
    const hasPlusExact = plusOnly.length > 0 ? this.findSubsequence(curLines, plusOnly, false) !== -1 : false;
    const hasPlusWs = plusOnly.length > 0 ? this.findSubsequence(curLines, plusOnly, true) !== -1 : false;
    if (minusOnly.length === 0 && plusOnly.length > 0) {
      if (hasNewExact || hasNewWs || hasPlusExact || hasPlusWs) {
        return { ok: true as const, text: current, note: 'Insertion already present; skipping' };
      }
    }
    if (minusOnly.length > 0 && plusOnly.length > 0) {
      if (hasNewExact || hasNewWs) {
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

      // A) exact contiguous in window
      let idx = this.findSubsequence(win, oldSeq, false);
      if (idx !== -1) {
        const abs = start + idx;
        const next = [
          ...curLines.slice(0, abs),
          ...newSeq,
          ...curLines.slice(abs + oldSeq.length)
        ];
        return { ok: true, text: next.join('\n'), via: 'exact' };
      }
      // B) whitespace-insensitive contiguous in window
      idx = this.findSubsequence(win, oldSeq, true);
      if (idx !== -1) {
        const abs = start + idx;
        const next = [
          ...curLines.slice(0, abs),
          ...newSeq,
          ...curLines.slice(abs + oldSeq.length)
        ];
        return { ok: true, text: next.join('\n'), via: 'whitespace' };
      }
      // C) indentation-insensitive contiguous in window
      {
        const idxIndent = this.findSubsequenceAdv(win, oldSeq, { ignoreIndent: true, trimRight: true });
        if (idxIndent !== -1) {
          const abs = start + idxIndent;
          const next = [
            ...curLines.slice(0, abs),
            ...newSeq,
            ...curLines.slice(abs + oldSeq.length)
          ];
          return { ok: true, text: next.join('\n'), via: 'indent' };
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
          const next = [
            ...curLines.slice(0, absStart),
            ...newSeq,
            ...curLines.slice(absEnd + 1)
          ];
          return { ok: true, text: next.join('\n'), via: 'ordered', note: 'Applied with slop window (hinted)' };
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

        // Optional indentation preservation: align inserted lines to surrounding style
        const prevLine = insertPos > 0 ? curLines[insertPos - 1] : '';
        const targetIndent = this.getIndentString(prevLine);
        const baseIndent = this.minCommonIndent(plusOnly);
        const reindented = plusOnly.map(line => {
          if (line.trim().length === 0) return line; // keep blank lines
          const curIndent = this.getIndentString(line);
          // Compute relative indent delta from the baseIndent
          const delta = curIndent.length - baseIndent.length;
          if (delta <= 0) return targetIndent + line.slice(curIndent.length);
          // keep extra relative indentation beyond base
          return targetIndent + ' '.repeat(delta) + line.slice(curIndent.length);
        });
        const next = [
          ...curLines.slice(0, insertPos),
          ...reindented,
          ...curLines.slice(insertPos)
        ];
        return { ok: true, text: next.join('\n'), via: 'insert', note: 'Pure insertion with indent adjust' };
      };
      const insRes = tryIns();
      if (insRes) return insRes;
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

    let changed = 0;
    const rejections: Array<{
      path: string;
      hunkHeader: string;
      hunkText: string[];
      reason: string;
    }> = [];

    const stringifyHunk = (filePath: string, header: string, lines: string[]) =>
      `--- a/${filePath}\n+++ b/${filePath}\n${header}\n${lines.join('\n')}\n`;

    for (const file of files) {
      const oldP = file.oldPath;
      const newP = file.newPath;

      // Added file
      if (oldP === '/dev/null' && newP && newP !== '/dev/null') {
        let contentLines: string[] = [];
        for (const h of file.hunks) {
          for (const l of h.lines) {
            if (l.startsWith('+')) contentLines.push(l.slice(1));
            else if (l.startsWith(' ')) contentLines.push(l.slice(1));
          }
        }
        await this.writeWorkspaceFile(newP, contentLines.join('\n'));
        changed++;
        if (counters) counters.udiff++;
        continue;
      }

      // Deleted file
      if (newP === '/dev/null' && oldP && oldP !== '/dev/null') {
        await this.deleteWorkspaceFile(oldP);
        changed++;
        if (counters) counters.udiff++;
        continue;
      }

      const targetPath = newP || oldP;
      if (!targetPath) {
        rejections.push({
          path: '(unknown)',
          hunkHeader: '',
          hunkText: [],
          reason: 'Missing target path in diff.'
        });
        continue;
      }

      const before = (await this.readWorkspaceFileOptional(targetPath)) ?? '';
      let cur = before;
      let anyHunkApplied = false;
      let localAppliedVia: Array<'exact' | 'whitespace' | 'indent' | 'anchor' | 'ordered' | 'insert' | 'delete' | 'fuzzy'> = [];
      for (const h of file.hunks) {
        // Prefer hinted localized application using hunk header oldStart line number.
        let approxLine: number | null = null;
        try {
          approxLine = this.parseOldStartFromHunkHeader(h.header);
        } catch { /* ignore */ }
        const res = this.applyHunkToTextWithHint(cur, h.lines, {
          approxIndex: (approxLine != null ? Math.max(0, approxLine - 1) : undefined)
        });
        if (!res.ok || !res.text) {
          rejections.push({
            path: targetPath,
            hunkHeader: h.header,
            hunkText: h.lines,
            reason: res.note ? res.note : 'All strategies failed'
          });
          continue; // try next hunk without aborting the entire file
        }
        cur = res.text;
        anyHunkApplied = true;
        if (res.via) localAppliedVia.push(res.via);
      }

      if (anyHunkApplied && cur !== before) {
        await this.writeWorkspaceFile(targetPath, cur);
        changed++;
        if (counters) {
          counters.udiff++;
          if (localAppliedVia.includes('whitespace') || localAppliedVia.includes('indent')) counters.whitespace++;
          if (localAppliedVia.includes('fuzzy') || localAppliedVia.includes('anchor') || localAppliedVia.includes('ordered')) counters.fuzzy++;
        }
      }
    }

    // Write .rej files for any rejections
    if (rejections.length) {
      // Group by path
      const map = new Map<string, Array<{ hunkHeader: string; hunkText: string[]; reason: string }>>();
      for (const r of rejections) {
        if (!map.has(r.path)) map.set(r.path, []);
        map.get(r.path)!.push({ hunkHeader: r.hunkHeader, hunkText: r.hunkText, reason: r.reason });
      }
      for (const [p, items] of map.entries()) {
        const rejPath = `${p}.rej`;
        const body = items.map(it => {
          return `# REJECTED HUNK (reason: ${it.reason})\n${stringifyHunk(p, it.hunkHeader, it.hunkText)}\n`;
        }).join('\n');
        try {
          await this.writeWorkspaceFile(rejPath, body);
        } catch (e) {
          // ignore write errors
        }
      }
    }

    if (changed === 0 && rejections.length > 0) {
      return { success: false, details: `No hunks applied. ${rejections.length} rejected. See *.rej files.`, count: 0 };
    }
    if (rejections.length > 0) {
      return { success: true, details: `Applied with ${rejections.length} rejected hunk(s). See *.rej files.`, count: changed };
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
    const search = eb.search.replace(/\r\n/g, '\n');
    const replace = eb.replace.replace(/\r\n/g, '\n');
    let changed = 0;
    for (const rel of relCandidates) {
      const before = await this.readWorkspaceFileOptional(rel);
      if (before == null) continue;
      // Try exact match first
      if (before.includes(search)) {
        const after = before.split(search).join(replace);
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
    if (changed === 0) return { success: false, details: 'SEARCH block not found in workspace (even with whitespace tolerance).', count: 0 };
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