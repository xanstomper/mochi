const { PAGE_SIZE } = require('./config.js');

// paginate(items, page): the 1-based `page` of `pageSize` items.
function paginate(items, page, pageSize = PAGE_SIZE) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
module.exports = { paginate };
