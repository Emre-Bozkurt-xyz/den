/**
 * Owner authorization (docs/ADMIN_CONSOLE.md §2, §4).
 *
 * ⚠️ **This is Den's first authorization concept that is not chat membership**,
 * and the boundary matters more than the code. Hard invariant 1 says
 * authorization = chat membership, and that is the app's entire privacy model.
 * Rather than carve an exception into it, the rule is:
 *
 *   > The owner is an OPERATOR, not a READER. No admin surface ever exposes
 *   > message content, media, captions, tags, embeds, or chat membership.
 *
 * So `assertMember` remains the only path to chat data, and admin routes are
 * simply not chat-scoped — `requireOwner` is a parallel gate over a disjoint
 * set of routes, never a bypass of the first. If an admin feature ever seems
 * to need chat content, that is a signal to redesign the feature.
 *
 * ⚠️ `is_owner` is set ONLY by `npm run owner grant` from the host shell.
 * There is deliberately no route, and no in-app toggle even for an existing
 * owner, so an attacker with a fully compromised session still cannot
 * escalate. Do not add one.
 */
import { eq } from 'drizzle-orm';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { forbidden } from '../errors.js';
import { requireAuth } from './session.js';

/** Is this user the owner? Read fresh — `req.user` does not carry the flag. */
export async function isOwner(userId: bigint): Promise<boolean> {
  const rows = await db
    .select({ isOwner: users.isOwner })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.isOwner === true;
}

/**
 * Fastify preHandler: authenticated AND the owner, else 403.
 *
 * Composed on top of `requireAuth` exactly as chat routes layer `assertMember`
 * on it — authentication and authorization stay separate gates. 403 rather
 * than 404: a non-owner member is a legitimate caller who is simply not
 * allowed, and there is nothing here whose existence is a secret.
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  const me = req.user!;
  if (!(await isOwner(me.id))) {
    req.log.warn({ userId: me.id.toString(), path: req.url }, 'non-owner hit an admin route');
    throw forbidden('Not allowed');
  }
}
