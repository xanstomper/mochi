// isPalindrome(text): true when text reads the same forwards and backwards,
// ignoring case, spaces and punctuation.
function isPalindrome(text) {
  const cleaned = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned === [...cleaned].reverse().join('');
}
module.exports = { isPalindrome };
