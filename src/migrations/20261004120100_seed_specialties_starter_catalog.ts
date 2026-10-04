import type { Knex } from "knex";

/** Synthetic catalog data; no personal data. */
const STARTER_SPECIALTIES: ReadonlyArray<readonly [name: string, slug: string, description: string]> = [
    ["Allergy and Immunology", "allergy-immunology", "Allergies, asthma, and immune system conditions."],
    ["Cardiology", "cardiology", "Heart and blood vessel conditions."],
    ["Dermatology", "dermatology", "Skin, hair, and nail conditions."],
    ["Endocrinology", "endocrinology", "Hormone and metabolic conditions, including diabetes and thyroid disorders."],
    ["Family Medicine", "family-medicine", "Ongoing primary care for patients of all ages."],
    ["Gastroenterology", "gastroenterology", "Digestive system and liver conditions."],
    ["General Practice", "general-practice", "First-contact care for common health concerns."],
    ["Infectious Diseases", "infectious-diseases", "Bacterial, viral, fungal, and parasitic infections."],
    ["Internal Medicine", "internal-medicine", "Prevention, diagnosis, and treatment of adult diseases."],
    ["Nephrology", "nephrology", "Kidney conditions."],
    ["Neurology", "neurology", "Brain, spinal cord, and nerve conditions."],
    ["Obstetrics and Gynecology", "obstetrics-gynecology", "Pregnancy care and reproductive health."],
    ["Ophthalmology", "ophthalmology", "Eye and vision conditions."],
    ["Orthopedics", "orthopedics", "Bone, joint, and muscle conditions."],
    ["Otolaryngology", "otolaryngology", "Ear, nose, and throat conditions."],
    ["Pediatrics", "pediatrics", "Health care for infants, children, and adolescents."],
    ["Psychiatry", "psychiatry", "Mental health conditions."],
    ["Pulmonology", "pulmonology", "Lung and breathing conditions."],
    ["Rheumatology", "rheumatology", "Joint, muscle, and autoimmune conditions."],
    ["Urology", "urology", "Urinary tract and male reproductive conditions."],
];

export async function up(knex: Knex): Promise<void> {
    await knex.raw(
        `INSERT INTO specialties (name, slug, description, is_active)
         VALUES ${STARTER_SPECIALTIES.map(() => "(?, ?, ?, true)").join(", ")}
         ON CONFLICT DO NOTHING`,
        STARTER_SPECIALTIES.flat(),
    );
}

export async function down(knex: Knex): Promise<void> {
    const slugs = STARTER_SPECIALTIES.map(([, slug]) => slug);
    const linked = await knex.raw<{ rows: Array<{ exists: boolean }> }>(
        "SELECT to_regclass('public.doctor_specialties') IS NOT NULL AS exists",
    );
    if (linked.rows[0]?.exists === true) {
        await knex.raw(
            `DELETE FROM specialties s
             WHERE s.slug = ANY(?::text[])
               AND NOT EXISTS (SELECT 1 FROM doctor_specialties ds WHERE ds.specialty_id = s.id)`,
            [slugs],
        );
        return;
    }
    await knex.raw("DELETE FROM specialties WHERE slug = ANY(?::text[])", [slugs]);
}
