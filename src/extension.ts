import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { Provider, Prompt, ProviderSettings } from './types';
import { ChatGPTViewProvider } from './chatGptViewProvider';
import { TextDecoder } from 'util';

// Base URL for OpenAI API
const BASE_URL = 'https://api.openai.com/v1';

export function activate(context: vscode.ExtensionContext) {
	console.log('activating extension "devmate"');
    // ---------- Helpers: type detection and parsing ----------
    const IMG_SIG = {
        png: { mime: 'image/png', sig: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
        jpg: { mime: 'image/jpeg', sig: [0xFF, 0xD8] },
        gif87a: { mime: 'image/gif', str: 'GIF87a' },
        gif89a: { mime: 'image/gif', str: 'GIF89a' },
        webp: { mime: 'image/webp', riff: 'RIFF', webp: 'WEBP' },
        bmp: { mime: 'image/bmp', str: 'BM' }
    } as const;

    function bufferStartsWith(buf: Uint8Array, sig: ReadonlyArray<number> | string): boolean {
        if (typeof sig !== 'string') {
            if (buf.length < sig.length) return false;
            for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
            return true;
        }
        if (buf.length < sig.length) return false;
        for (let i = 0; i < sig.length; i++) if (buf[i] !== sig.charCodeAt(i)) return false;
        return true;
    }

    function asciiMatchAt(buf: Uint8Array, offset: number, str: string): boolean {
        if (offset < 0) return false;
        if (buf.length < offset + str.length) return false;
        for (let i = 0; i < str.length; i++) {
            if (buf[offset + i] !== str.charCodeAt(i)) return false;
        }
        return true;
    }

    function detectImageMimeFromBuffer(buf: Uint8Array): string | null {
        if (bufferStartsWith(buf, IMG_SIG.png.sig)) return IMG_SIG.png.mime;
        if (bufferStartsWith(buf, IMG_SIG.jpg.sig)) return IMG_SIG.jpg.mime;
        if (bufferStartsWith(buf, IMG_SIG.gif87a.str) || bufferStartsWith(buf, IMG_SIG.gif89a.str)) return 'image/gif';
        // WEBP: "RIFF" at 0..3 and "WEBP" at 8..11
        if (buf.length >= 12 && asciiMatchAt(buf, 0, 'RIFF') && asciiMatchAt(buf, 8, 'WEBP')) {
            return IMG_SIG.webp.mime;
        }
        if (bufferStartsWith(buf, IMG_SIG.bmp.str)) return IMG_SIG.bmp.mime;
        // SVG (text): look for "<svg" early on
        const head = new TextDecoder('utf-8').decode(buf.slice(0, Math.min(buf.length, 512)));
        if (/\<svg[\s>]/i.test(head)) return 'image/svg+xml';
        return null;
    }

    function isProbablyTextBuffer(buf: Uint8Array): boolean {
        // Fast binary checks
        if (buf.includes(0x00)) return false; // NUL byte strongly indicates binary
        const len = Math.min(buf.length, 4096);
        let suspicious = 0;
        for (let i = 0; i < len; i++) {
            const c = buf[i];
            // Allow TAB(9), LF(10), CR(13)
            if (c === 9 || c === 10 || c === 13) continue;
            // Printable ASCII
            if (c >= 32 && c <= 126) continue;
            // UTF-8 multi-byte: treat bytes >= 0xC2 as plausible text
            if (c >= 0xC2) continue;
            // Everything else is suspicious
            suspicious++;
        }
        return suspicious / (len || 1) < 0.3;
    }

    async function isTextFile(absPath: string): Promise<boolean> {
        try {
            const fd = await fsp.open(absPath, 'r');
            try {
                const { buffer, bytesRead } = await fd.read(new Uint8Array(4096), 0, 4096, 0);
                return isProbablyTextBuffer(buffer.subarray(0, bytesRead));
            } finally {
                await fd.close();
            }
        } catch {
            return false;
        }
    }

    async function detectImageMime(absPath: string): Promise<string | null> {
        try {
            const fd = await fsp.open(absPath, 'r');
            try {
                const { buffer, bytesRead } = await fd.read(new Uint8Array(64), 0, 64, 0);
                return detectImageMimeFromBuffer(buffer.subarray(0, bytesRead));
            } finally {
                await fd.close();
            }
        } catch {
            return null;
        }
    }

    async function readImageAsDataUrl(absPath: string, mime: string): Promise<string> {
        const data = await fsp.readFile(absPath);
        const b64 = data.toString('base64');
        return `data:${mime};base64,${b64}`;
    }

    function extractPathsFromText(text: string): string[] {
        // Capture ./foo, ../foo, or foo starting with ./ in tree output
        // Also handle lines like "├── ./dir/file.ext"
        const results: string[] = [];
        const re = /(?:^|\s)(\.{1,2}[\/\\][^\s]+|\.{1}[\/\\][^\s]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            let p = m[1].trim();
            // Strip trailing punctuation
            p = p.replace(/[,:;)]*$/, '');
            // Normalize ././style occurrences
            while (p.startsWith('././')) p = p.slice(2);
            results.push(p);
        }
        // De-duplicate preserving order
        const seen = new Set<string>();
        return results.filter(p => {
            const key = p;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function getWorkspaceRelativeAndAbsolute(relOrDotPath: string, baseFolder: vscode.WorkspaceFolder): { rel: string, abs: string } {
        let rel = relOrDotPath.replace(/^[.][\/\\]/, ''); // drop leading ./ or .\
        const abs = path.join(baseFolder.uri.fsPath, rel);
        return { rel: rel.replace(/\\/g, '/'), abs };
    }

    async function addPathAsReferenceOrImage(provider: ChatGPTViewProvider, abs: string, rel: string) {
        try {
            const st = await fsp.stat(abs);
            if (!st.isFile()) return { added: false, reason: 'not-file' };
        } catch {
            return { added: false, reason: 'missing' };
        }
        const mime = await detectImageMime(abs);
        if (mime) {
            const dataUrl = await readImageAsDataUrl(abs, mime);
            provider.addImageToChat(dataUrl, path.basename(abs));
            return { added: true, kind: 'image' as const };
        }
        if (await isTextFile(abs)) {
            const ext = path.extname(rel).substring(1);
            provider.addFileReferenceToChat(rel, ext);
            return { added: true, kind: 'text' as const };
        }
        return { added: false, reason: 'binary' };
    }

	// Get the settings from the extension's configuration
	const config = vscode.workspace.getConfiguration('devmate');

	// Create a new ChatGPTViewProvider instance and register it with the extension's context
	const provider = new ChatGPTViewProvider(context.extensionUri);

	let providers: Provider[] = config.get('providers') || [];
	console.log("Providers:", providers);

	let prompts: Prompt[] = config.get('prompts') || [];
	console.log("prompts:", prompts);

	let activate_provider_settings: ProviderSettings = {
	  model: "none",
	  apiUrl: BASE_URL,
	  apiKey: "none",
	  apiType: 'chatCompletions',
	  options: {
		maxModelTokens: 1000,
		maxResponseTokens: 1000,
		temperature: 1.0,
	  },
	};

	if (providers && providers.length > 0) {
		const firstProvider = providers[0];
		if (firstProvider.models && firstProvider.models.length > 0) {
			const firstModel = firstProvider.models[0];
            // Determine API type and URL based on model/provider configuration
            const apiType = firstModel.api || 'chatCompletions';
            const apiUrl =
                apiType === 'responses'
                    ? (firstProvider.responsesUrl || firstProvider.apiUrl || BASE_URL)
                    : (firstProvider.chatCompletionsUrl || firstProvider.apiUrl || BASE_URL);

			activate_provider_settings = {
			  model: firstModel.model_name,
              apiUrl,
			  apiKey: firstProvider.apiKey,
			  apiType,
			  options: {
				...firstModel.options, // Spread operator to include all keys from options
                // If tools are defined at model level, include them in options for convenience
                ...(firstModel.tools ? { tools: firstModel.tools } : {}),
                ...(firstModel as any).reasoning_output_delta_path ? { reasoning_output_delta_path: (firstModel as any).reasoning_output_delta_path } : {},
			  },
			};
		}
	}
	
	provider.setSettings({
	  selectedInsideCodeblock: config.get('selectedInsideCodeblock') || false,
	  codeblockWithLanguageId: config.get('codeblockWithLanguageId') || false,
	  pasteOnClick: config.get('pasteOnClick') || false,
	  keepConversation: config.get('keepConversation') || false,
	  timeoutLength: config.get('timeoutLength') || 60,
	  apiUrl: activate_provider_settings.apiUrl,
	  model: activate_provider_settings.model,
      apiType: activate_provider_settings.apiType,
	  options: {
		...activate_provider_settings.options, // Use spread operator to include all options
	  },
	});

	// Put configuration settings into the provider
	provider.setAuthenticationInfo({
		apiKey: activate_provider_settings.apiKey,
		apiUrl: activate_provider_settings.apiUrl
	});
	
	// Register the provider with the extension's context
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatGPTViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
	  vscode.commands.registerCommand('devmate.addFileToChat', async (uri: vscode.Uri) => {
		if (!uri || !uri.fsPath) {
		  vscode.window.showErrorMessage('No file selected!');
		  return;
		}
		try {
		  const fileContent = await fs.promises.readFile(uri.fsPath, 'utf8');
		  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		  let relativePath: string;
	
		  if (workspaceFolder) {
			relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
		  } else {
			relativePath = path.basename(uri.fsPath);
		  }
		  let fileExtension = path.extname(relativePath).substring(1);
	
		  let codeBlock = `**${relativePath}**\n\`\`\`${fileExtension}\n${fileContent}\n\`\`\``;
		  provider.addFileToChat(relativePath, fileContent, fileExtension);  // Adjust method if desired
		} catch (err) {
		  vscode.window.showErrorMessage(`Failed to read file: ${err}`);
		}
	  })
	);

    context.subscriptions.push(
      vscode.commands.registerCommand('devmate.addFileReferenceToChat', async (uri: vscode.Uri) => {
        if (!uri || !uri.fsPath) {
          vscode.window.showErrorMessage('No file selected!');
          return;
        }
        try {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          let relativePath: string;
          if (workspaceFolder) {
            relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
          } else {
            relativePath = path.basename(uri.fsPath);
          }
          const fileExtension = path.extname(relativePath).substring(1);
          // Use content-based detection: image => add as base64 image; text => add as reference; else warn.
          const abs = uri.fsPath;
          const ws = workspaceFolder;
          if (!ws) {
            vscode.window.showErrorMessage('No workspace folder for this file.');
            return;
          }
          const mime = await detectImageMime(abs);
          if (mime) {
            const dataUrl = await readImageAsDataUrl(abs, mime);
            provider.addImageToChat(dataUrl, path.basename(abs));
            return;
          }
          if (await isTextFile(abs)) {
            provider.addFileReferenceToChat(relativePath.replace(/\\/g, '/'), fileExtension);
          } else {
            vscode.window.showWarningMessage('Selected file appears to be binary; not added.');
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to add file reference: ${err}`);
        }
      })
    );	

	const commandHandler = (command: string) => {
		const config = vscode.workspace.getConfiguration('devmate');
		const prompt = config.get(command) as string;
		provider.search(prompt);
	};

	// Register the commands that can be called from the extension's package.json
	context.subscriptions.push(
		vscode.commands.registerCommand('devmate.ask', () =>
			vscode.window.showInputBox({ prompt: 'What do you want to do?' })
				.then((value) => provider.search(value))
		),
        vscode.commands.registerCommand('devmate.explain', () => commandHandler('promptPrefix.explain')),
        vscode.commands.registerCommand('devmate.refactor', () => commandHandler('promptPrefix.refactor')),
        vscode.commands.registerCommand('devmate.optimize', () => commandHandler('promptPrefix.optimize')),
        vscode.commands.registerCommand('devmate.findProblems', () => commandHandler('promptPrefix.findProblems')),
        vscode.commands.registerCommand('devmate.documentation', () => commandHandler('promptPrefix.documentation')),
        vscode.commands.registerCommand('devmate.resetConversation', () => provider.resetConversation()),
        vscode.commands.registerCommand('devmate.pasteChat', () => provider.pasteChat()),
        vscode.commands.registerCommand('devmate.useSelectionAsChat', () => provider.useSelectionAsChat()),
        vscode.commands.registerCommand('devmate.appendSelectionMarkdownAsChat', () => provider.appendSelectionMarkdownAsChat()),
        vscode.commands.registerCommand('devmate.appendSelectionAsChat', () => provider.appendSelectionAsChat())
	);


	// Change the extension's session token or settings when configuration is changed
	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
        if (event.affectsConfiguration('devmate.providers')) {
            const config = vscode.workspace.getConfiguration('devmate');
			let providers: Provider[] = config.get('providers') || [];

			if (providers && providers.length > 0) {
				const firstProvider = providers[0];
				if (firstProvider.models && firstProvider.models.length > 0) {
					const firstModel = firstProvider.models[0];
                    const apiType = firstModel.api || 'chatCompletions';
                    const apiUrl =
                        apiType === 'responses'
                            ? (firstProvider.responsesUrl || firstProvider.apiUrl || BASE_URL)
                            : (firstProvider.chatCompletionsUrl || firstProvider.apiUrl || BASE_URL);
                    activate_provider_settings = {
					  model: firstModel.model_name,
					  apiUrl,
					  apiKey: firstProvider.apiKey,
					  apiType,
					  options: {
						...firstModel.options, // Use spread operator to include all options
                        ...(firstModel.tools ? { tools: firstModel.tools } : {}),
                        ...(firstModel as any).reasoning_output_delta_path ? { reasoning_output_delta_path: (firstModel as any).reasoning_output_delta_path } : {},
					  },
					};
				}
				provider.setSettings({
				  apiUrl: activate_provider_settings.apiUrl,
				  model: activate_provider_settings.model,
				  apiType: activate_provider_settings.apiType,
				  options: {
					...activate_provider_settings.options, // Use spread operator to include all options
				  },
				});
			
				// Put configuration settings into the provider
				provider.setAuthenticationInfo({
					apiKey: activate_provider_settings.apiKey,
					apiUrl: activate_provider_settings.apiUrl
				});
				
				provider.set_providers(providers);//Update the selectors
			}
    } else if (event.affectsConfiguration('devmate.prompts')) {
        const config = vscode.workspace.getConfiguration('devmate');
			let prompts: Prompt[] = config.get('prompts') || [];

			if (prompts && prompts.length > 0) {
				const firstPrompt = prompts[0];
				provider.set_prompt(firstPrompt);
			}
			provider.set_prompts(prompts);
    } else if (event.affectsConfiguration('devmate.selectedInsideCodeblock')) {
        const config = vscode.workspace.getConfiguration('devmate');
			provider.setSettings({ selectedInsideCodeblock: config.get('selectedInsideCodeblock') || false });
    } else if (event.affectsConfiguration('devmate.codeblockWithLanguageId')) {
        const config = vscode.workspace.getConfiguration('devmate');
			provider.setSettings({ codeblockWithLanguageId: config.get('codeblockWithLanguageId') || false });
    } else if (event.affectsConfiguration('devmate.pasteOnClick')) {
        const config = vscode.workspace.getConfiguration('devmate');
			provider.setSettings({ pasteOnClick: config.get('pasteOnClick') || false });
    } else if (event.affectsConfiguration('devmate.keepConversation')) {
        const config = vscode.workspace.getConfiguration('devmate');
			provider.setSettings({ keepConversation: config.get('keepConversation') || false });
    } else if (event.affectsConfiguration('devmate.timeoutLength')) {
        const config = vscode.workspace.getConfiguration('devmate');
			provider.setSettings({ timeoutLength: config.get('timeoutLength') || 60 });
		}
	});


	context.subscriptions.push(
		vscode.commands.registerCommand('devmate.addImageToChat', async (uri: vscode.Uri) => {
		  if (uri && uri.fsPath) {
			const filePath = uri.fsPath;
			const fileName = path.basename(filePath);
			const fileData = await fs.promises.readFile(filePath, { encoding: 'base64' });
			const fileType = path.extname(filePath).substring(1); // get file extension without dot
			const imageDataUrl = `data:image/${fileType};base64,${fileData}`;
	
			// Post a message to the webview to add the image
			provider.addImageToChat(imageDataUrl, fileName);
		  }
		})
	  );

    // Add multiple references/images from selected "tree" text
    context.subscriptions.push(
        vscode.commands.registerCommand('devmate.addSelectedPathsAsReferences', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor.');
                return;
            }
            const sel = editor.selection;
            if (sel.isEmpty) {
                vscode.window.showErrorMessage('No text selected.');
                return;
            }
            const selectedText = editor.document.getText(sel);
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            const base = folders[0];
            const paths = extractPathsFromText(selectedText);
            if (paths.length === 0) {
                vscode.window.showWarningMessage('No file paths found in selection.');
                return;
            }

            let addedText = 0, addedImg = 0, skippedMissing = 0, skippedBinary = 0, skippedDir = 0;
            for (const p of paths) {
                const { rel, abs } = getWorkspaceRelativeAndAbsolute(p, base);
                try {
                    const st = await fsp.stat(abs);
                    if (!st.isFile()) { skippedDir++; continue; }
                } catch {
                    skippedMissing++; continue;
                }
                const res = await addPathAsReferenceOrImage(provider, abs, rel);
                if (res.added && res.kind === 'text') addedText++;
                else if (res.added && res.kind === 'image') addedImg++;
                else if (res.reason === 'missing') skippedMissing++;
                else if (res.reason === 'binary') skippedBinary++;
                else if (res.reason === 'not-file') skippedDir++;
            }
            const summaryParts: string[] = [];
            if (addedText) summaryParts.push(`${addedText} text`);
            if (addedImg) summaryParts.push(`${addedImg} image`);
            if (!addedText && !addedImg) summaryParts.push('0');
            const skippedParts: string[] = [];
            if (skippedMissing) skippedParts.push(`${skippedMissing} missing`);
            if (skippedDir) skippedParts.push(`${skippedDir} directories`);
            if (skippedBinary) skippedParts.push(`${skippedBinary} binary`);
            const msg = `Added ${summaryParts.join(' + ')} file(s)` + (skippedParts.length ? `; skipped ${skippedParts.join(', ')}` : '');
            vscode.window.setStatusBarMessage(`[DevMate AI Chat] ${msg}`, 4000);
        })
    );
}

// This method is called when your extension is deactivated
export function deactivate() { }