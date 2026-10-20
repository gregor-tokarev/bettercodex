import { memo, useEffect, useState } from 'react';
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem';
import { conn } from '../lib/store';
import { IconBrain, IconChevronDown, IconChevronRight, IconFile, IconGlobe, IconSearch, IconSparkle, IconTerminal, Spinner } from './Icons';
import { Markdown } from './Markdown';

type Item<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;

function useToggle(initial = false) {
  const [open, setOpen] = useState(initial);
  return [open, () => setOpen((o) => !o)] as const;
}

function Row(props: { icon: React.ReactNode; title: React.ReactNode; running?: boolean; failed?: boolean; children?: React.ReactNode; defaultOpen?: boolean }) {
  const [open, toggle] = useToggle(props.defaultOpen);
  const expandable = !!props.children;
  return (
    <div className={`item-row ${props.failed ? 'failed' : ''}`}>
      <button className="item-row-head" onClick={expandable ? toggle : undefined} disabled={!expandable}>
        <span className="item-icon">{props.running ? <Spinner size={12} /> : props.icon}</span>
        <span className="item-title">{props.title}</span>
        {expandable && <span className="item-caret">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>}
      </button>
      {open && expandable && <div className="item-row-body">{props.children}</div>}
    </div>
  );
}

function UserMessage({ item, hostId }: { item: Item<'userMessage'>; hostId: string }) {
  return (
    <div className="user-message">
      <div className="user-bubble">
        {item.content.map((c, i) => {
          if (c.type === 'text') return <div key={i} className="user-text">{c.text}</div>;
          if (c.type === 'localImage') return <HostImage key={i} hostId={hostId} path={c.path} />;
          if (c.type === 'image' && 'url' in c) return <img key={i} className="user-image" src={c.url} />;
          if (c.type === 'mention' || c.type === 'skill') return <span key={i} className="mention">@{c.name}</span>;
          return null;
        })}
      </div>
    </div>
  );
}

export function HostImage({ hostId, path }: { hostId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    conn(hostId)
      ?.fileUrl(path)
      .then((url) => alive && setSrc(url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hostId, path]);
  return src ? <img className="user-image" src={src} /> : <span className="image-placeholder">{path.split('/').pop()}</span>;
}

function Reasoning({ item }: { item: Item<'reasoning'> }) {
  const text = item.summary.join('\n\n').trim() || item.content.join('\n\n').trim();
  if (!text) return null;
  const firstLine = text.replace(/\*\*/g, '').split('\n')[0].slice(0, 90);
  return (
    <Row icon={<IconBrain size={13} />} title={<span className="muted">{firstLine || 'Thinking'}</span>}>
      <div className="reasoning-text">{text.replace(/\*\*/g, '')}</div>
    </Row>
  );
}

function Command({ item }: { item: Item<'commandExecution'> }) {
  const running = item.status === 'inProgress';
  const failed = item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0);
  const verb = running ? 'Running' : 'Ran';
  const cmd = item.command.replace(/^\/bin\/(ba|z)?sh -l?c '?/, '').replace(/'$/, '');
  return (
    <Row
      icon={<IconTerminal size={13} />}
      running={running}
      failed={failed}
      title={
        <>
          <span className="muted">{verb}</span> <code className="inline-cmd">{cmd}</code>
          {item.exitCode !== null && item.exitCode !== 0 && <span className="badge-error">exit {item.exitCode}</span>}
        </>
      }
    >
      <pre className="command-output">
        <span className="prompt">$ {cmd}</span>
        {'\n'}
        {(item.aggregatedOutput ?? '').slice(-20000) || (running ? '' : '(no output)')}
      </pre>
    </Row>
  );
}

