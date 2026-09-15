'use server';

import { AuthError, CredentialsSignin } from 'next-auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth, signIn, signOut } from '@/auth';
import { addCredential, deleteCredential, requireCredentialsKey } from './credentials';
import { getDb } from './db';
import { env } from './env';
import { getOrchestrator } from './orchestrator';
import {
  addMember,
  createWorkspace,
  deleteWorkspace,
  removeMember,
  startWorkspace,
  stopWorkspace,
} from './workspaces';
import { approveTask, cancelTask, createTask, deleteTask, requeueTask, updatePolicy } from './tasks';

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');
  return session.user.id;
}

function deps() {
  return { db: getDb(), orchestrator: getOrchestrator() };
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function withError(path: string, err: unknown): never {
  const message = err instanceof Error ? err.message : 'unexpected error';
  const url = new URL(path, 'http://x');
  url.searchParams.set('error', message.slice(0, 200));
  redirect(`${url.pathname}${url.search}`);
}

export async function signInAction(formData: FormData): Promise<void> {
  const callbackUrl = field(formData, 'callbackUrl') || '/';
  try {
    await signIn('credentials', {
      email: field(formData, 'email'),
      password: field(formData, 'password'),
      redirectTo: callbackUrl.startsWith('/') ? callbackUrl : '/',
    });
  } catch (err) {
    if (err instanceof CredentialsSignin && err.code === 'rate_limited') redirect('/sign-in?error=rate_limited');
    if (err instanceof AuthError) redirect('/sign-in?error=invalid');
    throw err; // NEXT_REDIRECT on success
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  let slug: string;
  try {
    const workspace = await createWorkspace(deps(), userId, { name: field(formData, 'name'), slug: field(formData, 'slug') || undefined });
    slug = workspace.slug;
  } catch (err) {
    withError('/', err);
  }
  revalidatePath('/');
  redirect(`/workspaces/${slug}`);
}

export async function startWorkspaceAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    await startWorkspace(deps(), userId, workspaceId);
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function stopWorkspaceAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    await stopWorkspace(deps(), userId, workspaceId);
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function deleteWorkspaceAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    if (field(formData, 'confirmSlug').trim() !== field(formData, 'expectedSlug')) {
      throw new Error('type the workspace slug to confirm deletion (this removes the container and its volume)');
    }
    await deleteWorkspace(deps(), userId, workspaceId);
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath('/');
  redirect('/');
}

export async function addMemberAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  const role = field(formData, 'role') === 'editor' ? 'editor' : 'viewer';
  try {
    await addMember(deps(), userId, workspaceId, { email: field(formData, 'email'), role });
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    await removeMember(deps(), userId, workspaceId, field(formData, 'userId'));
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

// ---------------------------------------------------------------------------
// Agent tasks, coordination policy, provider credentials
// ---------------------------------------------------------------------------


export async function createTaskAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    await createTask(getDb(), userId, workspaceId, {
      title: field(formData, 'title'),
      description: field(formData, 'description'),
      runtime: field(formData, 'runtime'),
      model: field(formData, 'model') || undefined,
      credentialId: field(formData, 'credentialId') || undefined,
      scope: field(formData, 'scope') || undefined,
      command: field(formData, 'command') || undefined,
      agentName: field(formData, 'agentName') || undefined,
      maxMinutes: Number(field(formData, 'maxMinutes') || 30),
    });
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

async function taskTransitionAction(formData: FormData, fn: (db: ReturnType<typeof getDb>, userId: string, taskId: string) => Promise<void>): Promise<void> {
  const userId = await requireUserId();
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    await fn(getDb(), userId, field(formData, 'taskId'));
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function approveTaskAction(formData: FormData): Promise<void> {
  return taskTransitionAction(formData, approveTask);
}

export async function cancelTaskAction(formData: FormData): Promise<void> {
  return taskTransitionAction(formData, cancelTask);
}

export async function requeueTaskAction(formData: FormData): Promise<void> {
  return taskTransitionAction(formData, requeueTask);
}

export async function deleteTaskAction(formData: FormData): Promise<void> {
  return taskTransitionAction(formData, deleteTask);
}

export async function updatePolicyAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const workspaceId = field(formData, 'workspaceId');
  const returnTo = field(formData, 'returnTo') || '/';
  try {
    await updatePolicy(getDb(), userId, workspaceId, {
      overlap: field(formData, 'overlap') === 'warn' ? 'warn' : 'block',
      integration: field(formData, 'integration') === 'auto' ? 'auto' : 'human',
      checkCommand: field(formData, 'checkCommand').trim() || null,
      baseBranch: field(formData, 'baseBranch').trim() || 'main',
    });
  } catch (err) {
    withError(returnTo, err);
  }
  revalidatePath(returnTo);
  redirect(returnTo);
}

export async function addCredentialAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  try {
    await addCredential(getDb(), userId, requireCredentialsKey(env().CREDENTIALS_KEY), {
      provider: field(formData, 'provider'),
      label: field(formData, 'label'),
      secret: field(formData, 'secret'),
    });
  } catch (err) {
    withError('/settings/credentials', err);
  }
  revalidatePath('/settings/credentials');
  redirect('/settings/credentials');
}

export async function deleteCredentialAction(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  try {
    await deleteCredential(getDb(), userId, field(formData, 'credentialId'));
  } catch (err) {
    withError('/settings/credentials', err);
  }
  revalidatePath('/settings/credentials');
  redirect('/settings/credentials');
}
