import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { findForSlots, listBookableForIndex, listCandidates, pageCandidates } from "../repository/doctor-discovery.repo";
import type { Candidate, CandidateFilters, CandidatePageParams, CappedList, IndexDoctor, SlotDoctor } from "../types";

/** Read side of `doctors` for `availability` and `care-worker` (built with `new`, so it needs only the `Knex`). */
@injectable()
export class DoctorDiscoveryReader {
    constructor(@inject(TOKENS.Db) private readonly db: Knex) {}
    findForSlots(userId: number, conn: Knex = this.db): Promise<SlotDoctor | undefined> { return findForSlots(userId, conn); }
    listCandidates(filters: CandidateFilters, conn: Knex = this.db): Promise<CappedList<Candidate>> { return listCandidates(filters, conn); }
    pageCandidates(filters: CandidateFilters, params: CandidatePageParams, conn: Knex = this.db): Promise<Candidate[]> { return pageCandidates(filters, params, conn); }
    listBookableForIndex(userIds?: readonly number[], conn: Knex = this.db): Promise<CappedList<IndexDoctor>> { return listBookableForIndex(userIds, conn); }
}
