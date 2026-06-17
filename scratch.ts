import { findKiroDirs, parseKiroSessions } from './src/core/parser-kiro';
import { ParseContext } from './src/core/parser-shared';

const dirs = findKiroDirs();
console.log('Found Kiro Dirs:', dirs);

const ctx = {
  workspaces: new Map(),
  sessions: [],
  editLocIndex: new Map(),
  sessionSourceIndex: new Map(),
  aiLoc: 0
} as any;

const fs = require('fs');
const path = require('path');

for (const kiroDir of dirs) {
  const workspaces = fs.readdirSync(kiroDir, { withFileTypes: true }).filter((d: any) => d.isDirectory());
  for (const ws of workspaces) {
    const wsPath = path.join(kiroDir, ws.name);
    const sessions = parseKiroSessions(wsPath, ws.name);
    ctx.sessions.push(...sessions);
  }
}
import { validateSessions } from './src/core/schemas';
const valid = validateSessions(ctx.sessions, 'kiro test');
console.log('Valid Sessions:', valid.length, '/', ctx.sessions.length);

console.log('Parsed Sessions:', ctx.sessions.length);
if (ctx.sessions.length > 0) {
  console.log('First session:', JSON.stringify(ctx.sessions[0], null, 2));
}
