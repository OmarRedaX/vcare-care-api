export const DISCOVERY_IP_LIMIT = 60;
export const DISCOVERY_USER_LIMIT = 120;
export const DISCOVERY_RATE_WINDOW_MS = 60_000;
export const DOCTORS_SLOTS_IP_RATE_NAME = "doctors-slots-ip";
export const DOCTORS_SLOTS_USER_RATE_NAME = "doctors-slots-user";
export const SLOTS_MAX_SPAN_DAYS = 14;
export const SLOT_VERSION_TTL_SECONDS = 604_800;
export const DOCTORS_SEARCH_IP_RATE_NAME = "doctors-search-ip";
export const DOCTORS_SEARCH_USER_RATE_NAME = "doctors-search-user";
export const DOCTORS_PROFILE_IP_RATE_NAME = "doctors-profile-ip";
export const DOCTORS_PROFILE_USER_RATE_NAME = "doctors-profile-user";

/** Rank-index score of a doctor known to have no free slot in the next 14 days (ranks last). */
export const NONE_SCORE = 1e15;
export const LOOKAHEAD_DAYS = 14;
export const PREVIEW_SLOT_COUNT = 5;
export const FREE_MAP_TTL_SECONDS = 600;
export const MAP_READ_CHUNK = 500;
export const DAY_MS = 86_400_000;

export const SWEEP_LOCK_NAMESPACE = 1104;
export const SWEEP_LOCK_ID = 0;
export const REFRESH_LOOP_NAME = "availability-refresh";
export const SWEEP_LOOP_NAME = "availability-sweep";
export const REFRESH_INTERVAL_MS = 2000;
export const REFRESH_BATCH = 50;
export const REFRESH_MAX_BATCHES_PER_TICK = 10;
export const SWEEP_BATCH = 100;
export const GAUGE_EVERY_MS = 30_000;

export const SEARCH_NAME_MIN_CODE_POINTS = 2;

/** Name index (ADR 0025): member `<normalised name>, NUL, <userId>`, at most 5,000 matches per query, built in a side key and swapped in. */
export const NAME_MEMBER_SEPARATOR = "\u0000";
export const NAME_MATCH_LIMIT = 5000;
export const NAME_ADD_CHUNK = 500;
export const NAME_BUILDING_TTL_SECONDS = 600;
export const NAME_INDEX_TTL_SECONDS = 900;
export const NAME_HYDRATE_CHUNK = 100;

export const LOG_CACHE_UNAVAILABLE = "availability_cache_unavailable";
export const LOG_LISTENER_SKIPPED = "availability_listener_skipped";
export const LOG_FREEMAP_INVALID = "availability_freemap_invalid";
export const LOG_SWEEP_DONE = "availability_sweep_done";
export const LOG_SWEEP_SKIPPED = "availability_sweep_skipped";
export const LOG_REFRESH_DONE = "availability_refresh_done";
export const LOG_NAME_INDEX_BUILT = "availability_name_index_built";
export const LOG_NAME_INDEX_STALE = "availability_name_index_stale";
export const LOG_NAME_INDEX_FAILED = "availability_name_index_failed";
export const LOG_CANDIDATES_TRUNCATED = "availability_candidates_truncated";
export const METRIC_INDEX_MISS = "availability_index_miss";
export const METRIC_INLINE_COMPUTE_MS = "availability_inline_compute_ms";
export const METRIC_DEGRADED = "availability_degraded";
export const METRIC_SWEEP_DURATION_MS = "availability_sweep_duration_ms";
export const METRIC_SWEEP_AGE_S = "availability_sweep_age_s";
export const METRIC_REFRESH_QUEUE_DEPTH = "availability_refresh_queue_depth";
