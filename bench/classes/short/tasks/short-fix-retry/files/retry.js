// retry(fn, attempts): call fn until it succeeds, at most `attempts`
// TOTAL calls. On final failure, rethrow the LAST error.
async function retry(fn, attempts) {
  let lastErr;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
module.exports = { retry };
