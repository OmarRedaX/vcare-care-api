export interface CreateRedisOptions {
    /** Connection name reported by `CLIENT LIST` — helps identify pools in production. */
    name?: string;
}
