# LucenaCoder Local Tunnel

This package is the `npx lucenacoder` alias for [`@lucenaone/coder`](https://www.npmjs.com/package/@lucenaone/coder), the official local connection agent for [LucenaCoder](https://lucenacoder.com).

Run it from a project folder when you want LucenaCoder to work with files on your machine instead of a browser-only workspace. It creates a folder-scoped realtime tunnel between your local project and LucenaCoder.

```bash
cd your-project
npx lucenacoder
```

## What This Package Does

- Installs and runs `@lucenaone/coder`.
- Connects the folder you run it from to LucenaCoder through Firebase Realtime Database.
- Reads, writes, lists, searches, and runs commands only inside that selected folder.
- Builds a local code index on your machine so LucenaCoder can understand the project faster.
- Watches for local file changes and sends file tree/index updates to connected LucenaCoder sessions.
- Prints a Tunnel ID and LucenaCoder URL so you can connect from the web app.
- If your Pro token is already saved, registers the tunnel with your LucenaCoder account for Remote Control.

That is the whole job: this package is the lightweight local worker entrypoint. The AI/model calls and Pro account checks live in LucenaCoder's cloud services.

## What Gets Sent

We want this to be boringly clear:

- The folder name, platform, process id, Tunnel ID, and tunnel status are sent so LucenaCoder can show and connect the session.
- File paths, file contents, search results, command output, and file change events are sent when a connected LucenaCoder session asks for them.
- A local code index is generated on your machine and can be sent to your connected LucenaCoder browser session to make navigation and context faster.
- For Pro Remote Control, prompts go to LucenaCoder's cloud relay, model/tool decisions happen there, and this local worker receives folder-scoped tool requests.
- Your OpenRouter key is not stored in this npm package. Pro model access is resolved by LucenaCoder cloud services from your account.

## What Does Not Happen

- This does not scan your whole computer.
- LucenaCoder file tools are scoped to the directory where you ran `npx lucenacoder`.
- This does not run a hidden background daemon after you close the terminal process.
- This does not make your local folder public. The Tunnel ID is a private connection handle; treat it like a temporary secret.

## Browser Mode, Local Tunnel, And Pro Remote Control

LucenaCoder can work in a few modes:

- Browser Mode keeps work inside the browser sandbox.
- Local Tunnel uses this package to connect LucenaCoder to the folder on your machine.
- Pro Remote Control uses the same local tunnel worker, but the relay goes through LucenaCoder cloud services so you can control the session from mobile while `npx lucenacoder` keeps running on your machine. This allows Pro users to close the desktop tab while mobile maintains access.

## Safety Model

Local AI access should not be mysterious.

- LucenaCoder file tools are folder-scoped and resolve paths inside the folder where the command was started.
- Safe Mode is the default. Mutating terminal commands are blocked until approved.
- Terminal commands run from the selected project folder. Read-only shell commands can still reference paths you explicitly ask them to, so review commands before approving broader access.
- File edits are surfaced through LucenaCoder's approval flow when approval is required.
- YOLO Mode can be enabled from the LucenaCoder interface when you intentionally want fewer interruptions.
- The local shell runner still enforces path and command checks. UI approval is not the only line of defense.

No local safety system is magic. Review prompts and approvals before allowing broad changes, dependency scripts, migrations, or commands you do not understand.

## Requirements

- Node.js 20 or newer.
- Internet access to LucenaCoder and Firebase Realtime Database.
- A LucenaCoder browser session for normal local tunnel use.
- Active Pro access for Remote Control from mobile.

## Common Flow

```bash
cd your-project
npx lucenacoder
```

Then either:

- Open the printed LucenaCoder URL, or
- Paste the Tunnel ID into LucenaCoder's Local Tunnel picker, or
- If Pro is active, open Remote Control from your LucenaCoder account and choose the connected tunnel.

To disconnect, stop the process with `Ctrl+C`.

## Package Transparency

This alias package loads `@lucenaone/coder`, which contains the local tunnel worker, local indexing code, shell safety policy, and tree-sitter grammars needed to run on your machine.
