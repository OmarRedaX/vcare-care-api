import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE specialties (
            id           BIGSERIAL PRIMARY KEY,
            name         VARCHAR(100) NOT NULL,
            slug         VARCHAR(100) NOT NULL,
            description  TEXT,
            is_active    BOOLEAN NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT uq_specialties_slug UNIQUE (slug),
            CONSTRAINT uq_specialties_name UNIQUE (name),
            CONSTRAINT chk_specialties_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
            CONSTRAINT chk_specialties_name_length CHECK (char_length(name) >= 2),
            CONSTRAINT chk_specialties_description_length CHECK (description IS NULL OR char_length(description) <= 2000)
        );
    `);

    await knex.raw(`
        COMMENT ON TABLE specialties IS 'Admin-managed specialty catalog. Never deleted (vcare_app has no DELETE): deactivated with is_active=false because doctor links reference rows.';
    `);

    // GET /api/specialties keyset page:
    // SELECT … FROM specialties [WHERE is_active = true] [AND (name, id) > ($name, $id)] ORDER BY name ASC, id ASC LIMIT $n
    // uq_specialties_slug serves ?specialty=<slug>; uq_specialties_name serves uniqueness.
    // Neither can seek on the (name, id) row comparison.
    await knex.raw(`CREATE INDEX idx_specialties_name_id ON specialties (name, id);`);

    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON specialties TO vcare_app;`);
    await knex.raw(`GRANT USAGE ON SEQUENCE specialties_id_seq TO vcare_app;`);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`DROP TABLE IF EXISTS specialties;`);
}
