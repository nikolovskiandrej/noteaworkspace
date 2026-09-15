'use server';

import { AuthError } from 'next-auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth, signIn, signOut } from '@/auth';
import { getDb } from './db';
import { getOrchestrator } from './orchestrator';
import {
  addMember,
  createWorkspace,
  deleteWorkspace,
  removeMember,
  startWorkspace,
  stopWorkspace,
} from './workspaces';

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
  try {
    await deleteWorkspace(deps(), userId, workspaceId);
  } catch (err) {
    withError('/', err);
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
