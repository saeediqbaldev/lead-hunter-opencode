// Express 4 does not automatically catch errors thrown inside async route
// handlers (Express 5 does this natively, but this app is on 4.x) - without
// wrapping, an unexpected error anywhere in an async handler leaves the
// request hanging with no response ever sent, until the reverse proxy's own
// timeout eventually returns a generic HTML error page instead of JSON.
// Wrap any async route handler with this to guarantee it always resolves
// to a real, JSON-formatted response.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
