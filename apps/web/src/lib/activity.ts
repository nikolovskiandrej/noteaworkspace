/**
 * Turns `workspace_events` rows into sentences for the activity feed: who did what to
 * which task, instead of `task.run_finished` and an actor kind.
 */

export interface ActivityEvent {
  id: number;
  type: string;
  actorKind: string;
  actorId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface ActivityContext {
  currentUserId: string;
  members: Array<{ userId: string; name: string }>;
  tasks: Array<{ id: string; title: string; agentName: string }>;
}

export type ActivityTone = 'neutral' | 'agent' | 'ok' | 'danger';

export interface ActivityLine {
  actor: string;
  action: string;
  /** The task's title, when the event is about one. */
  subject: string | null;
  tone: ActivityTone;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function describeEvent(event: ActivityEvent, context: ActivityContext): ActivityLine {
  const payload = event.payload;
  const task = context.tasks.find((t) => t.id === payload.taskId);
  const subject = task?.title ?? text(payload.title);

  let actor: string;
  if (event.actorKind === 'user') {
    actor =
      event.actorId === context.currentUserId ? 'You' : (context.members.find((m) => m.userId === event.actorId)?.name ?? 'A former member');
  } else if (event.actorKind === 'agent') {
    actor = text(payload.agentName) ?? task?.agentName ?? 'An agent';
  } else {
    actor = 'Notea';
  }

  const line = (action: string, tone: ActivityTone = event.actorKind === 'agent' ? 'agent' : 'neutral', withSubject = true): ActivityLine => ({
    actor,
    action,
    subject: withSubject ? subject : null,
    tone,
  });

  switch (event.type) {
    case 'workspace.created':
      return line('created the workspace', 'neutral', false);
    case 'workspace.started':
      return line(event.actorKind === 'system' ? 'started the container' : 'started the workspace', 'neutral', false);
    case 'workspace.stopped':
      return line('stopped the workspace', 'neutral', false);
    case 'workspace.deleted':
      return line('deleted the workspace', 'danger', false);
    case 'member.added': {
      const who = text(payload.email) ?? 'a member';
      const role = text(payload.role);
      return line(role ? `added ${who} as ${role}` : `added ${who}`, 'neutral', false);
    }
    case 'member.removed': {
      const name = context.members.find((m) => m.userId === payload.userId)?.name;
      return line(name ? `removed ${name}` : 'removed a member', 'neutral', false);
    }
    case 'policy.updated':
      return line('changed the task policy', 'neutral', false);
    case 'task.created':
      return line('queued');
    case 'task.approved':
      return line('approved');
    case 'task.cancelled':
      return line('cancelled');
    case 'task.queued':
      return line('re-queued');
    case 'task.deleted':
      return line(subject ? 'deleted' : 'deleted a task');
    case 'task.run_started':
      return line('started work on');
    case 'task.run_finished':
      switch (payload.outcome) {
        case 'completed':
          return line('finished', 'ok');
        case 'cancelled':
          return line('stopped work on');
        case 'timeout':
          return line('ran out of time on', 'danger');
        default:
          return line('failed on', 'danger');
      }
    case 'task.run_failed':
      return line('failed on', 'danger');
    case 'task.integration':
      switch (payload.result) {
        case 'integrated':
          return line('integrated', 'ok');
        case 'nothing_to_integrate':
          return line('found nothing to integrate for');
        case 'conflict':
          return line('hit a merge conflict integrating', 'danger');
        case 'checks_failed':
          return line('saw the checks fail for', 'danger');
        default:
          return line('could not integrate', 'danger');
      }
    case 'task.integration_recovered':
      return line('retried the interrupted integration of');
    default:
      return line(event.type.replace(/[._]/g, ' '), 'neutral', false);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "23 Sep, 05:24 UTC". Built by hand rather than with Intl: the server and the
 * browser must render identical markup, and month abbreviations differ between ICU
 * versions ("Sep" and "Sept").
 */
export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
