# Contributing

This project is currently private and unlicensed for public redistribution.

## Local Checks

Run the test suite before committing:

```bash
npm test
```

Package the VS Code extension when changing extension behavior:

```bash
npm run package:vsix
```

## Development Notes

- Keep CLI output as JSON.
- Prefer small commands that operate on notebooks already open in visible VS Code notebook editors.
- Update `README.md` when adding or changing CLI commands.
