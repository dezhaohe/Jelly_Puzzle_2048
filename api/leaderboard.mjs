import { getLeaderboard } from './_lib/leaderboard.mjs';
import { applySessionCookie, enforceRateLimit, getSessionIdentity } from './_lib/security.mjs';

export async function GET(request) {
  try {
    const session = await getSessionIdentity(request);
    const rl = await enforceRateLimit({
      request,
      bucket: 'leaderboard-read',
      limit: 120,
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

    const data = await getLeaderboard({ playerId: session.playerId, limit: 50 });
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (session.setCookie) applySessionCookie(headers, session.sid);
    return Response.json(data, {
      headers
    });
  } catch {
    return Response.json({ error: 'service unavailable' }, { status: 500 });
  }
}
