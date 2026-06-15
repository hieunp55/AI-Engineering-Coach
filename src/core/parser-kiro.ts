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

interface KiroSessionData {
  history: any[];
  dateCreated?: string | number;
  selectedModel?: string;
  defaultModelTitle?: string;
}

export function parseKiroSessions(workspaceDir: string, base64Path: string): Session[] {
  const sessionsJsonPath = path.join(workspaceDir, 'sessions.json');
  if (!fs.existsSync(sessionsJsonPath)) {
    return [];
  }

  let metadataArray: KiroSessionMetadata[];
  try {
    metadataArray = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'));
  } catch (e) {
    debugCore('parser-kiro', `Failed to parse ${sessionsJsonPath}`, e);
    return [];
  }

  const results: Session[] = [];

  let wsName = '';

  for (const metadata of metadataArray) {
    if (!wsName && metadata.workspaceDirectory) {
      wsName = path.basename(metadata.workspaceDirectory);
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
      }));
      currentMessageText = '';
      currentResponseText = '';
      currentModelId = '';
      currentTimestamp = null;
      currentRequestId = '';
    };
    
    for (const item of data.history) {
      const message = item.message ?? item.msg;
      if (!message) continue;
      const role = message.role;
      const text = kiroContentText(message.content);

      let itemModel = '';
      if (item.promptLogs && item.promptLogs.length > 0) {
        const pLog = item.promptLogs[0];
        itemModel = pLog.completionOptions?.model || pLog.modelTitle || '';
      }

      if (role === 'user') {
        flushRequest();
        currentMessageText += text + '\n';
        currentTimestamp = parseKiroTimestamp(item.timestamp)
          ?? parseKiroTimestamp(item.createdAt)
          ?? parseKiroTimestamp(message.timestamp)
          ?? parseKiroTimestamp(message.createdAt)
          ?? null;
        if (typeof message.id === 'string') currentRequestId = message.id;
        if (itemModel) currentModelId = itemModel;
      } else if (role === 'assistant') {
        currentResponseText += text + '\n';
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
