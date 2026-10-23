import { injectable } from "tsyringe";
import type { DoctorChangeListener } from "../types";

@injectable()
export class NoopDoctorChangeListener implements DoctorChangeListener {
    async onDoctorChanged(): Promise<void> { /* No availability implementation in isolated module tests. */ }
}
