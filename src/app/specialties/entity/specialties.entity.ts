export class Specialty {
    id!: number;
    name!: string;
    slug!: string;
    description!: string | null;
    isActive!: boolean;
    createdAt!: Date;
    updatedAt!: Date;

    constructor(data: Partial<Specialty>) {
        Object.assign(this, data);
    }
}
