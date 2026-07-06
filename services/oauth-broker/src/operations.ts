// Logical operation dispatch. Agents request operations ("github.list_issues"),
// never raw HTTP with a token. The broker injects the token here. A "mock.echo"
// operation makes the proxy path testable without network or real tokens.

export async function dispatch(
  operation: string,
  ctx: { token: string; params: Record<string, unknown> },
): Promise<unknown> {
  switch (operation) {
    case "mock.echo":
      return { echoed: ctx.params };

    case "github.get_user": {
      const res = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${ctx.token}`, "user-agent": "agent-cc" },
      });
      if (!res.ok) throw new Error(`github ${res.status}`);
      return res.json();
    }

    case "github.list_issues": {
      const owner = String(ctx.params.owner ?? "");
      const repo = String(ctx.params.repo ?? "");
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        headers: { authorization: `Bearer ${ctx.token}`, "user-agent": "agent-cc" },
      });
      if (!res.ok) throw new Error(`github ${res.status}`);
      return res.json();
    }

    case "slack.post_message": {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: ctx.params.channel, text: ctx.params.text }),
      });
      if (!res.ok) throw new Error(`slack ${res.status}`);
      return res.json();
    }

    default:
      throw new Error(`unknown operation ${operation}`);
  }
}
