/**
 * Guarded write of one rank-index entry (availability spec 12.2.3). KEYS: `slots-ver:<id>`, `next-available:index`, `free-map:<id>`;
 * ARGV: expected version, member, score, free-map bytes, free-map TTL. Returns 1 when written, 0 when a concurrent invalidation bumped
 * the version since the inputs were read (the entry is discarded; the invalidation already queued the doctor for refresh).
 */
export const WRITE_NEXT_AVAILABLE_LUA = `local v = redis.call('GET', KEYS[1])
if not v then v = '0' end
if v ~= ARGV[1] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
return 1`;
