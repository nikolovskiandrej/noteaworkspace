import type { WorkspaceRole } from '@notea/protocol';

export interface PaneMember {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
}

/** One member's Claude terminal on the workspace page (D-045). */
export interface ClaudePane {
  userId: string;
  name: string;
  /** "Andrej's Claude" */
  title: string;
  /** "Andrej": the phone layout's switcher has room for little more. */
  shortLabel: string;
  /** Set only when two members' titles would otherwise read the same. */
  detail: string | null;
  isYou: boolean;
}

const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, editor: 1, viewer: 2 };

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Member';
}

/**
 * One terminal per member who can write: the owner first, then editors by name.
 * Viewers watch but have none of their own. The order is the same for everyone, so
 * "the left one" means the same terminal on both screens.
 */
export function claudePanes(members: PaneMember[], currentUserId: string): ClaudePane[] {
  const writers = members
    .filter((member) => member.role !== 'viewer')
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  const names = writers.map((member) => firstName(member.name));
  return writers.map((member, index) => {
    const short = names[index]!;
    const shared = names.filter((name) => name.toLowerCase() === short.toLowerCase()).length > 1;
    return {
      userId: member.userId,
      name: member.name,
      title: `${short}'s Claude`,
      shortLabel: short,
      detail: shared ? member.email : null,
      isYou: member.userId === currentUserId,
    };
  });
}