function diffStats(diff: string) {
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function FileChange({ item }: { item: Item<'fileChange'> }) {
  const running = item.status === 'inProgress';
  return (
    <>
      {item.changes.map((change, i) => {
        const { add, del } = diffStats(change.diff);
        const verb = change.kind.type === 'add' ? 'Created' : change.kind.type === 'delete' ? 'Deleted' : 'Edited';
        return (
          <Row
            key={i}
            icon={<IconFile size={13} />}
            running={running}
            failed={item.status === 'failed' || item.status === 'declined'}
            title={
              <>
                <span className="muted">{verb}</span> <span className="file-path">{change.path.split('/').slice(-3).join('/')}</span>
                <span className="stat-add">+{add}</span>
                <span className="stat-del">-{del}</span>
              </>
            }
          >
            <Diff diff={change.diff} />
          </Row>
        );
      })}
    </>
  );
}

function mcpSummary(item: Item<'mcpToolCall'>) {
  const args = (item.arguments ?? {}) as Record<string, any>;
  if (item.server === 'browser') {
    switch (item.tool) {
      case 'navigate':
        return args.url ? `Opened ${args.url}` : `${args.action ?? 'navigate'}`;
      case 'click':
        return `Clicked ${args.ref ?? args.selector ?? `${args.x},${args.y}`}`;
      case 'type':
        return `Typed “${String(args.text ?? '').slice(0, 40)}”`;
      case 'snapshot':
        return 'Read the page';
      case 'screenshot':
        return 'Took a screenshot';
      case 'tabs':
        return `Tabs: ${args.action ?? 'list'}${args.url ? ` ${args.url}` : ''}`;
      case 'js':
        return 'Ran browser script';
      case 'press':
        return `Pressed ${args.key}`;
      case 'scroll':
        return `Scrolled ${args.direction ?? ''}`;
      case 'evaluate':
        return 'Ran JavaScript in page';
      default:
        return item.tool;
    }
  }
  return `${item.server} · ${item.tool}`;
}

function McpCall({ item }: { item: Item<'mcpToolCall'> }) {
  const running = item.status === 'inProgress';
  const content = (item.result?.content ?? []) as Array<any>;
  const images = content.filter((c) => c?.type === 'image');
  const texts = content.filter((c) => c?.type === 'text').map((c) => c.text as string);
  return (
    <>
      <Row
        icon={item.server === 'browser' ? <IconGlobe size={13} /> : <IconSparkle size={13} />}
        running={running}
        failed={item.status === 'failed' || !!item.error}
        title={<span className="muted-strong">{mcpSummary(item)}</span>}
      >
        {item.server === 'browser' && item.tool === 'js' && typeof (item.arguments as any)?.code === 'string' && (
          <pre className="command-output">{(item.arguments as any).code}</pre>
        )}
        {item.server !== 'browser' && <pre className="command-output">{JSON.stringify(item.arguments, null, 2)}</pre>}
        {item.error && <pre className="command-output error">{item.error.message}</pre>}
        {texts.length > 0 && <pre className="command-output">{texts.join('\n').slice(0, 20000)}</pre>}
      </Row>
      {images.map((img, i) => (
        <img key={i} className="tool-image" src={`data:${img.mimeType};base64,${img.data}`} onClick={(e) => (e.currentTarget as HTMLImageElement).classList.toggle('zoom')} />
      ))}
    </>
  );
}

function Plan({ text }: { text: string }) {
  return (
    <div className="plan-item">
      <div className="plan-title">Plan</div>
      <div className="plan-text">{text}</div>
    </div>
  );
}

export const ItemView = memo(function ItemView({ item, hostId }: { item: ThreadItem; hostId: string }) {
  switch (item.type) {
    case 'userMessage':
      return <UserMessage item={item} hostId={hostId} />;
    case 'agentMessage':
      return (
        <div className={`agent-message ${item.phase === 'commentary' ? 'commentary' : ''}`}>
          <Markdown text={item.text} hostId={hostId} />
        </div>
      );
    case 'reasoning':
      return <Reasoning item={item} />;
    case 'commandExecution':
      return <Command item={item} />;
    case 'fileChange':
      return <FileChange item={item} />;
    case 'mcpToolCall':
      return <McpCall item={item} />;
    case 'webSearch': {
      const query = (item as any).query ?? (item as any).action?.query ?? '';
      return <Row icon={<IconSearch size={13} />} title={<span className="muted">Searched the web{query ? `: ${query}` : ''}</span>} />;
    }
    case 'plan':
      return <Plan text={item.text} />;
    case 'contextCompaction':
      return <div className="divider">Context compacted</div>;
    case 'imageView':
      return <HostImage hostId={hostId} path={item.path} />;
    case 'enteredReviewMode':
      return <div className="divider">Review started</div>;
    case 'exitedReviewMode':
      return (
        <div className="agent-message">
          <Markdown text={item.review} hostId={hostId} />
        </div>
      );
    case 'collabAgentToolCall':
      return <Row icon={<IconSparkle size={13} />} running={item.status === 'inProgress'} title={<span className="muted">Agent {item.tool}{item.prompt ? `: ${item.prompt.slice(0, 80)}` : ''}</span>} />;
    case 'subAgentActivity':
      return <Row icon={<IconSparkle size={13} />} title={<span className="muted">Sub-agent {item.kind}: {item.agentPath}</span>} />;
    case 'dynamicToolCall':
      return <Row icon={<IconSparkle size={13} />} running={item.status === 'inProgress'} title={<span className="muted">{item.tool}</span>} />;
    default:
      return null;
  }
});
