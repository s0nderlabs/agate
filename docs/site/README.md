# agate documentation

The chapters of agate's documentation, one markdown file each, written to become the web app's docs pages (being
built); there, links of the form `NN-slug.md` between them become `/docs/<slug>`. They read as they are on GitHub.
Start with the Quickstart to try it, with Connect an AI to hand it to an agent, or with the Developer API to build on
the price.

**Get started**
- [Introduction](01-introduction.md)
- [Quickstart](02-quickstart.md)
- [Connect an AI](03-connect-an-ai.md)

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

**Operate**
- [Architecture](13-architecture.md)
- [Build and test](14-develop.md)

**Background**
- [Built on](15-built-on.md)
- [Limits, stated](16-limits.md)

Each file starts with frontmatter (`slug`, `title`, `description`, `group`, `order`, `source`), where `source` names
the code the page describes. Claims a judge can check line by line: [`../judge.md`](../judge.md).
