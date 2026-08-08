const SORT_COLUMNS = {
  created_at: "l.created_at",
  name: "l.name COLLATE NOCASE",
  rating: "l.rating",
  needs_count: "json_array_length(l.needs)",
};

// Shared WHERE-clause builder so the paginated list, the "export current
// view" endpoint, and the contact scraper all filter identically - same
// scope, same results, so "scrape the current view" genuinely means the
// same set of leads the user is looking at, not a separately-computed
// approximation of it.
function buildLeadsQuery(userId, query) {
  const { status, need, search, catchLogId, nicheId, pinned, inspected } = query;

  const sortBy = SORT_COLUMNS[query.sortBy] ? query.sortBy : "created_at";
  const sortDir = query.sortDir === "asc" ? "ASC" : query.sortDir === "desc" ? "DESC" : null;
  const defaultDir = { created_at: "DESC", rating: "DESC", name: "ASC", needs_count: "DESC" };
  const direction = sortDir || defaultDir[sortBy];

  let baseQuery = `
    FROM leads l
    JOIN catch_logs cl ON cl.id = l.catch_log_id
    JOIN niches n ON n.id = cl.niche_id
    WHERE n.user_id = ?
  `;
  const params = [userId];

  if (nicheId) {
    baseQuery += " AND cl.niche_id = ?";
    params.push(nicheId);
  }
  if (catchLogId) {
    baseQuery += " AND l.catch_log_id = ?";
    params.push(catchLogId);
  }
  if (status) {
    baseQuery += " AND l.status = ?";
    params.push(status);
  }
  if (need) {
    baseQuery += " AND l.needs LIKE ?";
    params.push(`%${need}%`);
  }
  if (search) {
    baseQuery += " AND (l.name LIKE ? OR l.address LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  if (pinned) {
    baseQuery += " AND l.pinned = 1";
  }
  if (inspected) {
    baseQuery += " AND EXISTS(SELECT 1 FROM business_analysis ba WHERE ba.lead_id = l.id AND ba.status = 'done')";
  }

  return { baseQuery, params, sortBy, direction };
}

module.exports = { buildLeadsQuery, SORT_COLUMNS };
