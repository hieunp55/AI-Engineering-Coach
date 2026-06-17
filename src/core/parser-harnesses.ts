/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* External harness collection registry for parser orchestration. */

import * as fs from 'fs';
import * as path from 'path';
import { Workspace, Session } from './types';
import { findClaudeDirs, parseClaudeSessions, parseClaudeSessionsAsync } from './parser-claude';
import { findCodexDirs, parseCodexSessions } from './parser-codex';
import { findOpenCodeDirs, parseOpenCodeSessions } from './parser-opencode';
import { findAntigravityDirs, parseAntigravitySessions } from './parser-antigravity';
import { findKiroDirs, parseKiroSessions } from './parser-kiro';

type WorkspaceMap = Map<string, Workspace>;

interface HarnessCollectionContext {
  workspaces: WorkspaceMap;
  sessions: Session[];
}

interface ExternalHarnessCollector {
  name: string;
  collectSync(ctx: HarnessCollectionContext): void;
  collectAsync?(ctx: HarnessCollectionContext, reportDetail?: (detail: string) => void): Promise<void>;
}

function addSession(workspaces: WorkspaceMap, sessions: Session[], session: Session, rootPath: string): void {
  const sessionRootPath = session.workspaceRootPath && fs.existsSync(session.workspaceRootPath) ? session.workspaceRootPath : rootPath;

  // Try to match with an existing workspace by path
  let matchedWs: Workspace | undefined;
  if (sessionRootPath) {
    const normPath = sessionRootPath.toLowerCase().replace(/[\\/]$/, '').replaceAll('\\', '/');
    for (const ws of workspaces.values()) {
      if (ws.path && ws.path.toLowerCase().replace(/[\\/]$/, '').replaceAll('\\', '/') === normPath) {
        matchedWs = ws;
        break;
      }
    }
  }

  if (matchedWs) {
    session.workspaceId = matchedWs.id;
    session.workspaceName = matchedWs.name;
  } else if (!workspaces.has(session.workspaceId)) {
    workspaces.set(session.workspaceId, { id: session.workspaceId, name: session.workspaceName, path: sessionRootPath });
  }

  sessions.push(session);
}

const EXTERNAL_HARNESSES: ExternalHarnessCollector[] = [
  {
    name: 'Antigravity IDE',
    collectSync(ctx: HarnessCollectionContext) {
      for (const dir of findAntigravityDirs()) {
        const sessions = parseAntigravitySessions(dir);
        for (const session of sessions) addSession(ctx.workspaces, ctx.sessions, session, dir);
      }
    },
  },
  {
    name: 'Claude Code',
    collectSync(ctx) {
      for (const claudeDir of findClaudeDirs()) {
        for (const { sessions } of parseClaudeSessions(claudeDir)) {
          for (const session of sessions) addSession(ctx.workspaces, ctx.sessions, session, claudeDir);
        }
      }
    },
    async collectAsync(ctx, reportDetail) {
      for (const claudeDir of findClaudeDirs()) {
        const results = await parseClaudeSessionsAsync(claudeDir, (idx, total, name) => {
          reportDetail?.(`${idx}/${total}: ${name}`);
        });
        for (const { sessions } of results) {
          for (const session of sessions) addSession(ctx.workspaces, ctx.sessions, session, claudeDir);
        }
      }
    },
  },
  {
    name: 'Codex CLI',
    collectSync(ctx) {
      for (const codexDir of findCodexDirs()) {
        for (const session of parseCodexSessions(codexDir)) addSession(ctx.workspaces, ctx.sessions, session, codexDir);
      }
    },
  },
  {
    name: 'OpenCode',
    collectSync(ctx) {
      for (const ocDir of findOpenCodeDirs()) {
        for (const session of parseOpenCodeSessions(ocDir)) addSession(ctx.workspaces, ctx.sessions, session, ocDir);
      }
    },
  },
  {
    name: 'KIRO IDE',
    collectSync(ctx) {
      for (const kiroDir of findKiroDirs()) {
        const workspaces = fs.readdirSync(kiroDir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const ws of workspaces) {
          const wsPath = path.join(kiroDir, ws.name);
          const sessions = parseKiroSessions(wsPath, ws.name);
          for (const session of sessions) addSession(ctx.workspaces, ctx.sessions, session, wsPath);
        }
      }
    },
  },
];

export interface ExternalHarnessProgressHandlers {
  onHarnessStart?: (name: string, index: number, total: number, sessionCount: number) => void;
  onHarnessDetail?: (name: string, detail: string, sessionCount: number) => void;
  onHarnessError?: (name: string, error: unknown) => void;
  yieldToLoop?: () => Promise<void>;
}

/** Returns true if any external-harness (Claude Code, Codex, OpenCode) session
 *  source exists on disk. The dashboard uses this so it does not abort when the
 *  only available logs come from a non-VS Code harness — e.g. a headless
 *  Remote-SSH host that has Claude Code sessions under `~/.claude/projects` but
 *  no VS Code workspace storage or Copilot directories. */
export function hasExternalHarnessSources(): boolean {
  // Without a home directory the find* helpers would join against an empty
  // string and probe relative paths (e.g. `.claude/projects`) under the current
  // working directory, which could report false positives. Bail out instead.
  if (!process.env.HOME && !process.env.USERPROFILE) return false;
  return findClaudeDirs().length > 0 || findCodexDirs().length > 0 || findOpenCodeDirs().length > 0 || findAntigravityDirs().length > 0 || findKiroDirs().length > 0;
}

export function collectExternalHarnessesSync(workspaces: WorkspaceMap, sessions: Session[]): void {
  const ctx: HarnessCollectionContext = { workspaces, sessions };
  for (const harness of EXTERNAL_HARNESSES) {
    harness.collectSync(ctx);
  }
}

/** Harness values set on sessions by external harness collectors.
 *  The cache reconciliation in parser.ts uses this set to identify and
 *  refresh cached external-harness sessions, so every value the collectors
 *  can produce must be listed here. */
export const EXTERNAL_HARNESS_SET = new Set<string>([
  'Claude',
  'Codex',
  'OpenCode',
  'Antigravity IDE',
  'KIRO IDE',
]);

export async function collectExternalHarnessesAsync(
  workspaces: WorkspaceMap,
  sessions: Session[],
  handlers: ExternalHarnessProgressHandlers = {},
): Promise<void> {
  const ctx: HarnessCollectionContext = { workspaces, sessions };
  const total = EXTERNAL_HARNESSES.length;

  for (let index = 0; index < EXTERNAL_HARNESSES.length; index++) {
    const harness = EXTERNAL_HARNESSES[index];
    handlers.onHarnessStart?.(harness.name, index, total, sessions.length);
    if (handlers.yieldToLoop) await handlers.yieldToLoop();

    try {
      if (harness.collectAsync) {
        await harness.collectAsync(ctx, (detail) => handlers.onHarnessDetail?.(harness.name, detail, sessions.length));
      } else {
        harness.collectSync(ctx);
      }
    } catch (error) {
      handlers.onHarnessError?.(harness.name, error);
    }

    if (handlers.yieldToLoop) await handlers.yieldToLoop();
  }
}
