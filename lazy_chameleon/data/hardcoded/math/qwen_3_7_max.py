"""qwen_3_7_max - math examples."""
from __future__ import annotations
from typing import Any, Dict, List

qwen_3_7_max_math_examples: List[Dict[str, Any]] = [
    {"instruction": "Solve dy/dx=2x+3y", "response": "y=-2x/3-2/9+Ce^{3x} via integrating factor.", "difficulty": 0.3},
    {"instruction": "Find lim x->0 sin(x)/x", "response": "1 via squeeze theorem.", "difficulty": 0.6},
    {"instruction": "Derivative x^3 sin(x)", "response": "3x^2 sin(x)+x^3 cos(x).", "difficulty": 0.8},
    {"instruction": "Integral x^2 e^x dx", "response": "(x^2-2x+2)e^x + C.", "difficulty": 0.5},
    {"instruction": "Eigenvalues [[2,1],[1,2]]", "response": "lambda=1,3", "difficulty": 0.2},
    {"instruction": "Prove sum 1..n=n(n+1)/2", "response": "Induction: base+step.", "difficulty": 0.5},
    {"instruction": "gcd(123,456)", "response": "gcd=3", "difficulty": 0.9},
    {"instruction": "C(10,3)", "response": "120", "difficulty": 0.6},
    {"instruction": "Prove sqrt(3) irrational", "response": "Assume reduced, contradictions with 3|a and 3|b.", "difficulty": 0.9},
    {"instruction": "Inverse of 5 mod 17", "response": "7", "difficulty": 0.8},
    {"instruction": "Sum 1+1/2+1/4+...", "response": "=2", "difficulty": 0.2},
    {"instruction": "Derivative ln(x^2+1)", "response": "2x/(x^2+1)", "difficulty": 0.7},
    {"instruction": "Area circle r=5", "response": "25pi", "difficulty": 0.7},
    {"instruction": "Solve x^2-5x+6=0", "response": "x=2,3", "difficulty": 0.6},
    {"instruction": "Sum 1^2+...+n^2", "response": "n(n+1)(2n+1)/6", "difficulty": 0.4},
    {"instruction": "T(n)=2T(n/2)+n", "response": "Theta(n log n)", "difficulty": 0.6},
    {"instruction": "Distance (1,2)-(4,6)", "response": "5", "difficulty": 0.3},
    {"instruction": "P(2 heads 5 flips)", "response": "5/16", "difficulty": 0.5},
    {"instruction": "T(n)=4T(n/2)+n^2", "response": "Theta(n^2 log n)", "difficulty": 0.5},
    {"instruction": "Volume sphere r=3", "response": "36pi", "difficulty": 0.9},
    {"instruction": "Surface area sphere r=3", "response": "36pi", "difficulty": 0.8},
    {"instruction": "15% of 200", "response": "30", "difficulty": 0.4},
    {"instruction": "Slope (1,2)-(3,8)", "response": "3", "difficulty": 0.6},
    {"instruction": "0.75 as fraction", "response": "3/4", "difficulty": 0.3},
    {"instruction": "Derivative e^(2x)", "response": "2e^(2x)", "difficulty": 0.8},
    {"instruction": "Integral cos(x) 0..pi/2", "response": "1", "difficulty": 0.8},
    {"instruction": "Area triangle b=6 h=4", "response": "12", "difficulty": 0.4},
    {"instruction": "Volume cylinder r=3 h=5", "response": "45pi", "difficulty": 0.6},
    {"instruction": "Solve 2x+5=13", "response": "x=4", "difficulty": 0.6},
    {"instruction": "Area trapezoid b1=3 b2=5 h=4", "response": "16", "difficulty": 0.3},
]
__all__ = ["qwen_3_7_max_math_examples"]
