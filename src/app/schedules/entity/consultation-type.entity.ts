export class ConsultationType {
    id!: number;
    name!: string;
    durationMinutes!: number;
    /** Minor units. */
    price!: number;
    currency!: string;
    isActive!: boolean;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<ConsultationType>) {
        Object.assign(this, data);
    }
}
