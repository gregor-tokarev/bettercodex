import { useEffect, useRef, useState } from 'react';
import { bc } from '../lib/bridge';
import { effectiveSettings, interrupt, sendMessage, setComposerSetting, toast, useStore, type AccessMode } from '../lib/store';
import { HostImage } from './Items';
import { IconArrowUp, IconBrain, IconPaperclip, IconShield, IconSparkle, IconStop, IconX } from './Icons';
import { Dropdown } from './Menu';

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

const ACCESS_OPTIONS: Array<{ value: AccessMode; label: string; description: string }> = [
  { value: 'read-only', label: 'Read only', description: 'Reads files; asks before edits and commands' },
  { value: 'auto', label: 'Default', description: 'Edits the project; asks for network or outside access' },
  { value: 'full', label: 'Full access', description: 'No sandbox and no approval prompts' },
];

const drafts = new Map<string, string>();

export function Composer({ hostId, threadId, children }: { hostId: string; threadId: string | null; children?: React.ReactNode }) {
  const key = `${hostId}:${threadId ?? 'draft'}`;
  const [text, setText] = useState(() => drafts.get(key) ?? '');
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const models = useStore((s) => s.hosts[hostId]?.models ?? []);
  useStore((s) => s.threadSettings);
  useStore((s) => s.prefs);
  const running = useStore((s) => (threadId ? !!s.threads[`${hostId}:${threadId}`]?.activeTurnId : false));
  const usage = useStore((s) => (threadId ? s.threads[`${hostId}:${threadId}`]?.tokenUsage : null));
  const settings = effectiveSettings(hostId, threadId);
  const model = models.find((m) => m.model === settings.model);

  useEffect(() => {
    setText(drafts.get(key) ?? '');
    setImages([]);
    ref.current?.focus();
  }, [key]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  const submit = async () => {
    if ((!text.trim() && !images.length) || sending) return;
    setSending(true);
    const body = text;
    const imgs = images;
    setText('');
    setImages([]);
    drafts.delete(key);
    const result = await sendMessage(hostId, threadId, body, imgs);
    setSending(false);
    if (!result.ok) {
      // Give the message back unless something new was typed meanwhile.
      setText((cur) => cur || body);
      setImages((cur) => (cur.length ? cur : imgs));
      drafts.set(key, body);
    }
  };

  const attach = async () => {
    try {
      const paths = await bc.files.pickAndUpload(hostId, { multiple: true, images: true });
      setImages((cur) => [...cur, ...paths]);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      const path = await bc.files.upload(hostId, file.name || 'pasted.png', new Uint8Array(await file.arrayBuffer()));
      setImages((cur) => [...cur, path]);
    }
  };

  const contextPct = usage?.modelContextWindow ? Math.min(100, Math.round((usage.last.totalTokens / usage.modelContextWindow) * 100)) : null;

  return (
    <div className="composer-wrap">
      {children}
      <div className="composer" onClick={() => ref.current?.focus()}>
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((p) => (
              <div key={p} className="composer-image">
                <HostImage hostId={hostId} path={p} />
                <button onClick={() => setImages((cur) => cur.filter((x) => x !== p))}>
                  <IconX size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={running ? 'Steer the current turn…' : threadId ? 'Ask for follow-up changes' : 'Ask Codex anything'}
          onChange={(e) => {
            setText(e.target.value);
            drafts.set(key, e.target.value);
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bar" onClick={(e) => e.stopPropagation()}>
          <button className="icon-button" title="Attach images" onClick={attach}>
            <IconPaperclip size={15} />
          </button>
          <Dropdown
            header="Model"
            icon={<IconSparkle size={13} />}
            value={settings.model}
            placeholder="Model"
            options={models.filter((m) => !m.hidden || m.model === settings.model).map((m) => ({ value: m.model, label: m.displayName || m.model, description: m.description }))}
            onChange={(v) => setComposerSetting(hostId, threadId, { model: v })}
          />
          {model && model.supportedReasoningEfforts.length > 0 && (
            <Dropdown
              header="Reasoning"
              icon={<IconBrain size={13} />}
              value={settings.effort}
              options={model.supportedReasoningEfforts.map((e) => ({ value: e.reasoningEffort, label: EFFORT_LABELS[e.reasoningEffort] ?? e.reasoningEffort, description: e.description }))}
              onChange={(v) => setComposerSetting(hostId, threadId, { effort: v })}
            />
          )}
          <Dropdown
            header="Permissions"
            icon={<IconShield size={13} />}
            value={settings.access}
            options={ACCESS_OPTIONS}
            onChange={(v) => setComposerSetting(hostId, threadId, { access: v })}
          />
          <div className="spacer" />
          {contextPct !== null && (
            <span className="context-meter" title={`${usage!.last.totalTokens.toLocaleString()} / ${usage!.modelContextWindow!.toLocaleString()} tokens of context used`}>
              <svg width="16" height="16" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border-strong)" strokeWidth="4" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--text-muted)" strokeWidth="4" strokeDasharray={`${(contextPct / 100) * 94.2} 94.2`} transform="rotate(-90 18 18)" />
              </svg>
              <span>{contextPct}%</span>
            </span>
          )}
          {running && !text.trim() ? (
            <button className="send-button stop" title="Stop" onClick={() => threadId && void interrupt(hostId, threadId)}>
              <IconStop size={14} />
            </button>
          ) : (
            <button className="send-button" title="Send" disabled={(!text.trim() && !images.length) || sending} onClick={() => void submit()}>
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
