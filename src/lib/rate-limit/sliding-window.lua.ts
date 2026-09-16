/**
 * Atomic sliding window. Denied requests are NOT added to the set, so a blocked client recovers as soon
 * as the window slides past its oldest hit. Returns `{ allowed, oldestScoreMs }`.
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local used = redis.call('ZCARD', key)

if used < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = 0
if oldest[2] then
  oldestScore = tonumber(oldest[2])
end
return {0, oldestScore}
`;
