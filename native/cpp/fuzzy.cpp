// Mochi native fuzzy line matcher (C++).
//
// Same contract as TypeScript fuzzyFindUnique in src/tools/fuzzy-match.ts and
// the Rust build in native/rust/fuzzy.rs. Finds the unique region in `text`
// that matches `needle` after whitespace normalization; multiple matches are
// ambiguous and return NONE.
//
// Wire protocol (stdin lines -> stdout one line):
//   first line:  "NEEDLE"
//   needle lines...
//   a line with exactly "---TEXT---" separates needle from text
//   text lines...
// Output: OK <start> <end>  |  NONE  |  ERR <message>
//
// Build: g++ -O2 -std=c++17 -o bin/fuzzy_cpp native/cpp/fuzzy.cpp
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

static std::string normalize(const std::string& line) {
    std::istringstream in(line);
    std::string word;
    std::vector<std::string> words;
    while (in >> word) words.push_back(word);
    std::string out;
    for (size_t i = 0; i < words.size(); ++i) {
        if (i) out += ' ';
        out += words[i];
    }
    return out;
}

static bool find_unique(const std::vector<std::string>& needle,
                        const std::vector<std::string>& text,
                        long long* out_start, long long* out_end) {
    if (needle.empty() || needle.size() > text.size()) return false;
    std::vector<std::string> n = needle, t;
    for (const auto& line : text) t.push_back(normalize(line));
    for (auto& line : n) line = normalize(line);

    long long count = 0, start = 0, end = 0;
    for (size_t i = 0; i + n.size() <= t.size(); ++i) {
        bool ok = true;
        for (size_t j = 0; j < n.size(); ++j) {
            if (t[i + j] != n[j]) { ok = false; break; }
        }
        if (!ok) continue;
        long long s = 0;
        for (size_t k = 0; k < i; ++k) s += (long long)text[k].size() + 1;
        long long e = s;
        for (size_t k = i; k < i + n.size(); ++k) e += (long long)text[k].size() + 1;
        if (e > s) --e;
        ++count;
        if (count == 1) { start = s; end = e; }
    }
    if (count == 1) { *out_start = start; *out_end = end; return true; }
    return false;
}

int main() {
    std::string line;
    std::vector<std::string> lines;
    while (std::getline(std::cin, line)) lines.push_back(line);

    std::vector<std::string> needle, text;
    bool in_text = false;
    for (const auto& l : lines) {
        if (l == "---TEXT---" || l == "---TEXT---\r") { in_text = true; continue; }
        if (in_text) text.push_back(l);
        else needle.push_back(l);
    }
    // Drop the leading "NEEDLE" marker line if present.
    if (!needle.empty() && needle[0] == "NEEDLE") needle.erase(needle.begin());
    // Drop empty leading/trailing needle lines, matching the TS impl.
    while (!needle.empty() && needle.front().empty()) needle.erase(needle.begin());
    while (!needle.empty() && needle.back().empty()) needle.pop_back();

    if (needle.empty()) { std::cout << "NONE\n"; return 0; }
    long long s = 0, e = 0;
    if (find_unique(needle, text, &s, &e)) {
        std::cout << "OK " << s << " " << e << "\n";
    } else {
        std::cout << "NONE\n";
    }
    return 0;
}