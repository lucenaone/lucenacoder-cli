# LucenaCoder Local Tunnel

The official local connection agent for [LucenaCoder](https://lucenacoder.com).

Run it from a project folder when you want LucenaCoder to work with the files on your machine. The CLI creates a folder-scoped WebSocket tunnel between your local project and LucenaCoder, then waits for requests from your connected browser or Remote Control session.

```bash
cd your-project
npx lucenacoder
```

## What It Does

- Connects the current folder to LucenaCoder through the LucenaCoder tunnel broker.
- Lets connected LucenaCoder sessions read, write, list, search, and inspect files in that folder.
- Runs terminal commands from that folder, with Safe Mode approval checks on by default.
- Builds local project indexes so LucenaCoder can navigate the codebase faster.
- Watches for local file changes and sends updates to connected sessions.
- Prints a Tunnel ID and URL you can use to connect from LucenaCoder.
- If a Pro token is saved, registers the tunnel for Remote Control.

That is the core job of this package: it is the lightweight local worker. Model calls, account checks, and Pro Remote Control coordination live in LucenaCoder's cloud services.

## How It Works

When the CLI starts, it indexes the project locally, opens a secure WebSocket connection to LucenaCoder's tunnel broker, and announces the tunnel with a temporary Tunnel ID. A LucenaCoder browser or Remote Control session can then connect to that tunnel and ask the local worker to perform folder-scoped actions.

The tunnel is live only while the terminal process is running. Stop it with `Ctrl+C`.

## What Gets Sent

LucenaCoder needs enough information to show and operate the tunnel:

- Basic session metadata such as folder name, platform, process id, Tunnel ID, status, and connection heartbeat.
- Project structure and local index data used for navigation and context.
- File paths, file contents, search results, file change events, and command output when a connected session asks for them.
- For Pro Remote Control, the local worker receives tool requests through LucenaCoder's relay while model decisions happen in LucenaCoder cloud services.

Your OpenRouter key is not stored in this npm package. Pro model access is resolved by LucenaCoder cloud services from your account.

## Safety Model

Local access should be powerful, but not mysterious.

- File operations are scoped to the folder where you started `npx lucenacoder`.
- The worker honors internal ignores, common build/cache folders, and your `.gitignore`.
- Safe Mode is on by default. Mutating terminal commands require approval.
- YOLO Mode can be enabled from LucenaCoder when you intentionally want fewer interruptions.
- The local shell runner still checks commands and paths. UI approval is not the only line of defense.
- Read-only terminal commands may reference explicit paths you ask for, so review commands before approving broader access.

No local safety system is magic. Review prompts and approvals before allowing broad changes, dependency scripts, migrations, deploys, or commands you do not understand.

## Modes

LucenaCoder can work in a few ways:

- Browser Mode keeps work inside the browser sandbox.
- Local Tunnel uses this package to connect LucenaCoder to a folder on your machine.
- Pro Remote Control uses the same local tunnel worker, plus LucenaCoder cloud services, so you can control a running local session from another device.

## Requirements

- Node.js 20 or newer.
- Internet access to LucenaCoder and the LucenaCoder tunnel broker.
- A LucenaCoder browser session for normal Local Tunnel use.
- Active Pro access for Remote Control.

## Common Flow

```bash
cd your-project
npx lucenacoder
```

Then either:

- Open the printed LucenaCoder URL.
- Paste the Tunnel ID into LucenaCoder's Local Tunnel picker.
- If Pro is active, open Remote Control from your LucenaCoder account and choose the connected tunnel.

To disconnect, stop the process with `Ctrl+C`.

## Package Transparency

This npm package contains the local tunnel worker, local indexing code, shell safety policy, terminal runner, Workspace Brain and Workspace Kitchen local storage helpers, and tree-sitter grammars needed to run on your machine.

The public `lucenacoder` package is a convenience alias for `@lucenaone/coder`.
