import { useState } from 'react';
import { bc } from '../lib/bridge';
import { rejectRequest, respondToRequest, type ServerReq } from '../lib/store';
import { IconShield } from './Icons';

function Card({ title, children, actions }: { title: string; children?: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="approval-card">
      <div className="approval-title">
        <IconShield size={14} /> {title}
      </div>
      {children}
      <div className="approval-actions">{actions}</div>
    </div>
  );
}

type Decision = string | Record<string, any>;

function decisionLabel(d: Decision): string {
  if (typeof d === 'string') {
    return { accept: 'Allow', acceptForSession: 'Always allow', decline: 'Deny', cancel: 'Deny and stop' }[d] ?? d;
  }
  if ('acceptWithExecpolicyAmendment' in d) {
    const prefix = d.acceptWithExecpolicyAmendment?.execpolicy_amendment;
    return `Always allow ${Array.isArray(prefix) ? `“${prefix.join(' ')}”` : 'similar commands'}`;
  }
  if ('applyNetworkPolicyAmendment' in d) {
    const a = d.applyNetworkPolicyAmendment?.network_policy_amendment;
    return a?.host ? `${a.action === 'deny' ? 'Block' : 'Allow'} ${a.host}` : 'Update network policy';
  }
  return Object.keys(d)[0] ?? 'Choose';
}

/** Command approvals: show exactly the decisions Codex offers for this prompt. */
function CommandApproval({ hostId, req }: { hostId: string; req: ServerReq }) {
  const p = req.params ?? {};
  const decisions: Decision[] = p.availableDecisions?.length ? p.availableDecisions : ['decline', 'acceptForSession', 'accept'];
  const ordered = [...decisions].sort((a, b) => (a === 'accept' ? 1 : 0) - (b === 'accept' ? 1 : 0));
  return (
    <Card
      title={p.kind === 'writeStdin' ? 'Send input to a running command?' : 'Run this command?'}
      actions={ordered.map((d, i) => (
        <button key={i} className={`btn ${d === 'accept' ? 'primary' : ''}`} onClick={() => respondToRequest(hostId, req, { decision: d })}>
          {decisionLabel(d)}
        </button>
      ))}
    >
      {p.command && <pre className="command-output">{p.command}</pre>}
      {p.cwd && <div className="approval-detail muted">in {p.cwd}</div>}
      {p.reason && <div className="approval-detail">{p.reason}</div>}
      {p.networkApprovalContext && <div className="approval-detail muted">Network: {JSON.stringify(p.networkApprovalContext)}</div>}
    </Card>
  );
}

