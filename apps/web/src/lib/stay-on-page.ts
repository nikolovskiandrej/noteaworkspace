import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Ends a successful server action that stays on the page it was sent from.
 *
 * Revalidating is what shows the new data, and it leaves the page mounted. A
 * `redirect()` to the same page does not: Next rejects the action with the redirect
 * and rethrows it into the form that sent it, and the redirect boundary remounts the
 * whole page. That threw away unsaved editor text, terminal attachments and open
 * panels whenever the form was still on screen (queueing a task, saving the policy,
 * adding a member). So the redirect happens only to clear a notice the page shows from
 * its query string, such as the `?error=` of an earlier failure.
 *
 * Not a server action itself: this module has no 'use server', so it cannot be called
 * from the browser.
 */
export async function stayOnPage(path: string): Promise<void> {
  revalidatePath(path);
  const referer = (await headers()).get('referer');
  if (referer && URL.canParse(referer) && new URL(referer).search) redirect(path);
}
