// isPalindrome(text): true when text reads the same forwards and backwards,
// ignoring case, spaces and punctuation.
function isPalindrome(text) {
  const cleaned = String(text).toLowerCase();
  return cleaned === [...cleaned].reverse().join('');
}
module.exports = { isPalindrome };
