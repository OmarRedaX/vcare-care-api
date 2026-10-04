export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SPECIALTY_NAME_MIN_LENGTH = 2;
export const SPECIALTY_NAME_MAX_LENGTH = 100;
export const SPECIALTY_SLUG_MAX_LENGTH = 100;
export const SPECIALTY_DESCRIPTION_MAX_LENGTH = 2_000;

export const SPECIALTIES_LIST_IP_LIMIT = 60;
export const SPECIALTIES_LIST_USER_LIMIT = 120;
export const SPECIALTIES_LIST_WINDOW_MS = 60_000;

export const SPECIALTY_ENTITY_TYPE = "specialty";
export const SPECIALTY_CONSTRAINTS = {
    name: "uq_specialties_name",
    slug: "uq_specialties_slug",
} as const;
