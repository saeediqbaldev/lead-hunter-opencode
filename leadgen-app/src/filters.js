/**
 * Given a normalized place record, decide which services this business
 * looks like a good prospect for. Pure rule-based logic - no API cost.
 *
 * Tune the thresholds below as you learn what "good lead" means for you.
 */
function tagNeeds(place) {
  const needs = [];

  if (!place.website) {
    needs.push("Website Design");
  }

  if (place.review_count !== null) {
    if (place.review_count < 5) {
      needs.push("GMB Optimization");
    }
    if (place.review_count < 15) {
      needs.push("Review Generation");
    }
  }

  if (place.rating !== null && place.rating < 4.0) {
    needs.push("Reputation Management");
  }

  if (place.website) {
    // Has a website but weak online presence signals (low reviews) ->
    // likely needs Local SEO rather than a full rebuild.
    if (place.review_count !== null && place.review_count < 10) {
      needs.push("Local SEO");
    }
  }

  if (needs.length === 0) {
    needs.push("Strong Presence (low priority)");
  }

  return [...new Set(needs)];
}

module.exports = { tagNeeds };
