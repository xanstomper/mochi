const { ITEMS } = require('./data.js');
const { paginate } = require('./query.js');

// handleRequest('/items?page=N') -> { status, body: { page, ids } }
function handleRequest(path) {
  const url = new URL(path, 'http://localhost');
  if (url.pathname !== '/items') return { status: 404, body: { page: 0, ids: [] } };
  const page = Number(url.searchParams.get('page') ?? '1');
  const items = paginate(ITEMS, page);
  return { status: 200, body: { page, ids: items.map((i) => i.id) } };
}
module.exports = { handleRequest };
