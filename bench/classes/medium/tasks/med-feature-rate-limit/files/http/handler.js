// Route handlers: (req) -> { status, headers, body }
function dataHandler() {
  return { status: 200, headers: {}, body: { ok: true, data: [1, 2, 3] } };
}
function healthHandler() {
  return { status: 200, headers: {}, body: { ok: true } };
}
module.exports = { dataHandler, healthHandler };
