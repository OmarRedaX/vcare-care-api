export enum HelpArticleCategory {
    HowItWorks = "how-it-works",
    PreparingForConsultation = "preparing-for-consultation",
    CancellationPolicy = "cancellation-policy",
    PlatformRules = "platform-rules",
}

export enum HelpArticleAudience {
    Patient = "patient",
    Doctor = "doctor",
}

export enum HelpArticleAuditAction {
    Created = "help_article.created",
    Updated = "help_article.updated",
    Deleted = "help_article.deleted",
}

export enum HelpArticleField {
    Title = "title",
    Body = "body",
    Category = "category",
    Audience = "audience",
    IsPublished = "isPublished",
}
