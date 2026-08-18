/**
 * Prints 'hi', lists items in bold formatting, and includes a URL.
 * Run with: node dist/say-hi.js
 */
export function sayHi(): string {
  const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`;
  const lines = [
    "hi",
    "",
    "Items:",
    `- ${bold("alpha")}`,
    `- ${bold("beta")}`,
    `- ${bold("gamma")}`,
    "",
    "URL: https://example.com",
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(sayHi());
}