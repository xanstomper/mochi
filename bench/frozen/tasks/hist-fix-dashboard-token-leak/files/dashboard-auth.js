// Frozen-task fixture: the daemon dashboard's token/CORS decisions, extracted
// from src/daemon/daemon.ts as of 55db719^ (the parent of the dashboard
// token-leak fix). The parent route code was:
//   res.end(getDashboardHtml(reqToken || auth.token));
//   const cors = { 'access-control-allow-origin': '*', ... };
// i.e. a request with NO token was served dashboard HTML embedding the REAL
// bearer token, and every origin received a wildcard CORS grant. The two
// functions below reproduce that observable behavior in the shape the fix
// later gave them: dashboardResponseToken decides which token (if any) the
// served HTML may embed, corsAllowOrigin decides the
// access-control-allow-origin value for a request Origin.

/** Which token the dashboard HTML for this request may embed. Parent
 *  semantics: the request's token if one was supplied, otherwise the real
 *  daemon token — to any requester, authenticated or not. */
function dashboardResponseToken(reqToken, tokenOk, realToken) {
  return reqToken || realToken;
}

/** The access-control-allow-origin value for this Origin. Parent semantics:
 *  the wildcard, for every origin. */
function corsAllowOrigin(origin) {
  return '*';
}

module.exports = { dashboardResponseToken, corsAllowOrigin };
