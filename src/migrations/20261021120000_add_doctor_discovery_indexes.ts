import type { Knex } from "knex";

/**
 * Discovery indexes (availability spec 2.1). No table, column, constraint or grant changes; every index serves a statement in
 * `doctors/repository/doctor-discovery.repo.ts`. The partial predicate is spelled exactly as the candidate query spells it, so the
 * planner can prove the implication. Created without CONCURRENTLY: the migration runs in a transaction and the tables are small at launch.
 */
export async function up(knex: Knex): Promise<void> {
    // Candidate query, sort=price keyset (path A) and every unsorted candidate scan (path B):
    //   SELECT dp.id, dp.user_id, dp.consultation_fee, dp.years_experience FROM doctor_profiles dp
    //   WHERE <bookable predicate> [AND dp.consultation_fee BETWEEN $min AND $max] [AND (dp.consultation_fee, dp.id) > ($fee, $id)]
    //   ORDER BY dp.consultation_fee, dp.id LIMIT $n + 1
    await knex.raw(`CREATE INDEX idx_doctor_profiles_bookable_fee_id ON doctor_profiles (consultation_fee, id)
        WHERE verification_status = 'approved' AND identity_sync_status = 'synced' AND suspended_at IS NULL AND is_accepting_patients AND deleted_at IS NULL;`);

    // sort=experience keyset (path A): ... ORDER BY dp.years_experience DESC, dp.id DESC
    //   AND (dp.years_experience, dp.id) < ($years, $id) LIMIT $n + 1
    await knex.raw(`CREATE INDEX idx_doctor_profiles_bookable_experience_id ON doctor_profiles (years_experience DESC, id DESC)
        WHERE verification_status = 'approved' AND identity_sync_status = 'synced' AND suspended_at IS NULL AND is_accepting_patients AND deleted_at IS NULL;`);

    // Search filter ?language=: EXISTS (SELECT 1 FROM doctor_languages dl WHERE dl.doctor_profile_id = dp.id AND dl.language_code = $1)
    await knex.raw(`CREATE INDEX idx_doctor_languages_language_code_doctor_profile_id ON doctor_languages (language_code, doctor_profile_id);`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP INDEX IF EXISTS idx_doctor_languages_language_code_doctor_profile_id;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_doctor_profiles_bookable_experience_id;`);
    await knex.raw(`DROP INDEX IF EXISTS idx_doctor_profiles_bookable_fee_id;`);
}
