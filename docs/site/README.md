# Agate documentation

The chapters of Agate's documentation, one markdown file each. They are also the web app's docs pages, where links of
the form `NN-slug.md` between them become `/docs/<slug>`; on GitHub they read as they are. Rendered:
https://agate.elpabl0.xyz/docs; for agents also as `/llms.txt`, `/llms-full.txt` and `/docs/raw/<slug>.md`.
Start with the Quickstart to try it, with Connect an AI to hand it to an agent, with For agents if you are one, or
with the Developer API to build on the price. As of Oct 10 2026.

**Get started**
- [Introduction](01-introduction.md)
- [Quickstart](02-quickstart.md)
- [Connect an AI](03-connect-an-ai.md)
- [For agents](18-agents.md)

**Concepts**
- [How the price is made](04-the-price.md)
- [The monthly market](05-the-market.md)
- [Accounts and gas](06-accounts.md)
- [AI pockets and limits](07-ai-pockets.md)

**Reference**
- [Developer API](08-api.md)
- [Onchain feeds](09-onchain.md)
- [SDK](10-sdk.md)
- [MCP tools](11-mcp-tools.md)
- [Contracts and addresses](12-contracts.md)
- [Errors and fixes](17-errors.md)

**Operate**
- [Architecture](13-architecture.md)
- [Build and test](14-develop.md)

**Background**
- [Built on](15-built-on.md)
- [Limits, stated](16-limits.md)
- [Glossary](19-glossary.md)

Each file starts with frontmatter (`slug`, `title`, `description`, `group`, `order`, `source`), where `source` names
the code the page describes. Claims a judge can check line by line: [`../judge.md`](../judge.md).
