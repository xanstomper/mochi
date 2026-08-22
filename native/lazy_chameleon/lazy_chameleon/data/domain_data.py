"""Real domain-specific task banks — Actual problems from competition math, system design interviews, coding challenges, and science.
Every task is a real, verifiable problem statement from the field.
Organized by domain for data generation and curriculum building.
"""
from __future__ import annotations
from typing import Dict, List

MATH_TASKS: List[str] = [
    "Find all integer solutions to x^3 + y^3 = 1729 where x < y.",
    "Prove that sqrt(2) is irrational using proof by contradiction.",
    "Compute the integral of x^2 * sin(x) from 0 to pi.",
    "How many ways can 8 queens be placed on a chessboard without attacking each other?",
    "Find the 100th Fibonacci number modulo 1000000007.",
    "Prove that for any positive integer n, n^3 - n is divisible by 6.",
    "Find the eigenvalues of the matrix [[2,1],[1,2]] and their corresponding eigenvectors.",
    "Solve the recurrence relation T(n) = 2T(n/2) + n log n using the Master Theorem.",
    "Find the sum of the infinite series: 1 + 1/2 + 1/4 + 1/8 + ...",
    "Derive the quadratic formula by completing the square.",
    "Prove the AM-GM inequality for n positive real numbers.",
    "Compute the inverse of the matrix [[3,1],[5,2]] using Gaussian elimination.",
    "Find the probability of getting exactly 6 heads in 10 fair coin flips.",
    "Use the Euclidean algorithm to find gcd(12345, 67890).",
    "Find the limit: lim(x->0) (sin x - x)/x^3",
    "A fair coin is tossed until 3 consecutive heads appear. Find the expected number of tosses.",
    "Find all primes p such that p^2 + 2 is also prime.",
    "Prove that there are infinitely many prime numbers.",
    "Find all Pythagorean triples with hypotenuse less than 30.",
    "Solve the system: 2x + 3y = 7, 4x - y = 1.",
    "Find the derivative of f(x) = ln(x^2 + 1) using the chain rule.",
    "Compute the area of a circle with radius 5 using integration.",
    "Find the volume of a sphere of radius 3.",
    "Prove that the sum of the first n odd numbers equals n^2.",
    "Find the angle between the hour and minute hands at 3:15.",
    "How many total squares are there on a standard 8x8 chessboard?",
    "Find the inverse of 5 modulo 17 using the extended Euclidean algorithm.",
    "Solve the quadratic congruence x^2 \u2261 4 (mod 15).",
    "Find the sum of the first 100 positive integers.",
    "What is the expected number of coin flips to get heads?",
]

CODE_TASKS: List[str] = [
    "Implement a thread-safe LRU cache with O(1) get and put operations.",
    "Write a function to find the longest palindromic substring in O(n^2) time.",
    "Implement a Trie with insert, search, and startsWith methods.",
    "Write an async function to fetch multiple URLs concurrently with rate limiting.",
    "Implement the KMP string matching algorithm for pattern searching.",
    "Build a segment tree that supports range sum queries and point updates.",
    "Implement merge sort on a singly linked list.",
    "Write a Python class for a thread-safe blocking queue.",
    "Implement a Bloom filter with configurable false positive rate.",
    "Create a simple HTTP server with routing and middleware support.",
    "Write a function that serializes and deserializes a binary tree.",
    "Implement a concurrent web crawler with depth limiting.",
    "Build a pub-sub message broker with topic-based subscriptions.",
    "Implement Dijkstra's shortest path algorithm using a priority queue.",
    "Write a JSON parser using recursive descent parsing.",
    "Implement a rate limiter using the token bucket algorithm.",
    "Build a circuit breaker pattern implementation for external API calls.",
    "Write a function to compute the Levenshtein distance between two strings.",
    "Implement a suffix array construction algorithm.",
    "Create a simple REPL for a Lisp-like language.",
    "Implement the Fisher-Yates shuffle algorithm and prove uniformity.",
    "Write a Python class for a binary indexed tree (Fenwick tree).",
    "Implement a concurrent hash map with striped locking.",
    "Build a simple key-value store with write-ahead logging.",
    "Implement the A* pathfinding algorithm for grid-based navigation.",
    "Write a Go program that implements a concurrent worker pool.",
    "Create a Rust function that safely parses CSV data with error handling.",
    "Implement a topological sort using Kahn's algorithm.",
    "Write a Python generator that yields prime numbers indefinitely.",
    "Implement a simple neural network from scratch with backpropagation.",
]

