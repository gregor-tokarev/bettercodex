import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown } from './Icons';

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/** Small popover select used by the composer pickers. Opens upward when there is no room below. */
export function Dropdown<T extends string>(props: {
  value: T | null;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  icon?: ReactNode;
  placeholder?: string;
  title?: string;
  header?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(true);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setUp(rect.top > window.innerHeight - rect.bottom);
  }, [open]);

  const current = props.options.find((o) => o.value === props.value);
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="chip" title={props.title} onClick={() => setOpen((o) => !o)}>
        {props.icon}
        <span>{current?.label ?? props.placeholder ?? 'Select'}</span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div ref={popRef} className={`popover ${up ? 'up' : 'down'} ${props.align === 'right' ? 'right' : ''}`}>
          {props.header && <div className="popover-header">{props.header}</div>}
          {props.options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`popover-item ${o.value === props.value ? 'selected' : ''}`}
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="popover-item-text">
                <span>{o.label}</span>
                {o.description && <span className="popover-item-desc">{o.description}</span>}
              </span>
              {o.value === props.value && <IconCheck size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
