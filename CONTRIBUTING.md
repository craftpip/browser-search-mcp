# Contributing

Thanks for contributing to Browser Search MCP.

## Before you start

- Read the `README.md` first
- Open an issue before large feature work if you want feedback on direction
- Keep changes focused and easy to review

## Local setup

### Docker-first setup

```bash
cp .env.example .env
docker compose up --build -d
```

### Local Node.js setup

```bash
npm install
npm start
```

## Verification

For changes that affect HTTP MCP behavior or packaging:

```bash
curl -s http://127.0.0.1:3000/health
```

For MCP integration checks:

```bash
npm run test:mcporter
```

## Pull requests

- Keep pull requests scoped to one problem when possible
- Update docs when behavior or setup changes
- Include reproduction and verification steps in the PR description
- Avoid unrelated formatting churn

## Reporting bugs

Please include:

- what you expected
- what happened instead
- logs or error output
- setup details such as Docker vs local Node, OS, and relevant environment settings

## Security issues

Please do not open public issues for suspected security vulnerabilities.

See `SECURITY.md` for responsible disclosure guidance.
