"""grok_4_4 - reasoning examples."""
from __future__ import annotations
from typing import Any, Dict, List

grok_4_4_reasoning_examples: List[Dict[str, Any]] = [
    {"instruction": "6 people paint in 8h, how long for 4?", "response": "12h. 6*8/4=12", "difficulty": 0.7},
    {"instruction": "3 and 5 gal jug, measure 4", "response": "Fill5->pour3,empty3,pour2,fill5->pour3", "difficulty": 0.5},
    {"instruction": "12 coins, one heavier, 3 weighings", "response": "4v4 then 1v1", "difficulty": 0.7},
    {"instruction": "Bat+ball $1.10, bat $1 more, ball?", "response": "x+(x+1)=1.10, x=0.05", "difficulty": 0.8},
    {"instruction": "3 pills every 30min, how long?", "response": "1 hour: 0,30,60", "difficulty": 0.8},
    {"instruction": "Next: 2,6,18,54,?", "response": "162, x3 each", "difficulty": 0.6},
    {"instruction": "Next: O,T,T,F,F,S,S,?", "response": "E (eight)", "difficulty": 0.7},
    {"instruction": "Months with 28 days?", "response": "All 12", "difficulty": 0.9},
    {"instruction": "Clock overlaps in 24h?", "response": "22 times", "difficulty": 0.5},
    {"instruction": "Measure 45min with 2 ropes", "response": "Both ends rope1+one rope2, 30min done, light rope2 other", "difficulty": 0.6},
    {"instruction": "Pass 2nd place, your position?", "response": "2nd", "difficulty": 0.7},
    {"instruction": "Angle at 3:15", "response": "7.5 degrees", "difficulty": 0.8},
    {"instruction": "Golf balls in bus?", "response": "~1M", "difficulty": 0.8},
    {"instruction": "Why round manholes?", "response": "Cant fall through", "difficulty": 0.2},
    {"instruction": "Bridge 1,2,5,10min", "response": "17min total", "difficulty": 0.3},
    {"instruction": "Squares on chessboard?", "response": "204", "difficulty": 0.4},
    {"instruction": "3 switches, 1 bulb", "response": "Sw1 on, wait, off+sw2", "difficulty": 0.7},
    {"instruction": "Hen+egg rate", "response": "1 hen lays 1/day", "difficulty": 0.6},
    {"instruction": "100 prisoners light bulb", "response": "Designated counter", "difficulty": 0.4},
    {"instruction": "12 coins heavy/light 3 weighings", "response": "3 groups of 4", "difficulty": 0.3},
]
__all__ = ["grok_4_4_reasoning_examples"]
