import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`CREATE TABLE identity_sync_jobs (
        id BIGSERIAL PRIMARY KEY,
        doctor_profile_id BIGINT NOT NULL,
        doctor_user_id BIGINT NOT NULL, -- Identity user id; no FK
        kind VARCHAR(16) NOT NULL,
        target_status VARCHAR(16) NOT NULL,
        reason TEXT,
        actor_user_id BIGINT NOT NULL, -- Identity user id; no FK
        request_id UUID,
        status VARCHAR(16) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        consecutive_failures INT NOT NULL DEFAULT 0,
        last_error_code VARCHAR(32),
        next_attempt_at TIMESTAMPTZ NOT NULL,
        succeeded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT fk_identity_sync_jobs_doctor_profile_id FOREIGN KEY (doctor_profile_id) REFERENCES doctor_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT chk_identity_sync_jobs_kind CHECK (kind IN ('verification','suspension','reinstatement')),
        CONSTRAINT chk_identity_sync_jobs_target_status CHECK ((kind='verification' AND target_status IN ('active','rejected','pending')) OR (kind='suspension' AND target_status='suspended') OR (kind='reinstatement' AND target_status='active')),
        CONSTRAINT chk_identity_sync_jobs_status CHECK (status IN ('pending','succeeded','failed','superseded')),
        CONSTRAINT chk_identity_sync_jobs_attempts CHECK (attempts >= 0 AND consecutive_failures >= 0)
    );`);
    // Worker: due pending jobs ordered by next_attempt_at, FOR UPDATE SKIP LOCKED LIMIT 50.
    await knex.raw(`CREATE INDEX idx_identity_sync_jobs_pending_next_attempt_at ON identity_sync_jobs (next_attempt_at) WHERE status='pending';`);
    // One open job per profile; also covers the profile FK and admin lookup.
    await knex.raw(`CREATE UNIQUE INDEX uq_identity_sync_jobs_doctor_profile_id_open ON identity_sync_jobs (doctor_profile_id) WHERE status='pending';`);
    // Runbook: recent history for a profile.
    await knex.raw(`CREATE INDEX idx_identity_sync_jobs_doctor_profile_id_created_at ON identity_sync_jobs (doctor_profile_id, created_at DESC);`);
    // Runbook: recent history by Identity user id.
    await knex.raw(`CREATE INDEX idx_identity_sync_jobs_doctor_user_id_id ON identity_sync_jobs (doctor_user_id, id DESC);`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON identity_sync_jobs TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE identity_sync_jobs_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS identity_sync_jobs;`);
}
