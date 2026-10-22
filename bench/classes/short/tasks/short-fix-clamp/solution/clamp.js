// clamp(value, min, max): constrain value to the inclusive range [min, max].
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
module.exports = { clamp };
