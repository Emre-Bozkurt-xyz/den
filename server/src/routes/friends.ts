/**
 * Friending (BACKBONE §2, §5, §6). Friendship gates DMs and group adds — see
 * chat/service.ts createChat.
 *
 * Route shape deviates slightly from the BACKBONE §6 sketch: accept/decline
 * are addressed by the *other user's id*, not a synthetic request id — the
 * `friendships` table's primary key is the (user_a, user_b) pair (§5 DDL has
 * no surrogate id column), and a pair has at most one relationship at a time,
 * so the other user's id is already a unique, stable handle for "the request
 * between us." Logged in BACKBONE §15.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import type { FriendEntry, FriendsResponse, SendFriendRequestBody } from '@den/shared';
import { WsType, makeEnvelope } from '@den/shared';
import { db } from '../db/index.js';
import { friendships, users } from '../db/schema.js';
import { requireAuth } from '../auth/session.js';
import { toPublicUser } from '../mappers.js';
import { pair } from '../chat/friends.js';
import { notFound, validation } from '../errors.js';
import { userRoom } from '../realtime/rooms.js';

export async function friendRoutes(app: FastifyInstance): Promise<void> {
  app.get('/friends', { preHandler: requireAuth }, async (req) => {
    const me = req.user!.id;
    const rows = await db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userA, me), eq(friendships.userB, me)));

    const otherIds = rows.map((r) => (r.userA === me ? r.userB : r.userA));
    const otherUsers = otherIds.length
      ? await db
          .select({ id: users.id, username: users.username, displayName: users.displayName, avatarKey: users.avatarKey })
          .from(users)
          .where(or(...otherIds.map((id) => eq(users.id, id))))
      : [];
    const byId = new Map(otherUsers.map((u) => [u.id.toString(), u]));

    const entries: FriendEntry[] = rows.map((r) => {
      const otherId = r.userA === me ? r.userB : r.userA;
      const other = byId.get(otherId.toString());
      const direction =
        r.status === 'pending' ? (r.requestedBy === me ? 'outgoing' : 'incoming') : null;
      return {
        user: other ? toPublicUser(other) : { id: otherId.toString(), username: '?', displayName: '?', avatarUrl: null },
        status: r.status as 'pending' | 'accepted',
        direction,
        createdAt: r.createdAt.toISOString(),
      };
    });

    const res: FriendsResponse = {
      friends: entries.filter((e) => e.status === 'accepted'),
      incoming: entries.filter((e) => e.direction === 'incoming'),
      outgoing: entries.filter((e) => e.direction === 'outgoing'),
    };
    return res;
  });

  app.post<{ Body: SendFriendRequestBody }>('/friends/requests', { preHandler: requireAuth }, async (req) => {
    const me = req.user!.id;
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    if (!username) throw validation('username required');

    const targetRows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName, avatarKey: users.avatarKey })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound('user not found');
    if (target.id === me) throw validation("you can't friend yourself");

    const [userA, userB] = pair(me, target.id);
    const existing = await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userA, userA), eq(friendships.userB, userB)))
      .limit(1);

    if (existing[0]?.status === 'accepted') throw validation('already friends');

    if (existing[0]?.status === 'pending') {
      if (existing[0].requestedBy === me) throw validation('request already sent');
      // They already requested us — sending a request back is mutual interest; accept it.
      await db
        .update(friendships)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(and(eq(friendships.userA, userA), eq(friendships.userB, userB)));
      app.io?.to(userRoom(target.id)).emit('ws', makeEnvelope(WsType.FriendAccepted, { by: toPublicUser(req.user!) }));
      return { ok: true, status: 'accepted' as const };
    }

    await db.insert(friendships).values({ userA, userB, status: 'pending', requestedBy: me });
    app.io?.to(userRoom(target.id)).emit('ws', makeEnvelope(WsType.FriendRequest, { from: toPublicUser(req.user!) }));
    return { ok: true, status: 'pending' as const };
  });

  app.post<{ Params: { userId: string } }>(
    '/friends/requests/:userId/accept',
    { preHandler: requireAuth },
    async (req) => {
      const me = req.user!.id;
      const otherId = parseUserId(req.params.userId);
      const [userA, userB] = pair(me, otherId);

      const rows = await db
        .select()
        .from(friendships)
        .where(and(eq(friendships.userA, userA), eq(friendships.userB, userB)))
        .limit(1);
      const row = rows[0];
      if (!row || row.status !== 'pending' || row.requestedBy === me) {
        throw notFound('no incoming request from that user');
      }

      await db
        .update(friendships)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(and(eq(friendships.userA, userA), eq(friendships.userB, userB)));
      app.io?.to(userRoom(otherId)).emit('ws', makeEnvelope(WsType.FriendAccepted, { by: toPublicUser(req.user!) }));
      return { ok: true };
    },
  );

  app.post<{ Params: { userId: string } }>(
    '/friends/requests/:userId/decline',
    { preHandler: requireAuth },
    async (req) => {
      const me = req.user!.id;
      const otherId = parseUserId(req.params.userId);
      const [userA, userB] = pair(me, otherId);

      const result = await db
        .delete(friendships)
        .where(
          and(
            eq(friendships.userA, userA),
            eq(friendships.userB, userB),
            eq(friendships.status, 'pending'),
          ),
        )
        .returning({ userA: friendships.userA });
      if (result.length === 0) throw notFound('no pending request from that user');
      return { ok: true };
    },
  );
}

function parseUserId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid user id');
  }
}
