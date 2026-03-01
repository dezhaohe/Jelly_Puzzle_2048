const LEADERBOARD_KEY = 'leaderboard:global';
const PLAYER_NAME_KEY_PREFIX = 'player:name:';

import { getRedis } from './security.mjs';

function playerNameKey(playerId) {
  return `${PLAYER_NAME_KEY_PREFIX}${playerId}`;
}

export function normalizeName(input) {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, 24);
}

async function buildTop(redis, limit) {
  const rows = await redis.zrange(LEADERBOARD_KEY, 0, limit - 1, { rev: true, withScores: true });
  const ids = [];
  const scores = [];

  for (let i = 0; i < rows.length; i += 2) {
    ids.push(String(rows[i]));
    scores.push(Number(rows[i + 1]));
  }

  if (ids.length === 0) return [];

  const names = await redis.mget(...ids.map((id) => playerNameKey(id)));

  return ids.map((id, idx) => ({
    rank: idx + 1,
    name: typeof names[idx] === 'string' && names[idx].trim() ? names[idx] : 'Player',
    score: scores[idx]
  }));
}

async function buildMe(redis, playerId) {
  if (!playerId) return null;

  const [rankZero, score, name] = await Promise.all([
    redis.zrevrank(LEADERBOARD_KEY, playerId),
    redis.zscore(LEADERBOARD_KEY, playerId),
    redis.get(playerNameKey(playerId))
  ]);

  if (rankZero === null || score === null) return null;

  return {
    rank: Number(rankZero) + 1,
    score: Number(score),
    name: typeof name === 'string' && name.trim() ? name : 'Player'
  };
}

export async function getLeaderboard({ playerId = '', limit = 50 } = {}) {
  const redis = getRedis();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const [top, me] = await Promise.all([
    buildTop(redis, safeLimit),
    buildMe(redis, playerId)
  ]);

  return { top, me };
}

export async function submitScore({ playerId, name, score }) {
  const redis = getRedis();
  const current = await redis.zscore(LEADERBOARD_KEY, playerId);
  const nextBest = current === null ? score : Math.max(Number(current), score);

  const ops = [redis.set(playerNameKey(playerId), name)];
  if (current === null || nextBest > Number(current)) {
    ops.push(redis.zadd(LEADERBOARD_KEY, { score: nextBest, member: playerId }));
  }
  await Promise.all(ops);

  return getLeaderboard({ playerId, limit: 50 });
}
