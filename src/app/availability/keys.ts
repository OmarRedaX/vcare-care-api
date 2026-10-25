/** Redis keys of the module's derived data (availability spec 1.1). Everything here is a cache: losing it never loses a fact. */
export const INDEX_KEY = "next-available:index";
export const REFRESH_KEY = "next-available:refresh";
export const SWEPT_AT_KEY = "next-available:swept-at";
export const versionKey = (doctorUserId: number | string): string => `slots-ver:${doctorUserId}`;
export const freeMapKey = (doctorUserId: number | string): string => `free-map:${doctorUserId}`;
/** The derived display-name index (a lexicographic sorted set, score 0), the key it is built in, and the stamp of its last build. */
export const NAME_INDEX_KEY = "name-index";
export const NAME_INDEX_BUILDING_KEY = "name-index:building";
export const NAME_INDEX_BUILT_AT_KEY = "name-index:built-at";
