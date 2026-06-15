/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession } from './parser-shared';

interface AntigravityLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
}

function parseAntigravityLine(rawLine: string): AntigravityLine | null {
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as AntigravityLine;
    }
    return null;
  } catch {
    return null;
  }
}

function readJsonlStreaming(filePath: string, onLine: (line: AntigravityLine) => void): void {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let remainder = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = remainder + decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      let nextNewline = text.indexOf('\n', start);
      while (nextNewline !== -1) {
        const rawLine = text.slice(start, nextNewline);
        if (rawLine.trim()) {
          const parsed = parseAntigravityLine(rawLine);
          if (parsed) onLine(parsed);
        }
        start = nextNewline + 1;
        nextNewline = text.indexOf('\n', start);
      }
      remainder = text.slice(start);
    }
    remainder += decoder.end();
    if (remainder.trim()) {
      const parsed = parseAntigravityLine(remainder);
      if (parsed) onLine(parsed);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function findAntigravityDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];

  const editions = ['antigravity-ide', 'antigravity-ide-insiders'];
  for (const edition of editions) {
    const brainDir = path.join(home, '.gemini', edition, 'brain');
    if (fs.existsSync(brainDir)) {
      dirs.push(brainDir);
    }
  }
  return dirs;
}

function extractFilePathFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  if (typeof args.TargetFile === 'string') return args.TargetFile;
  if (typeof args.AbsolutePath === 'string') return args.AbsolutePath;
  if (typeof args.DirectoryPath === 'string') return args.DirectoryPath;
  if (typeof args.SearchPath === 'string') return args.SearchPath;
  return null;
}

const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const READ_TOOLS = new Set(['view_file', 'list_dir', 'grep_search']);

export function parseAntigravitySessions(brainDir: string): Session[] {
  const sessions: Session[] = [];
  
  if (!fs.existsSync(brainDir)) return sessions;

  const entries = fs.readdirSync(brainDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    // Each directory inside brain/ is a conversation ID
    const convId = entry.name;
    const logFile = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    
    if (fs.existsSync(logFile)) {
      const session = parseSessionFile(logFile, convId);
      if (session) sessions.push(session);
    }
  }
  
  return sessions;
}

function parseSessionFile(filePath: string, sessionId: string): Session | null {
  assertTrustedPath(filePath);

  const requests: SessionRequest[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  // Current request state
  let currentStartTs: number | null = null;
  let currentUserMessage = '';
  let currentResponseTexts: string[] = [];
  let currentToolsUsed: string[] = [];
  let currentEditedFiles: string[] = [];
  let currentReferencedFiles: string[] = [];

  function flushRequest() {
    if (currentUserMessage || currentResponseTexts.length > 0) {
      requests.push(createRequest({
        requestId: `antigravity-${requests.length}`,
        timestamp: currentStartTs,
        messageText: currentUserMessage,
        responseText: currentResponseTexts.join('\n\n'),
        agentName: 'Antigravity IDE',
        agentMode: 'agent',
        modelId: 'gemini',
        toolsUsed: [...currentToolsUsed],
        editedFiles: [...new Set(currentEditedFiles)],
        referencedFiles: [...new Set(currentReferencedFiles)],
        totalElapsed: currentStartTs && lastTs ? Math.max(0, lastTs - currentStartTs) : null,
      }));
    }
    
    currentStartTs = null;
    currentUserMessage = '';
    currentResponseTexts = [];
    currentToolsUsed = [];
    currentEditedFiles = [];
    currentReferencedFiles = [];
  }

  try {
    readJsonlStreaming(filePath, (line) => {
      const ts = line.created_at ? new Date(line.created_at).getTime() : null;
      if (ts) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (!lastTs || ts > lastTs) lastTs = ts;
      }

      if (line.source === 'USER_EXPLICIT' && line.type === 'USER_INPUT') {
        flushRequest();
        currentUserMessage = line.content || '';
        const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(currentUserMessage);
        if (match) {
          currentUserMessage = match[1];
        }
        currentStartTs = ts;
      } else if (line.source === 'MODEL') {
        if (line.content) {
          currentResponseTexts.push(line.content);
        }
        if (line.tool_calls && Array.isArray(line.tool_calls)) {
          for (const tc of line.tool_calls) {
            currentToolsUsed.push(tc.name);
            const toolLower = tc.name.toLowerCase();
            const filePath = extractFilePathFromArgs(tc.args);
            
            if (filePath) {
              if (WRITE_TOOLS.has(toolLower)) {
                currentEditedFiles.push(filePath);
              } else if (READ_TOOLS.has(toolLower)) {
                currentReferencedFiles.push(filePath);
              }
            }
          }
        }
      }
    });

    flushRequest();
  } catch (e) {
    // Return null if parsing fails
    return null;
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId,
    workspaceId: `antigravity-${sessionId}`,
    workspaceName: 'Antigravity Session',
    location: 'antigravity',
    harness: 'Antigravity IDE',
    creationDate: firstTs,
    lastMessageDate: lastTs,
    requests,
  });
}
