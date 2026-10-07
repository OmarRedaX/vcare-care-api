export class StorageError extends Error {
    constructor(readonly operation: string) {
        super(`Object storage ${operation} failed`);
        this.name = "StorageError";
    }
}
