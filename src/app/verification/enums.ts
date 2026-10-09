export enum VerificationDocumentType { License = "license", Id = "id", Degree = "degree" }
export enum VerificationDocumentStatus { Uploaded = "uploaded", Accepted = "accepted", Rejected = "rejected" }
export enum UploadIntentKind { VerificationDocument = "verification_document", RecordAttachment = "record_attachment" }
export enum VerificationAuditAction {
    Submitted = "verification.submitted", Approved = "verification.approved", Rejected = "verification.rejected",
    Reopened = "verification.reopened", DocumentUploaded = "verification.document_uploaded",
    DocumentDeleted = "verification.document_deleted", DocumentsViewed = "verification.documents_viewed",
    DocumentUrlIssued = "verification.document_url_issued",
}
