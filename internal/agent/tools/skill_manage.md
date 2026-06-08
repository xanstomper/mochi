Create, list, and inspect agent skills. Skills are reusable procedures that teach the agent how to handle specific tasks.

Use this tool AFTER successfully completing a complex task to save the approach as a skill. Future sessions will load your skills automatically.

Actions:
  - create: Save a new skill. Requires name (kebab-case), description, and workflow (step-by-step instructions).
  - list: List all available skills (builtin + user-created).
  - inspect: Show full details of a specific skill.

Examples:
  - Create a skill: {"action": "create", "name": "setup-react-testing", "description": "Sets up React testing with Jest and React Testing Library", "workflow": "1. Install jest and @testing-library/react\n2. Configure jest.config.js\n3. Create test setup file\n4. Verify with npm test"}
  - List skills: {"action": "list"}
  - Inspect a skill: {"action": "inspect", "name": "setup-react-testing"}
