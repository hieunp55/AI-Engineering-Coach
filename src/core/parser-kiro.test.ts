import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { findKiroDirs, parseKiroSessions } from './parser-kiro';

describe('findKiroDirs', () => {
  it('returns an array of directories', () => {
    const dirs = findKiroDirs();
    expect(Array.isArray(dirs)).toBe(true);
  });
});

describe('parseKiroSessions', () => {
  it('parses KIRO sessions structure correctly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-workspace-'));
    try {
      const sessionId = 'test-session-id';
      // Write sessions.json metadata
      fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify([
        {
          sessionId,
          workspaceDirectory: 'd:\\Projects\\SomeProject',
          dateCreated: '2024-01-01T00:00:00.000Z',
          title: 'Test Session'
        }
      ]), 'utf-8');

      // Write individual session history
      fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({
        history: [
          {
            message: { role: 'user', content: [{ type: 'text', text: 'hello kiro' }], id: 'user-message-id' }
          },
          {
            message: { role: 'assistant', content: 'hello user' }
          }
        ]
      }), 'utf-8');

      const sessions = parseKiroSessions(dir, 'base64-encoded-path');

      expect(sessions).toHaveLength(1);
      const session = sessions[0];
      expect(session.sessionId).toBe(sessionId);
      expect(session.harness).toBe('KIRO IDE');
      expect(session.workspaceName).toBe('SomeProject');
      expect(session.creationDate).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
      expect(session.lastMessageDate).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].requestId).toBe('user-message-id');
      expect(session.requests[0].timestamp).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
      expect(session.requests[0].messageText).toBe('hello kiro');
      expect(session.requests[0].responseText).toBe('hello user');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
