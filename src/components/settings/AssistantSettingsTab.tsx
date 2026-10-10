'use client';

import React from 'react';
import { Bot, Check, Copy, ShieldCheck } from 'lucide-react';
import {
  getAssistantBridgeStatus,
  subscribeToAssistantBridgeStatus,
  type AssistantBridgeStatus,
  type AssistantSettings,
} from '@/automation/assistantSettings';

interface AssistantSettingsTabProps {
  assistantSettings: AssistantSettings;
  onAssistantSettingsChange: (next: AssistantSettings) => void;
}

type AutomationInfo = { serverPath: string | null; tokenFile: string | null };

const STATUS_LABEL: Record<AssistantBridgeStatus, { text: string; color: string }> = {
  disabled: { text: 'Off', color: 'var(--text-muted)' },
  waiting: { text: 'Waiting for an assistant (MCP server not running)', color: 'var(--text-muted)' },
  connected: { text: 'Assistant connected', color: 'var(--accent-secondary)' },
  'auth-failed': { text: 'A server answered but failed authentication — update/restart it', color: 'var(--danger)' },
};

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the text is still selectable
    }
  }, [value]);
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>{label}</div>
        <button
          type="button"
          onClick={handleCopy}
          className="ui-button ui-button-secondary !h-7 !px-2 !py-0 text-[11px] inline-flex items-center gap-1"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="mt-1 whitespace-pre-wrap break-all rounded-md border px-2.5 py-1.5 text-[11px] font-mono select-text"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
      >
        {value}
      </pre>
    </div>
  );
}

export function AssistantSettingsTab({ assistantSettings, onAssistantSettingsChange }: AssistantSettingsTabProps) {
  const status = React.useSyncExternalStore(
    subscribeToAssistantBridgeStatus,
    getAssistantBridgeStatus,
    () => 'disabled' as AssistantBridgeStatus,
  );
  const [info, setInfo] = React.useState<AutomationInfo | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<AutomationInfo>('get_automation_info'))
      .then((next) => { if (!cancelled) setInfo(next); })
      .catch(() => { if (!cancelled) setInfo({ serverPath: null, tokenFile: null }); });
    return () => { cancelled = true; };
  }, []);

  const serverPath = info?.serverPath ?? null;
  const claudeCodeCommand = serverPath ? `claude mcp add dragonfruit -- node "${serverPath}"` : '';
  const claudeDesktopConfig = serverPath
    ? JSON.stringify({ mcpServers: { dragonfruit: { command: 'node', args: [serverPath] } } }, null, 2)
    : '';
  const statusLabel = STATUS_LABEL[status];

  return (
    <div className="space-y-3">
      <section
        className="rounded-lg border p-3"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <Bot className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>AI Assistant</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Let an AI assistant (Claude Desktop, Claude Code, any MCP client) drive DragonFruit for you:
              load and orient models, arrange the plate, generate supports, check the viewport and export.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Allow assistant control</div>
              <div className="text-[11px]" style={{ color: statusLabel.color }}>{statusLabel.text}</div>
            </div>
            <button
              type="button"
              onClick={() => onAssistantSettingsChange({ ...assistantSettings, enabled: !assistantSettings.enabled })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={assistantSettings.enabled
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                  }
                : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            >
              {assistantSettings.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {assistantSettings.enabled && (
          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Connect your assistant</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              The DragonFruit MCP server ships with the app. Register it once in your MCP client
              (requires Node.js 18+ on your PATH), then restart the client.
            </div>
            {serverPath ? (
              <>
                <CopyBlock label="Claude Code (terminal)" value={claudeCodeCommand} />
                <CopyBlock label="Claude Desktop (claude_desktop_config.json)" value={claudeDesktopConfig} />
              </>
            ) : (
              <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {info ? 'The bundled MCP server was not found in this build.' : 'Loading…'}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-start gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <ShieldCheck className="h-3.5 w-3.5 mt-px shrink-0" />
          <span>
            Local only: the assistant connects over 127.0.0.1 and must prove it can read a secret this
            app regenerates at every launch in your user profile. Other users, other machines and web
            pages cannot control DragonFruit.
          </span>
        </div>
      </section>
    </div>
  );
}