function UserInputRequest({ hostId, req }: { hostId: string; req: ServerReq }) {
  const questions: any[] = req.params.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <Card
      title="Codex has a question"
      actions={
        <button
          className="btn primary"
          onClick={() =>
            respondToRequest(hostId, req, {
              answers: Object.fromEntries(questions.map((q) => [q.id, { answers: answers[q.id] ? [answers[q.id]] : [] }])),
            })
          }
        >
          Submit
        </button>
      }
    >
      {questions.map((q) => (
        <div key={q.id} className="question">
          <div className="question-text">{q.question}</div>
          {q.options?.length ? (
            <div className="question-options">
              {q.options.map((o: any) => (
                <button key={o.label} className={`btn ${answers[q.id] === o.label ? 'primary' : ''}`} title={o.description} onClick={() => setAnswers({ ...answers, [q.id]: o.label })}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
          {(!q.options?.length || q.isOther) && (
            <input
              className="text-input"
              type={q.isSecret ? 'password' : 'text'}
              placeholder="Your answer"
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
          )}
        </div>
      ))}
    </Card>
  );
}

/** Renders a flat JSON-schema object (what MCP elicitation forms use) as inputs. */
function SchemaForm({ schema, value, onChange }: { schema: any; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const props: Record<string, any> = schema?.properties ?? {};
  return (
    <div className="settings-form">
      {Object.entries(props).map(([name, prop]) => {
        const label = prop.title ?? name;
        const options: Array<{ value: string; label: string }> =
          prop.oneOf?.map((o: any) => ({ value: o.const, label: o.title ?? o.const })) ??
          prop.enum?.map((v: string, i: number) => ({ value: v, label: prop.enumNames?.[i] ?? v })) ??
          [];
        if (prop.type === 'boolean') {
          return (
            <label key={name} className="checkbox">
              <input type="checkbox" checked={!!value[name]} onChange={(e) => onChange({ ...value, [name]: e.target.checked })} />
              {label}
            </label>
          );
        }
        if (options.length) {
          return (
            <label key={name}>
              {label}
              <select className="text-input" value={String(value[name] ?? '')} onChange={(e) => onChange({ ...value, [name]: e.target.value })}>
                <option value="" />
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        const numeric = prop.type === 'number' || prop.type === 'integer';
        return (
          <label key={name}>
            {label}
            {prop.description && <span className="muted small">{prop.description}</span>}
            <input
              className="text-input"
              type={numeric ? 'number' : prop.format === 'email' ? 'email' : 'text'}
              value={String(value[name] ?? '')}
              onChange={(e) => onChange({ ...value, [name]: numeric ? Number(e.target.value) : e.target.value })}
            />
          </label>
        );
      })}
    </div>
  );
}

function ElicitationRequest({ hostId, req }: { hostId: string; req: ServerReq }) {
  const p = req.params;
  const [value, setValue] = useState<Record<string, unknown>>({});
  const isForm = p.mode === 'form' || p.mode === 'openai/form' || p.mode === 'openaiForm';
  const answer = (action: 'accept' | 'decline' | 'cancel') =>
    respondToRequest(hostId, req, { action, content: action === 'accept' && isForm ? value : null, _meta: null });
  return (
    <Card
      title={p.mode === 'openai/userVerification' ? p.title : `${p.serverName} needs input`}
      actions={
        <>
          <button className="btn" onClick={() => answer('decline')}>
            Decline
          </button>
          <button className="btn primary" onClick={() => answer('accept')}>
            {p.mode === 'url' ? 'Done' : 'Accept'}
          </button>
        </>
      }
    >
      <div className="approval-detail">{p.message ?? p.description}</div>
      {p.mode === 'url' && (
        <button className="btn" onClick={() => void bc.openExternal(p.url)}>
          Open {new URL(p.url).host}
        </button>
      )}
      {p.mode === 'openai/userVerification' && <pre className="command-output">{p.challenge}</pre>}
      {isForm && <SchemaForm schema={p.requestedSchema} value={value} onChange={setValue} />}
    </Card>
  );
}

export function ApprovalRequest({ hostId, req }: { hostId: string; req: ServerReq }) {
  const p = req.params ?? {};
  const decide = (decision: unknown) => respondToRequest(hostId, req, { decision });
  switch (req.method) {
    case 'item/commandExecution/requestApproval':
      return <CommandApproval hostId={hostId} req={req} />;
    case 'item/fileChange/requestApproval':
      return (
        <Card
          title="Apply these file changes?"
          actions={
            <>
              <button className="btn" onClick={() => decide('decline')}>
                Reject
              </button>
              <button className="btn" onClick={() => decide('acceptForSession')}>
                Allow for session
              </button>
              <button className="btn primary" onClick={() => decide('accept')}>
                Apply
              </button>
            </>
          }
        >
          {p.reason && <div className="approval-detail">{p.reason}</div>}
          {p.grantRoot && <div className="approval-detail muted">Write access to {p.grantRoot}</div>}
        </Card>
      );
    case 'item/permissions/requestApproval':
      return (
        <Card
          title="Grant extra permissions?"
          actions={
            <>
              <button className="btn" onClick={() => respondToRequest(hostId, req, { permissions: {}, scope: 'turn' })}>
                Deny
              </button>
              <button className="btn" onClick={() => respondToRequest(hostId, req, { permissions: p.permissions ?? {}, scope: 'session' })}>
                Allow for session
              </button>
              <button className="btn primary" onClick={() => respondToRequest(hostId, req, { permissions: p.permissions ?? {}, scope: 'turn' })}>
                Allow
              </button>
            </>
          }
        >
          {p.reason && <div className="approval-detail">{p.reason}</div>}
          <pre className="command-output">{JSON.stringify(p.permissions, null, 2)}</pre>
        </Card>
      );
    case 'item/tool/requestUserInput':
      return <UserInputRequest hostId={hostId} req={req} />;
    case 'mcpServer/elicitation/request':
      return <ElicitationRequest hostId={hostId} req={req} />;
    default:
      return (
        <Card
          title={`Unsupported request: ${req.method}`}
          actions={
            <button className="btn" onClick={() => rejectRequest(hostId, req, `BetterCodex does not support ${req.method}`)}>
              Dismiss
            </button>
          }
        >
          <pre className="command-output">{JSON.stringify(p, null, 2).slice(0, 2000)}</pre>
        </Card>
      );
  }
}
