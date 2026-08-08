// Capitalizes the first letter of each word without forcing the rest of
// each word to lowercase - preserves intentional casing like "iPhone" or
// acronyms, just ensures every word starts with a capital.
function capitalizeWords(str) {
  if (!str) return str;
  return str.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

module.exports = { capitalizeWords };
