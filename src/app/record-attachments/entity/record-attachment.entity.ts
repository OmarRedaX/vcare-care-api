export class RecordAttachment {
    id!: number;
    /** `medical_record_id`. */
    recordId!: number;
    /** Identity user id; always the record's author. */
    uploadedByUserId!: number;
    /** Storage key (`record-attachments/<uuid>`): never a URL, never logged, never in a response. */
    objectKey!: string;
    /** The DETECTED type, never a declared one. */
    fileType!: string;
    sizeBytes!: number;
    /** Clinical free text (column `description`). The property is named `attachmentDescription` so a stray log call redacts it by key. */
    attachmentDescription!: string | null;
    createdAt!: Date;
    deletedAt!: Date | null;

    constructor(data: Partial<RecordAttachment>) { Object.assign(this, data); }
}
