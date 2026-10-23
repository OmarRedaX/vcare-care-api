/** Redis keys of the module's derived data (availability spec 1.1). Everything here is a cache: losing it never loses a fact. */
export const INDEX_KEY = "next-available:index";
export const REFRESH_KEY = "next-available:refresh";
export const SWEPT_AT_KEY = "next-available:swept-at";
export const versionKey = (doctorUserId: number | string): string => `slots-ver:${doctorUserId}`;
export const freeMapKey = (doctorUserId: number | string): string => `free-map:${doctorUserId}`;
