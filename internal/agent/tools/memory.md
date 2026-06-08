Save, search, list, and delete long-term memories. Memories persist across sessions.

<usage>
- Use action=save when you discover important facts: user preferences, project conventions, environment quirks, recurring error solutions.
- Use action=search query=<term> to find relevant memories from past sessions.
- Use action=list to see top memories ranked by importance.
- The system automatically injects top memories into every new conversation.
</usage>

<actions>
- save: Store a memory. Required: key, value. Optional: category (user_pref, project, convention, fact, error, general), importance (0.0-1.0, default 0.5).
- search: Find memories. Required: query. Optional: limit.
- list: Show top memories. Optional: limit (default 10).
- delete: Remove a memory. Required: key.
</actions>
