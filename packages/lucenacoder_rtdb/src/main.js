// src/main.js — CLI entry point for the Lucena agent
import { LucenaAgent } from './agent.js';
import { spawn } from 'child_process';
import { registerProTunnel, validateStoredProToken } from './pro-token.js';
import { basename } from 'path';


// Standard ANSI Terminal Colors
const c = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  reset: '\x1b[0m'
};

const BANNER = `
${c.green}⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣀⣀⣀⡀
⠀⠀⠀⠀⠀⠀⠀⠀⠉⠙⠻⢿⣿⣿⣷⣄
⠀⠀⠀⠀⠀⠀⣀⣤⣶⣶⣦⣄⠙⣿⣿⣿⣇⣠⣶⣾⣿⣷⣶⣶⠄
⠀⠀⠀⠀⣠⣾⣿⣿⣿⣿⣿⣿⣷⣼⣿⣿⣿⣿⣿⣿⣿⠟⠋
⠀⠀⠀⠘⠛⠉⠉⠉⠁⠉⠉⠛⢿⣿⣿⣿⣿⣿⣿⣷⣶⣶⣤⣀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⣿⠿⠛⢿⣿⣿⣿⣿⣟⠛⠻⢿⣷⣦⡀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⡿⠁⠀⠀⢸⣿⣿⡿⠻⣿⣷⡀⠀⠉⠻⢷
⠀⠀⠀⠀⠀⠀⠀⠀⢠⣿⡿⠁⠀⠀⠀⠸⣿⡿⠁⠀⠈⢿⣇${c.reset}
${c.dim}⠀⠀⠀⠀⠀⠀⠀⢠⣿⣿⠁${c.reset}${c.green}⠀⠀⠀⠀⠀⠉⠀⠀⠀⠀⠀⠏${c.reset}
${c.dim}⠀⠀⠀⠀⠀⠀⢠⣿⣿⠇${c.reset}       ${c.bold}L U C E N A${c.reset}
${c.dim}⠀⠀⠀⠀⠀⢀⣾⣿⡟${c.reset}        ${c.bold} C O D E R${c.reset}
${c.dim}⠀⠀⠀⠀⠀⣼⣿⣿⠃${c.reset}        ${c.cyan}${c.bold} L O C A L${c.reset}
${c.dim}⠀⠀⠀⠀⢠⣿⣿⡟${c.reset}         ${c.cyan}${c.bold}T U N N E L${c.reset}
${c.dim}⠀⠀⠀⠀⣼⣿⣿⠃${c.reset}
${c.dim}⠀⠀⠀⠀⠈⠛⠉${c.reset}

${c.dim}  =========================================${c.reset}
  Connect your LucenaCoder.com session
  to your local folders.
`;

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function main() {
  const cwd = process.cwd();
  const proStatus = await validateStoredProToken();
  let activeTunnelId = null;

  console.log(BANNER);
  console.log(`  ${c.cyan}📍 Scoped to:${c.reset} ${cwd}`);
  console.log(`  ${c.yellow}🛡️  Safe Mode:${c.reset} ON by default (All edits require approval)`);
  console.log(`               ${c.dim}Optionally switch to YOLO on LucenaCoder.com${c.reset}\n`);
  if (proStatus.valid) {
    console.log(`  ${c.cyan}PRO detected.${c.reset} Browser auto-launch enabled.\n`);
  }

  const agent = new LucenaAgent(cwd, {
    proToken: proStatus.valid ? proStatus.stored?.tokenForPro : null,
  });

  const shutdown = async () => {
    console.log(`\n  ${c.dim}Shutting down tunnel...${c.reset}`);
    if (proStatus.valid && activeTunnelId) {
      await registerProTunnel({
        tokenForPro: proStatus.stored?.tokenForPro,
        tunnelId: activeTunnelId,
        cwdName: basename(cwd),
        platform: process.platform,
        pid: process.pid,
        status: 'disconnected',
        online: false,
      });
    }
    await agent.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    const tunnelId = await agent.start();
    activeTunnelId = tunnelId;
    if (proStatus.valid) {
      const registered = await registerProTunnel({
        tokenForPro: proStatus.stored?.tokenForPro,
        tunnelId,
        cwdName: basename(cwd),
        platform: process.platform,
        pid: process.pid,
      });
      if (registered.ok) {
        agent.setRemoteControlRegistrationNotice(`  ${c.cyan}RemoteControl registered.${c.reset} This run is visible on lucenacoder.com/rc.`);
      } else {
        agent.setRemoteControlRegistrationNotice(`  ${c.yellow}RemoteControl registration failed.${c.reset} ${registered.error || 'Run will not appear in the remote list.'}`);
      }
    }
    console.log(`  ${c.green}✔ Tunnel active!${c.reset}\n`);
    
    const idLabel = "Tunnel ID:";
    const boxWidth = idLabel.length + tunnelId.length + 5;
    const border = '─'.repeat(boxWidth);
    
    console.log(`  ${c.dim}┌${border}┐${c.reset}`);
    console.log(`  ${c.dim}│${c.reset}  ${idLabel}${c.reset} ${c.bold}${tunnelId}${c.reset}  ${c.dim}│${c.reset}`);
    console.log(`  ${c.dim}└${border}┘${c.reset}`);

    const webUrl = `https://lucenacoder.com/?tunnel=${tunnelId}`;
    
    const urlLabel = "URL:";
    const urlBoxWidth = urlLabel.length + webUrl.length + 5;
    const urlBorder = '─'.repeat(urlBoxWidth);
    
    console.log(`\n  ${c.dim}┌${urlBorder}┐${c.reset}`);
    console.log(`  ${c.dim}│${c.reset}  ${urlLabel}${c.reset} ${c.bold}${webUrl}${c.reset}  ${c.dim}│${c.reset}`);
    console.log(`  ${c.dim}└${urlBorder}┘${c.reset}`);

    if (proStatus.valid) {
      try {
        openBrowser(webUrl);
        console.log(`\n  ${c.green}✔ Opening LucenaCoder...${c.reset}`);
      } catch {
        console.log(`\n  ${c.yellow}Could not auto-open your browser.${c.reset}`);
      }
    }

    if (!proStatus.valid) {
      console.log(`\n  ${c.dim}Open the URL above in your browser to connect.${c.reset}`);
    }
    console.log(`  ${c.dim}Press Ctrl+C to disconnect${c.reset}\n`);
  } catch (err) {
    console.error(`\n  ${c.yellow}✖ Failed to start tunnel: ${err.message}${c.reset}\n`);
    process.exit(1);
  }
}
