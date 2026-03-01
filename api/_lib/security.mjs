import { Redis } from '@upstash/redis';

const SESSION_COOKIE = 'ce_sid';
const SESSION_PLAYER_KEY_PREFIX = 'session:player:';

export function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('storage unavailable');
  }

  return new Redis({ url, token });
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return acc;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

function isValidId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,120}$/.test(value);
}

function sessionPlayerKey(sid) {
  return `${SESSION_PLAYER_KEY_PREFIX}${sid}`;
}

export function getClientIp(request) {
  const xff = request.headers.get('x-forwarded-for') || '';
  if (xff) return xff.split(',')[0].trim() || 'unknown';
  return (request.headers.get('x-real-ip') || '').trim() || 'unknown';
}

export async function getSessionIdentity(request) {
  const redis = getRedis();
  const cookies = parseCookies(request.headers.get('cookie') || '');
  const sid = cookies[SESSION_COOKIE];

  if (isValidId(sid)) {
    const existingPlayerId = await redis.get(sessionPlayerKey(sid));
    if (isValidId(existingPlayerId)) {
      return { sid, playerId: existingPlayerId, setCookie: false };
    }
  }

  const newSid = randomId('sid');
  const newPlayerId = randomId('p');
  await redis.set(sessionPlayerKey(newSid), newPlayerId);
  return { sid: newSid, playerId: newPlayerId, setCookie: true };
}

export function applySessionCookie(headers, sid) {
  headers.set(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
  );
}

export async function enforceRateLimit({ request, bucket, limit, windowSec, subject = '' }) {
  const redis = getRedis();
  const ip = getClientIp(request);
  const window = Math.floor(Date.now() / (windowSec * 1000));
  const identity = (subject || ip || 'anonymous').slice(0, 160);
  const key = `rl:${bucket}:${identity}:${window}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec + 2);
  }
  if (count > limit) {
    return { ok: false, retryAfter: windowSec };
  }
  return { ok: true, retryAfter: 0 };
}
