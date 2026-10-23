/** Parts of a search the response could not honour; the values are the contract's `meta.degraded` enum, in the order they are listed. */
export enum DegradedPart { Sort = "sort", AvailabilityFilter = "availabilityFilter", NameFilter = "nameFilter" }

/** The contract's `sort` query values. */
export enum SearchSortKind { EarliestAvailability = "earliest_availability", Price = "price", Experience = "experience" }

/** What a signed search cursor was issued under: the effective order (`degraded` = earliest served in price order). */
export enum DiscoveryCursorKind { Earliest = "earliest", Price = "price", Experience = "experience", Degraded = "degraded" }

/** `status` of the admin profile view. */
export enum DoctorBookability { Bookable = "bookable", NotBookable = "not_bookable" }

/** Whether a doctor's rank-index score settles a window filter, or the free-map must be read. */
export enum WindowMatchVerdict { Match = "match", NoMatch = "no_match", NeedsMap = "needs_map" }
