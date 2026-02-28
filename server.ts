import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from 'discord.js-selfbot-v13';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import * as davey from '@snazzah/davey';
import { WebSocketServer, WebSocket } from 'ws';

import { createServer } from 'http';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Logger Helper ---
const logger = {
  format: (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  },
  info: (message: string) => console.log(logger.format('INFO', message)),
  warn: (message: string) => console.warn(logger.format('WARN', message)),
  error: (message: string, err?: any) => {
    console.error(logger.format('ERROR', message), err || '');
  },
  debug: (message: string) => {
    if (process.env.DEBUG) console.log(logger.format('DEBUG', message));
  }
};

// --- Types & Interfaces ---
interface UserConfig {
  user_id: number;
  token: string;
  channel_id: string;
  status: 'idle' | 'joining' | 'connected';
  webhook_url?: string;
  webhook_enabled?: boolean;
}

interface User {
  id: number;
  username: string;
  password: string;
}

// --- In-Memory Store ---
const store = {
  users: [{ 
    id: 1, 
    username: "admin", 
    password: bcrypt.hashSync("admin123", 10) 
  }] as User[],
  configs: [] as UserConfig[]
};

// --- State Management ---
class DiscordManager {
  private clients = new Map<number, Client>();
  private wsClients = new Map<number, WebSocket>();

  constructor() {}

  setWS(userId: number, ws: WebSocket) {
    this.wsClients.set(userId, ws);
  }

  removeWS(userId: number) {
    this.wsClients.delete(userId);
  }

