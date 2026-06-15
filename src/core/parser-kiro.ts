import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { createRequest, createSession } from './parser-shared';
import { debugCore } from './log';

export function findKiroDirs(): string[] {
  const dirs: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';

  let kiroPath: string | undefined;
  if (process.platform === 'darwin') {
    kiroPath = path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  } else if (process.platform === 'win32') {
    kiroPath = path.join(process.env.APPDATA || '', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  } else {
    kiroPath = path.join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  }
  
  if (kiroPath && fs.existsSync(kiroPath)) {
    dirs.push(kiroPath);
  }
  return dirs;
}

interface KiroSessionMetadata {
  sessionId: string;
  workspaceDirectory: string;
  dateCreated: string | number;
  title: string;
}

function parseKiroTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function kiroContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.value === 'string') return record.value;
      if (typeof record.content === 'string') return record.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
  }
  return '';
}

interface KiroHistoryItem {
  message?: { role?: string; content?: unknown; id?: string; timestamp?: unknown; createdAt?: unknown };
  msg?: { role?: string; content?: unknown; id?: string; timestamp?: unknown; createdAt?: unknown };
  timestamp?: unknown;
  createdAt?: unknown;
  promptLogs?: Array<{ completionOptions?: { model?: string }; modelTitle?: string; prompt?: string; completion?: string }>;
}

interface KiroSessionData {
  history: KiroHistoryItem[];
  dateCreated?: string | number;
  selectedModel?: string;
  defaultModelTitle?: string;
}

function extractMessageModel(item: KiroHistoryItem): string {
  if (!item.promptLogs || item.promptLogs.length === 0) return '';
  const pLog = item.promptLogs[0];
  return pLog.completionOptions?.model || pLog.modelTitle || '';
}

function extractItemTimestamp(item: KiroHistoryItem, message: Record<string, unknown>): number | null {
  return parseKiroTimestamp(item.timestamp)
    ?? parseKiroTimestamp(item.createdAt)
    ?? parseKiroTimestamp((message).timestamp)
    ?? parseKiroTimestamp((message).createdAt)
    ?? null;
}

export function parseKiroSessions(workspaceDir: string, base64Path: string): Session[] {
  const sessionsJsonPath = path.join(workspaceDir, 'sessions.json');
  if (!fs.existsSync(sessionsJsonPath)) {
    return [];
  }

  let metadataArray: KiroSessionMetadata[];
  try {
    metadataArray = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8')) as KiroSessionMetadata[];
  } catch (e) {
    debugCore('parser-kiro', `Failed to parse ${sessionsJsonPath}`, e);
    return [];
  }

  const results: Session[] = [];

  let wsName = '';

  for (const metadata of metadataArray) {
    if (!wsName && metadata.workspaceDirectory) {
      wsName = path.win32.basename(metadata.workspaceDirectory);
    }

    const sessionFilePath = path.join(workspaceDir, `${metadata.sessionId}.json`);
    if (!fs.existsSync(sessionFilePath)) continue;

    const fileTimestamp = parseKiroTimestamp(fs.statSync(sessionFilePath).mtimeMs);
    let sessionData: unknown;
    try {
      sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8')) as Record<string, unknown>;
    } catch (e) {
      debugCore('parser-kiro', `Failed to parse ${sessionFilePath}`, e);
      continue;
    }

    if (!sessionData || typeof sessionData !== 'object' || !Array.isArray((sessionData as Record<string, unknown>).history)) continue;

    const data = sessionData as KiroSessionData;

    const requests: SessionRequest[] = [];
    let currentMessageText = '';
    let currentResponseText = '';
    let currentModelId = '';
    let currentPromptTokens = 0;
    let currentCompletionTokens = 0;
    let currentTimestamp: number | null = null;
    let currentRequestId = '';
    const creationTs = parseKiroTimestamp(metadata.dateCreated) ?? parseKiroTimestamp(data.dateCreated) ?? fileTimestamp;

    const flushRequest = (): void => {
      if (!currentMessageText || !currentResponseText) return;
      const requestIndex = requests.length;
      const timestamp = currentTimestamp ?? (creationTs == null ? null : creationTs + requestIndex);
      requests.push(createRequest({
        requestId: currentRequestId || `${metadata.sessionId}:${requestIndex}`,
        timestamp,
        messageText: currentMessageText.trim(),
        responseText: currentResponseText.trim(),
        modelId: currentModelId || data.selectedModel || data.defaultModelTitle || '',
        promptTokens: currentPromptTokens > 0 ? currentPromptTokens : null,
        completionTokens: currentCompletionTokens > 0 ? currentCompletionTokens : null,
      }));
      currentMessageText = '';
      currentResponseText = '';
      currentModelId = '';
      currentPromptTokens = 0;
      currentCompletionTokens = 0;
      currentTimestamp = null;
      currentRequestId = '';
    };
    
    for (const item of data.history) {
      const message = item.message ?? item.msg;
      if (!message) continue;
      const role = (message as Record<string, unknown>).role as string | undefined;
      if (!role) continue;
      
      const text = kiroContentText((message as Record<string, unknown>).content);
      const itemModel = extractMessageModel(item);

      if (role === 'user') {
        flushRequest();
        currentMessageText += text + '\n';
        currentPromptTokens += Math.ceil(text.length / 4);
        currentTimestamp = extractItemTimestamp(item, message);
        const msgId = (message as Record<string, unknown>).id;
        if (typeof msgId === 'string') currentRequestId = msgId;
        if (itemModel) currentModelId = itemModel;
      } else if (role === 'assistant') {
        currentResponseText += text + '\n';
        if (item.promptLogs && item.promptLogs.length > 0) {
          const pLog = item.promptLogs[0];
          if (pLog.prompt) currentPromptTokens = Math.ceil(pLog.prompt.length / 4);
          if (pLog.completion) {
            currentCompletionTokens = Math.ceil(pLog.completion.length / 4);
            currentResponseText += '\n\n' + pLog.completion;
          }
        }
        if (currentCompletionTokens === 0) {
          currentCompletionTokens = Math.ceil(text.length / 4);
        }
        if (itemModel) currentModelId = itemModel;
      }
    }

    flushRequest();
    
    const session = createSession({
      sessionId: metadata.sessionId,
      workspaceId: base64Path,
      workspaceName: wsName || 'Unknown Workspace',
      workspaceRootPath: metadata.workspaceDirectory,
      harness: 'KIRO IDE',
      creationDate: creationTs,
      requests,
    });

    results.push(session);
  }

  return results;
}
