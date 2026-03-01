import { normalizeName, submitScore } from './_lib/leaderboard.mjs';
import { applySessionCookie, enforceRateLimit, getSessionIdentity } from './_lib/security.mjs';

export async function POST(request) {
  let session;
  try {
    session = await getSessionIdentity(request);
    const rl = await enforceRateLimit({
      request,
      bucket: 'leaderboard-write',
      limit: 30,
      windowSec: 60,
      subject: session.sid
    });
    if (!rl.ok) {
      return Response.json(
        { error: 'too many requests' },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfter), 'Cache-Control': 'no-store' }
        }
      );
    }
  } catch {
    return Response.json({ error: 'service unavailable' }, { status: 500 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const name = normalizeName(payload?.name);
  const score = Number(payload?.score);

  if (!name) {
    return Response.json({ error: 'nickname required' }, { status: 400 });
  }
  if (!Number.isInteger(score) || score < 0) {
    return Response.json({ error: 'invalid score' }, { status: 400 });
  }

  try {
    const data = await submitScore({ playerId: session.playerId, name, score });
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (session.setCookie) applySessionCookie(headers, session.sid);
    return Response.json(data, {
      headers
    });
  } catch {
    return Response.json({ error: 'service unavailable' }, { status: 500 });
  }
}
