import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { findForSlots } from "../repository/doctor-discovery.repo";
import type { SlotDoctor } from "../types";

@injectable()
export class DoctorDiscoveryReader {
    constructor(@inject(TOKENS.Db) private readonly db: Knex) {}
    findForSlots(userId: number, conn: Knex = this.db): Promise<SlotDoctor | undefined> { return findForSlots(userId, conn); }
}
