import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { LiveResponseDto, ReadyResponseDto } from "../dto/health.response.dto";
import type { HealthService } from "../service/health.service";

@injectable()
export class HealthController {
    constructor(@inject(TOKENS.HealthService) private readonly service: HealthService) {}

    live = (_req: Request, res: Response): void => {
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(LiveResponseDto.from(this.service.live()));
    };

    ready = async (_req: Request, res: Response): Promise<void> => {
        const result = await this.service.ready();
        res.setHeader("Cache-Control", "no-store");
        res.status(result.httpStatus).json(ReadyResponseDto.from(result.report));
    };
}
