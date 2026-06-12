import WebSocket from 'ws';

const DEFAULT_BROKER_URL = 'wss://cloud-run-tunnel-broker-3ukgxkzwda-uc.a.run.app/v1/tunnel/cli';
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function cleanString(value = '', max = 512) {
  return String(value || '').trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function brokerUrl() {
  return cleanString(process.env.LUCENA_TUNNEL_BROKER_URL || DEFAULT_BROKER_URL, 2048);
}

function brokerSecret() {
  return process.env.LUCENA_TUNNEL_BROKER_SECRET || '';
}

export class BrokerTransport {
  constructor(options = {}) {
    this.url = options.url || brokerUrl();
    this.secret = options.secret ?? brokerSecret();
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.reconnecting = false;
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.reconnectAttempts = 0;
    this.hello = null;
    this.callbacks = {
      onCommand: null,
      onBrowserConnected: null,
      onBrowserDisconnected: null,
      onDisconnect: null,
      onError: null,
    };
  }

  async connect({
    tunnelId,
    cwdName,
    platform,
    pid,
    capabilities = {},
    onCommand,
    onBrowserConnected,
    onBrowserDisconnected,
    onDisconnect,
    onError,
  }) {
    this.hello = {
      type: 'hello',
      role: 'cli',
      tunnelId,
      protocolVersion: 1,
      cwdName,
      platform,
      pid,
      capabilities,
      brokerSecret: this.secret || undefined,
    };
    this.callbacks = {
      onCommand,
      onBrowserConnected,
      onBrowserDisconnected,
      onDisconnect,
      onError,
    };
    await this.openSocket();
  }

  async openSocket() {
    if (this.closed) throw new Error('Broker transport is closed.');
    const ws = new WebSocket(this.url, {
      perMessageDeflate: false,
      handshakeTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
      maxPayload: Number(process.env.LUCENA_TUNNEL_BROKER_MAX_PAYLOAD || 8 * 1024 * 1024),
    });
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Broker connection timed out after ${Math.round(DEFAULT_CONNECT_TIMEOUT_MS / 1000)}s`));
        try { ws.terminate(); } catch {}
      }, DEFAULT_CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', handleOpen);
        ws.off('message', handleMessage);
        ws.off('error', handleError);
      };

      const handleOpen = () => {
        this.send(this.hello);
      };

      const handleMessage = (raw) => {
        let envelope = null;
        try {
          envelope = JSON.parse(raw.toString('utf8'));
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (envelope.type === 'hello_ack') {
          cleanup();
          this.connected = true;
          this.reconnectAttempts = 0;
          this.heartbeatIntervalMs = Number(envelope.payload?.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
          this.attachSocketHandlers(ws);
          this.startHeartbeat();
          resolve();
          return;
        }
        if (envelope.type === 'error') {
          cleanup();
          reject(new Error(envelope.message || envelope.code || 'Broker rejected connection'));
        }
      };

      const handleError = (error) => {
        cleanup();
        reject(error);
      };

      ws.on('open', handleOpen);
      ws.on('message', handleMessage);
      ws.on('error', handleError);
    });
  }

  attachSocketHandlers(ws) {
    ws.on('message', (raw) => {
      let envelope = null;
      try {
        envelope = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        this.callbacks.onError?.(error);
        return;
      }
      this.handleEnvelope(envelope);
    });
    ws.on('close', () => this.handleClose());
    ws.on('error', (error) => {
      this.callbacks.onError?.(error);
    });
  }

  handleEnvelope(envelope = {}) {
    if (envelope.type === 'ping') {
      this.send({ type: 'pong', tunnelId: this.hello?.tunnelId });
      return;
    }
    if (envelope.type === 'command') {
      const command = {
        ...(envelope.payload || {}),
        messageId: envelope.messageId,
        clientId: envelope.clientId,
        tunnelId: envelope.tunnelId,
      };
      this.callbacks.onCommand?.(command);
      return;
    }
    if (envelope.type === 'event' && envelope.event === 'browser_connected') {
      this.callbacks.onBrowserConnected?.({
        clientId: envelope.clientId,
        ...(envelope.payload || {}),
      });
      return;
    }
    if (envelope.type === 'event' && envelope.event === 'browser_disconnected') {
      this.callbacks.onBrowserDisconnected?.({
        clientId: envelope.clientId,
        ...(envelope.payload || {}),
      });
    }
  }

  async handleClose() {
    if (this.closed) return;
    this.connected = false;
    this.stopHeartbeat();
    this.callbacks.onDisconnect?.();
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (!this.closed) {
        this.reconnectAttempts += 1;
        const delay = Math.min(30_000, 500 * 2 ** (this.reconnectAttempts - 1));
        await sleep(delay);
        if (this.closed) return;
        try {
          await this.openSocket();
          return;
        } catch (error) {
          this.callbacks.onError?.(error);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping', tunnelId: this.hello?.tunnelId });
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(envelope) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      v: 1,
      createdAt: Date.now(),
      ...envelope,
    }));
    return true;
  }

  sendPresence(payload = {}) {
    return this.send({
      type: 'presence',
      event: 'presence',
      tunnelId: this.hello?.tunnelId,
      payload,
    });
  }

  sendEvent(event, payload = {}) {
    return this.send({
      type: 'event',
      event,
      tunnelId: this.hello?.tunnelId,
      payload,
    });
  }

  sendResponse({ messageId, clientId, type, text = '', extra = {} }) {
    return this.send({
      type: 'response',
      tunnelId: this.hello?.tunnelId,
      clientId,
      messageId,
      payload: {
        type,
        text,
        ...extra,
      },
    });
  }

  async close() {
    this.closed = true;
    this.stopHeartbeat();
    if (!this.ws) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      this.ws.once('close', done);
      try {
        this.ws.close(1000, 'CLI shutting down');
      } catch {
        resolve();
      }
      setTimeout(done, 1000).unref();
    });
    this.ws = null;
    this.connected = false;
  }
}
