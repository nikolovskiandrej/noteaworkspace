import { describe, expect, it } from 'vitest';
import { describeEvent, formatEventTime, type ActivityEvent } from '../src/lib/activity';

const context = {
  currentUserId: 'u-me',
  members: [
    { userId: 'u-me', name: 'Andrej' },
    { userId: 'u-niche', name: 'Niche' },
  ],
  tasks: [{ id: 't-1', title: 'Add a /health endpoint', agentName: 'Claude Code' }],
};

function event(type: string, actorKind: string, actorId: string | null, payload: Record<string, unknown> = {}): ActivityEvent {
  return { id: 1, type, actorKind, actorId, createdAt: '2026-09-23T05:24:26.265Z', payload };
}

describe('describeEvent', () => {
  it('names people, calling the reader "You"', () => {
    expect(describeEvent(event('task.created', 'user', 'u-me', { taskId: 't-1', title: 'Add a /health endpoint' }), context)).toEqual({
      actor: 'You',
      action: 'queued',
      subject: 'Add a /health endpoint',
      tone: 'neutral',
    });
    expect(describeEvent(event('task.approved', 'user', 'u-niche', { taskId: 't-1' }), context)).toMatchObject({ actor: 'Niche', action: 'approved' });
    expect(describeEvent(event('workspace.stopped', 'user', 'u-gone'), context)).toMatchObject({ actor: 'A former member', subject: null });
  });

  it('names agents by the task they work on, and colours outcomes', () => {
    expect(describeEvent(event('task.run_started', 'agent', null, { taskId: 't-1', agentName: 'Docs bot' }), context)).toMatchObject({
      actor: 'Docs bot',
      action: 'started work on',
      tone: 'agent',
    });
    expect(describeEvent(event('task.run_finished', 'agent', null, { taskId: 't-1', outcome: 'completed' }), context)).toMatchObject({
      actor: 'Claude Code',
      action: 'finished',
      tone: 'ok',
    });
    expect(describeEvent(event('task.run_finished', 'agent', null, { taskId: 't-1', outcome: 'timeout' }), context)).toMatchObject({ tone: 'danger' });
    expect(describeEvent(event('task.integration', 'agent', null, { taskId: 't-1', result: 'conflict' }), context)).toMatchObject({
      action: 'hit a merge conflict integrating',
      tone: 'danger',
    });
  });

  it('keeps unknown event types readable instead of dropping them', () => {
    expect(describeEvent(event('workspace.renamed', 'system', null), context)).toEqual({ actor: 'Notea', action: 'workspace renamed', subject: null, tone: 'neutral' });
  });
});

describe('formatEventTime', () => {
  it('renders the same text on every runtime', () => {
    expect(formatEventTime('2026-09-23T05:04:26.265Z')).toBe('23 Sep, 05:04 UTC');
    expect(formatEventTime('2026-01-01T23:59:00.000Z')).toBe('1 Jan, 23:59 UTC');
  });
});
