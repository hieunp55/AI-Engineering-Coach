import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { callLlm } from './panel-llm';

// Mock vscode
vi.mock('vscode', () => ({
  LanguageModelChatMessage: {
    User: vi.fn((content: string) => ({ role: 'user', content })),
  },
  lm: {
    selectChatModels: vi.fn().mockResolvedValue([]),
  },
  authentication: {
    getSession: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(),
    })),
  },
  CancellationTokenSource: vi.fn(function (this: { token: unknown; cancel: unknown; dispose: unknown }) {
    this.token = {};
    this.cancel = vi.fn();
    this.dispose = vi.fn();
  }),
  CancellationError: class CancellationError extends Error {},
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2,
  },
}));

describe('panel-llm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    global.fetch = vi.fn();
  });

  it('bypasses vscode.lm and uses REST API when GOOGLE_GEMINI_API_KEY is configured', async () => {
    process.env.GOOGLE_GEMINI_API_KEY = 'env-api-key';
    (global.fetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Mock Gemini response' }] } }]
      })
    });

    const messages = [
      vscode.LanguageModelChatMessage.User('Hello')
    ] as vscode.LanguageModelChatMessage[];

    const result = await callLlm(messages);

    expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=env-api-key'),
      expect.any(Object)
    );
    expect(result).toBe('Mock Gemini response');
    
    // Ensure we did NOT try to use vscode.lm
    expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
  });

  it('uses vscode.lm when no Google API key environment variable is configured', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ text: ['Copilot response'] });
    (vscode.lm.selectChatModels as Mock).mockResolvedValue([{ sendRequest }]);

    const messages = [
      vscode.LanguageModelChatMessage.User('Hello')
    ] as vscode.LanguageModelChatMessage[];

    const result = await callLlm(messages);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(vscode.lm.selectChatModels).toHaveBeenCalled();
    expect(sendRequest).toHaveBeenCalled();
    expect(result).toBe('Copilot response');
  });
});