REASONING_TASKS: List[str] = [
    "If all A are B and some B are C, can we conclude some A are C? Explain.",
    "You have 12 coins, one is counterfeit (heavier or lighter). Find it in 3 weighings.",
    "Three people check into a hotel room costing $30. Each pays $10. Later the clerk realizes the room costs $25 and sends $5 with the bellboy. The bellboy keeps $2 and gives $1 back to each person. Now each paid $9 totaling $27, plus the $2 the bellboy kept = $29. Where is the missing dollar?",
    "A bat and a ball cost $1.10. The bat costs $1.00 more than the ball. How much does the ball cost?",
    "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets?",
    "You have a 3-gallon jug and a 5-gallon jug. How do you measure exactly 4 gallons?",
    "A farmer needs to cross a river with a wolf, goat, and cabbage. The boat can carry only the farmer and one item. If left alone, the wolf eats the goat and the goat eats the cabbage. How does the farmer get everything across?",
    "Five people need to cross a bridge at night. They have one torch and at most two can cross at a time. Their crossing times are 1, 2, 5, and 10 minutes. What is the minimum total time for all to cross?",
    "You are in a room with three light switches, each controlling one of three incandescent bulbs in another room. You can only enter the other room once. How do you determine which switch controls which bulb?",
    "How many times do the hour and minute hands of a clock overlap in a 24-hour period?",
    "A man is looking at a photograph. He says: 'Brothers and sisters have I none, but that man's father is my father's son.' Who is in the photograph?",
    "You have two ropes that each burn for exactly 1 hour, but they burn unevenly. How do you measure exactly 45 minutes?",
    "If a hen and a half lays an egg and a half in a day and a half, how many eggs does one hen lay in one day?",
    "You have 9 balls, one is slightly heavier than the rest. Using a balance scale only twice, find the heavier ball.",
    "How many squares are there on a chessboard? (Not just the 1x1 squares, but all sizes)",
    "If you're in a race and you overtake the person in second place, what position are you in?",
    "What is the next number in the sequence: 2, 6, 18, 54, ?",
    "What is the next letter in the sequence: O, T, T, F, F, S, S, ?",
    "If a doctor gives you 4 pills and tells you to take one every 30 minutes, how long will they last?",
    "A bathtub has two taps. One fills it in 10 minutes, the other in 15 minutes. The drain empties it in 12 minutes. If both taps are on and the drain is open, how long to fill the tub?",
]

SCIENCE_TASKS: List[str] = [
    "Explain the mechanism of CRISPR-Cas9 gene editing, including the role of guide RNA and the PAM sequence.",
    "Derive the time-independent Schrodinger equation from first principles.",
    "Explain why increasing pressure increases the boiling point of a liquid using thermodynamic principles.",
    "Describe how mRNA vaccines work, from mRNA synthesis to antibody production.",
    "Explain how transformer attention mechanisms differ from RNNs for long sequences.",
    "Describe the process of cellular respiration, including glycolysis, the Krebs cycle, and oxidative phosphorylation.",
    "Explain the photoelectric effect and how it led to the development of quantum mechanics.",
    "How does natural selection drive evolution? Provide specific examples.",
    "Explain the greenhouse effect and its role in climate change. Include the major greenhouse gases.",
    "Describe the double-slit experiment and what it reveals about wave-particle duality.",
    "How do lithium-ion batteries store and release energy? Explain the electrochemical process.",
    "Describe the water cycle and explain how human activities are affecting it.",
    "Explain the theory of plate tectonics and how it explains earthquakes and volcanic activity.",
    "How does DNA replication ensure genetic fidelity during cell division?",
    "Explain Einstein's theory of special relativity and its implications for time and space.",
    "Describe the process of photosynthesis, including the light-dependent and light-independent reactions.",
    "Explain the second law of thermodynamics and the concept of entropy.",
    "How do antibiotics work against bacteria, and why is antibiotic resistance a growing problem?",
    "Describe the structure of an atom and how the Bohr model explains atomic spectra.",
    "Explain the difference between nuclear fission and nuclear fusion, with examples of each.",
]

DESIGN_TASKS: List[str] = [
    "Design a real-time chat application that supports 10 million concurrent users.",
    "Design a content delivery network (CDN) for serving static assets globally.",
    "Design a distributed key-value store with high availability and partition tolerance.",
    "Design a real-time recommendation system for an e-commerce platform.",
    "Design a cloud file storage and synchronization service like Dropbox.",
    "Design a real-time leaderboard for an online game with 100 million players.",
    "Design a push notification service that handles 100 million notifications per day.",
    "Design a distributed web crawler that can crawl billions of pages.",
    "Design a real-time analytics pipeline for processing millions of events per second.",
    "Design an API rate limiter for a multi-tenant SaaS platform.",
]

SECURITY_TASKS: List[str] = [
    "Explain how to prevent cross-site scripting (XSS) attacks in a web application.",
    "Describe the OAuth 2.0 authorization code flow step by step.",
    "How does the TLS/SSL handshake work to establish an encrypted connection?",
    "What are SQL injection attacks and how can they be prevented?",
    "Explain cross-site request forgery (CSRF) and how to defend against it.",
    "Describe the zero-trust security model and its key principles.",
    "How does public-key cryptography work? Explain RSA encryption and digital signatures.",
    "Explain the principle of least privilege and how to implement it.",
    "What is defense in depth? Describe multiple security layers.",
    "Describe best practices for secure session management in web applications.",
]

GENERAL_TASKS: List[str] = [
    "Write a one-page business plan for a SaaS startup targeting SMBs.",
    "Explain RESTful API design principles with examples.",
    "Compare and contrast Agile and Waterfall software development methodologies.",
    "What are the trade-offs between microservices and monolithic architectures?",
    "Explain the differences between SQL and NoSQL databases with use cases.",
    "What is time complexity? Provide a cheat sheet for common data structures.",
    "Describe different caching strategies and when to use each.",
    "Explain the testing pyramid and best practices for each level.",
    "Describe a recommended Git workflow for a team of 10 developers.",
    "Outline an incident response process for a production outage.",
]

ALL_TASKS: Dict[str, List[str]] = {
    "math": MATH_TASKS,
    "code": CODE_TASKS,
    "reasoning": REASONING_TASKS,
    "science": SCIENCE_TASKS,
    "design": DESIGN_TASKS,
    "security": SECURITY_TASKS,
    "general": GENERAL_TASKS,
}

def get_tasks(domain: str = None) -> List[str]:
    if domain:
        return ALL_TASKS.get(domain, [])
    result = []
    for v in ALL_TASKS.values():
        result.extend(v)
    return result
