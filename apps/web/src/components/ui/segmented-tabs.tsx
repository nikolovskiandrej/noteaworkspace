'use client';

import { m } from 'motion/react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedTab<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

const INDICATOR_SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.8 } as const;

/**
 * Tabs drawn as a segmented control. The selected segment's background slides to the
 * next one (a shared layout animation), which is the one place the eye needs help
 * seeing what changed. Arrow keys, Home and End move between tabs, per the ARIA
 * tabs pattern; only the selected tab is in the Tab order.
 */
export function SegmentedTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idPrefix,
  className,
}: {
  label: string;
  tabs: Array<SegmentedTab<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Prefix for tab/panel ids; also names the sliding indicator, so keep it unique per page. */
  idPrefix: string;
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : -1;
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className={cx('segmented', className)} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              if (element) refs.current.set(tab.id, element);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            className="segment"
            onClick={() => onChange(tab.id)}
          >
            {selected ? <m.span layoutId={`${idPrefix}-indicator`} className="segment-indicator" transition={INDICATOR_SPRING} /> : null}
            {tab.icon}
            {tab.label}
            {tab.count !== undefined ? <span className="segment-count">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