  notify(userId: number, data: any) {
    const ws = this.wsClients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  async getClient(userId: number, token: string): Promise<Client> {
    let client = this.clients.get(userId);
    const config = store.configs.find(c => c.user_id === userId);

    if (!client) {
      client = new Client({ patchVoice: true } as any);
      
      client.on('ready', () => {
        logger.info(`[Discord] Client Ready: ${client?.user?.tag}`);
        this.notify(userId, { type: 'STATUS', status: config?.status || 'idle', tag: client?.user?.tag });
      });

      client.on('error', (err) => {
        logger.error(`[Discord] Client Error (${userId})`, err);
        this.notify(userId, { type: 'ERROR', message: err.message });
      });

      try {
        await client.login(token);
        this.clients.set(userId, client);
      } catch (err: any) {
        throw new Error(`Discord login failed: ${err.message}`);
      }
    }
    return client;
  }

  destroyClient(userId: number) {
    const client = this.clients.get(userId);
    if (client) {
      client.destroy();
      this.clients.delete(userId);
    }
  }
}

const discordManager = new DiscordManager();

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}`, reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', err);
});

// --- Helper Functions ---
async function sendWebhookNotification(config: UserConfig, message: string, color: number = 5814783) {
  if (!config.webhook_enabled || !config.webhook_url) return;
  try {
    await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: "Ellent Manager | Voice Log",
          description: message,
          color: color,
          timestamp: new Date().toISOString(),
          footer: { text: "Ellent Infrastructure Monitoring" }
        }]
      })
    });
  } catch (e) {
    logger.error(`[Webhook] Failed to send notification for user ${config.user_id}`, e);
  }
}

// --- Server Initialization ---
async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(express.json());

    // WebSocket Connection Handling
    wss.on('connection', (ws) => {
      let userId: number | null = null;
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'AUTH') {
            userId = data.userId;
            if (userId) discordManager.setWS(userId, ws);
            logger.info(`[WS] Client authenticated: ${userId}`);
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        if (userId) discordManager.removeWS(userId);
      });
    });

  // Auth API
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = store.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    if (user && bcrypt.compareSync(password, user.password)) {
      return res.json({ success: true, user: { id: user.id, username: user.username } });
    }
    
    res.status(401).json({ success: false, message: "Invalid credentials" });
  });

  // Config API
  app.get("/api/config/:userId", (req, res) => {
    const userId = parseInt(req.params.userId);
    const config = store.configs.find(c => c.user_id === userId);
    if (config) {
      // Return masked token to frontend
      res.json({ ...config, token: config.token ? "********" : "" });
    } else {
      res.json({ token: "", channel_id: "", status: "idle", webhook_url: "", webhook_enabled: false });
    }
  });

  app.post("/api/test-webhook", async (req, res) => {
    const { userId } = req.body;
    const config = store.configs.find(c => c.user_id === userId);
    if (!config || !config.webhook_url) return res.status(400).json({ error: "Webhook not configured" });

    try {
      await sendWebhookNotification(config, "🔔 **Test Notification**: Webhook integration is active and working correctly.", 3447003);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/config", (req, res) => {
    const { userId, token, channelId, webhookUrl, webhookEnabled } = req.body;
    const index = store.configs.findIndex(c => c.user_id === userId);
    
    let finalToken = token;
    // If token is the mask, use the existing token from store
    if (index !== -1 && token === "********") {
      finalToken = store.configs[index].token;
    }
    
    const newConfig: UserConfig = { 
      user_id: userId, 
      token: finalToken, 
      channel_id: channelId, 
      status: "idle" as const,
      webhook_url: webhookUrl,
      webhook_enabled: webhookEnabled
    };
    if (index !== -1) {
      // If token changed and it's not the mask, destroy old client
      if (store.configs[index].token !== finalToken) {
        discordManager.destroyClient(userId);
      }
      store.configs[index] = { ...store.configs[index], ...newConfig };
    } else {
      store.configs.push(newConfig);
    }
    
    res.json({ success: true });
  });

  // Token Validation API
  app.post("/api/validate-token", async (req, res) => {
    let { token, userId } = req.body;
    
    // If token is masked, try to find the real token in store
    if (token === "********" && userId) {
      const config = store.configs.find(c => c.user_id === userId);
      if (config) token = config.token;
    }

    if (!token || token === "********") return res.status(400).json({ valid: false, message: "Token is required" });

    const tempClient = new Client({ checkUpdate: false } as any);
    try {
      await tempClient.login(token);
      const userInfo = {
        id: tempClient.user?.id,
        username: tempClient.user?.username,
        tag: tempClient.user?.tag,
        avatar: tempClient.user?.displayAvatarURL(),
        createdAt: tempClient.user?.createdAt,
      };
      tempClient.destroy();
      res.json({ valid: true, user: userInfo });
    } catch (err: any) {
      res.json({ valid: false, message: err.message });
    }
  });

  // Fetch Guilds
  app.get("/api/guilds/:userId", async (req, res) => {
    const userId = parseInt(req.params.userId);
    const config = store.configs.find(c => c.user_id === userId);
    if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

    try {
      const client = await discordManager.getClient(userId, config.token);
      const guilds = client.guilds.cache.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL()
      }));
      res.json(guilds);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch Voice Channels
  app.get("/api/channels/:guildId/:userId", async (req, res) => {
    const { guildId } = req.params;
    const userId = parseInt(req.params.userId);
    const config = store.configs.find(c => c.user_id === userId);
    if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

    try {
      const client = await discordManager.getClient(userId, config.token);
      const guild = await client.guilds.fetch(guildId);
      const channels = guild.channels.cache
        .filter(c => c.type === 'GUILD_VOICE')
        .map(c => ({
          id: c.id,
          name: c.name
        }));
      res.json(channels);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Join Voice
  app.post("/api/join", async (req, res) => {
    const { userId, channelId } = req.body;
    const config = store.configs.find(c => c.user_id === userId);
    if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

    try {
      const client = await discordManager.getClient(userId, config.token);
      const channel = await client.channels.fetch(channelId);
      
      if (!channel || channel.type !== 'GUILD_VOICE') {
        throw new Error("Invalid voice channel");
      }

      // Cleanup existing connection in same guild
      const existing = getVoiceConnection(channel.guild.id);
      if (existing) existing.destroy();

      config.status = 'joining';
      config.channel_id = channelId;
      discordManager.notify(userId, { type: 'STATUS', status: 'joining', channelId });

      // Step 1: Voice State Update (Handled by joinVoiceChannel)
      logger.info(`[Voice] Sending Voice State Update for channel ${channelId}`);
      
      // Manual event tracking for diagnostics
      const rawListener = (packet: any) => {
        if (packet.t === 'VOICE_SERVER_UPDATE' && packet.d.guild_id === channel.guild.id) {
          logger.debug(`[Voice] VOICE_SERVER_UPDATE received for user ${userId}`);
        }
        if (packet.t === 'VOICE_STATE_UPDATE' && packet.d.guild_id === channel.guild.id && packet.d.user_id === client.user?.id) {
          logger.debug(`[Voice] VOICE_STATE_UPDATE received for user ${userId}. Session ID: ${packet.d.session_id}`);
        }
      };
      client.on('raw', rawListener);

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator as any,
        selfDeaf: false,
        selfMute: true,
        // group: client.user?.id // Omitting group to see if it helps with default adapter behavior
      });

      // Add debug logging
      connection.on('debug', (message) => {
        logger.debug(`[Voice] User ${userId}: ${message}`);
      });

      // Timeout logic: if not connected in 30s, reset
      let retryCount = 0;
      const maxRetries = 3;

      const connectionTimeout = setTimeout(() => {
        if (config.status === 'joining' || connection.state.status !== VoiceConnectionStatus.Ready) {
          logger.error(`[Voice] Timeout reached for user ${userId}. Current state: ${connection.state.status}`);
          
          if (connection.state.status === VoiceConnectionStatus.Connecting || connection.state.status === VoiceConnectionStatus.Signalling) {
             logger.warn(`[Voice] Stuck in ${connection.state.status}. UDP traffic is likely blocked or server is unreachable.`);
             discordManager.notify(userId, { type: 'ERROR', message: 'Voice connection stuck. This might be due to UDP blocking or a temporary Discord issue (521).' });
          }
          
          connection.destroy();
          config.status = 'idle';
          discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
        }
      }, 30000);

      connection.on('stateChange', (oldState, newState) => {
        logger.info(`[Voice] User ${userId} state changed: ${oldState.status} -> ${newState.status}`);
        
        if (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling) {
          logger.info(`[Voice] User ${userId} is ${newState.status}...`);
          config.status = 'joining';
          discordManager.notify(userId, { type: 'STATUS', status: 'joining', channelId });
        }
        
        if (newState.status === VoiceConnectionStatus.Ready) {
          clearTimeout(connectionTimeout);
          logger.info("[Voice] Identify/Ready received & UDP Connection established");
          config.status = 'connected';
          discordManager.notify(userId, { type: 'STATUS', status: 'connected', channelId });
          
          sendWebhookNotification(config, `✅ **Connected** to voice channel: \`${channel.name}\` (\`${channel.id}\`) in guild: \`${channel.guild.name}\``, 3066993);

          // Optional: Set speaking state to "stay active" if desired
          // This helps some servers recognize the bot as "active"
          connection.setSpeaking(true);
          setTimeout(() => connection.setSpeaking(false), 1000);
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          logger.warn(`[Voice] User ${userId} disconnected. Reason: ${newState.reason}`);
          sendWebhookNotification(config, `⚠️ **Disconnected** from voice channel. Reason code: \`${newState.reason}\`.`, 15105570);
          // If disconnected unexpectedly, try to reconnect a few times
          if (newState.reason === 0 && retryCount < maxRetries) { 
             retryCount++;
             logger.info(`[Voice] Attempting to reconnect user ${userId} (Retry ${retryCount}/${maxRetries})...`);
          } else {
            clearTimeout(connectionTimeout);
            config.status = 'idle';
            discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
            client.off('raw', rawListener);
          }
        }

        if (newState.status === VoiceConnectionStatus.Destroyed) {
          clearTimeout(connectionTimeout);
          config.status = 'idle';
          discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
          client.off('raw', rawListener);
        }
      });

      connection.on('error', (err) => {
        logger.error(`[Voice] Error for user ${userId}`, err);
        sendWebhookNotification(config, `❌ **Voice Connection Error**: \`${err.message}\`.`, 15158332);
        
        // Handle specific "Unexpected server response: 521"
        if (err.message.includes('521')) {
          logger.warn(`[Voice] Discord Voice Server is returning 521 (Down).`);
        }

        // Handle specific "IP discovery" error
        if (err.message.includes('IP discovery')) {
          logger.error(`[Voice] Critical: UDP/IP Discovery failed. UDP traffic likely blocked.`);
        }

        // Only destroy and reset if we've exhausted retries or it's a fatal error
        if (retryCount >= maxRetries || err.message.includes('IP discovery')) {
          clearTimeout(connectionTimeout);
          config.status = 'idle';
          discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
          discordManager.notify(userId, { type: 'ERROR', message: `Voice Connection Error: ${err.message}. ${err.message.includes('521') ? 'Discord voice server is temporarily unreachable.' : ''}` });
          client.off('raw', rawListener);
          
          try {
            connection.destroy();
          } catch (e) {}
        } else {
          retryCount++;
          logger.info(`[Voice] Error encountered, retrying... (${retryCount}/${maxRetries})`);
        }
      });

      res.json({ success: true });
    } catch (err: any) {
      logger.error("[Voice] Join error", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leave", async (req, res) => {
    const { userId } = req.body;
    const config = store.configs.find(c => c.user_id === userId);

    if (config && config.channel_id) {
      try {
        const client = await discordManager.getClient(userId, config.token);
        const channel = await client.channels.fetch(config.channel_id);
        if (channel && 'guild' in channel) {
          const conn = getVoiceConnection(channel.guild.id);
          if (conn) {
            conn.destroy();
            logger.info(`[Voice] Link terminated for user ${userId}`);
            sendWebhookNotification(config, `🚪 **Left** voice channel: \`${channel.name}\` (\`${channel.id}\`)`, 10038562);
          }
        }
      } catch (e) {
        logger.error(`[Voice] Error during leave for user ${userId}:`, e);
      }
      config.status = 'idle';
      discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
    } else if (config) {
      // Fallback if client or channel_id is missing but config exists
      config.status = 'idle';
      discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
    }
    res.json({ success: true });
  });

  // Vite middleware
  const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";
  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (e) {
      serveStatic(app);
    }
  } else {
    serveStatic(app);
  }

  function serveStatic(app: any) {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req: any, res: any) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    logger.info(`[Server] Running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  logger.error("[Server] Failed to start", err);
});
