import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from 'discord.js-selfbot-v13';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

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

// --- Database Setup ---
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'discord_manager',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS configs (
        user_id INT PRIMARY KEY,
        token TEXT,
        channel_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'idle',
        webhook_url TEXT,
        webhook_enabled BOOLEAN DEFAULT false
      )
    `);

    // Insert default admin if not exists
    const [rows]: any = await pool.query('SELECT * FROM users WHERE username = ?', ['admin']);
    if (rows.length === 0) {
      const hash = bcrypt.hashSync("admin123", 10);
      await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', hash]);
      logger.info("[DB] Default admin user created.");
    }
    logger.info("[DB] Database initialized successfully.");
  } catch (err) {
    logger.error("[DB] Failed to initialize database. Please check connection.", err);
    process.exit(1);
  }
}

// Data Access Helpers
const db = {
  async getConfig(userId: number): Promise<UserConfig | null> {
    const [rows]: any = await pool.query('SELECT * FROM configs WHERE user_id = ?', [userId]);
    if (rows.length > 0) {
      return {
        ...rows[0],
        webhook_enabled: !!rows[0].webhook_enabled
      } as UserConfig;
    }
    return null;
  },
  async updateConfig(config: UserConfig) {
    await pool.query(`
      INSERT INTO configs (user_id, token, channel_id, status, webhook_url, webhook_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        token = VALUES(token),
        channel_id = VALUES(channel_id),
        status = VALUES(status),
        webhook_url = VALUES(webhook_url),
        webhook_enabled = VALUES(webhook_enabled)
    `, [config.user_id, config.token, config.channel_id, config.status, config.webhook_url, config.webhook_enabled]);
  },
  async updateStatus(userId: number, status: string, channelId?: string) {
    if (channelId) {
      await pool.query('UPDATE configs SET status = ?, channel_id = ? WHERE user_id = ?', [status, channelId, userId]);
    } else {
      await pool.query('UPDATE configs SET status = ? WHERE user_id = ?', [status, userId]);
    }
  }
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
    const config = await db.getConfig(userId);

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
          title: "Ellent Voice Discord | Log",
          description: message,
          color: color,
          timestamp: new Date().toISOString(),
          footer: { text: "Monitoring" }
        }]
      })
    });
  } catch (e) {
    logger.error(`[Webhook] Failed to send notification for user ${config.user_id}`, e);
  }
}

// --- Server Initialization ---
async function startServer() {
  await initDB();

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
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    try {
      const [rows]: any = await pool.query('SELECT * FROM users WHERE username = ?', [username.toLowerCase()]);
      const user = rows[0];
      
      if (user && bcrypt.compareSync(password, user.password)) {
        return res.json({ success: true, user: { id: user.id, username: user.username } });
      }
      
      res.status(401).json({ success: false, message: "Invalid credentials" });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Config API
  app.get("/api/config/:userId", async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const config = await db.getConfig(userId);
      if (config) {
        res.json({ ...config, token: config.token ? "********" : "" });
      } else {
        res.json({ token: "", channel_id: "", status: "idle", webhook_url: "", webhook_enabled: false });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/test-webhook", async (req, res) => {
    try {
      const { userId } = req.body;
      const config = await db.getConfig(userId);
      if (!config || !config.webhook_url) return res.status(400).json({ error: "Webhook not configured" });

      await sendWebhookNotification(config, "🔔 **Test Notification**: Webhook integration is active and working correctly.", 3447003);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const { userId, token, channelId, webhookUrl, webhookEnabled } = req.body;
      const existingConfig = await db.getConfig(userId);
      
      let finalToken = token;
      // If token is the mask, use the existing token from store
      if (existingConfig && token === "********") {
        finalToken = existingConfig.token;
      }
      
      const newConfig: UserConfig = { 
        user_id: userId, 
        token: finalToken, 
        channel_id: channelId, 
        status: existingConfig ? existingConfig.status : "idle",
        webhook_url: webhookUrl,
        webhook_enabled: webhookEnabled
      };
      
      if (existingConfig) {
        // If token changed and it's not the mask, destroy old client
        if (existingConfig.token !== finalToken) {
          discordManager.destroyClient(userId);
        }
      }
      
      await db.updateConfig(newConfig);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Token Validation API
  app.post("/api/validate-token", async (req, res) => {
    try {
      let { token, userId } = req.body;
      
      // If token is masked, try to find the real token in store
      if (token === "********" && userId) {
        const config = await db.getConfig(userId);
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
    } catch (err: any) {
      res.status(500).json({ valid: false, message: err.message });
    }
  });

  // Fetch Guilds
  app.get("/api/guilds/:userId", async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      const config = await db.getConfig(userId);
      if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

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
    try {
      const { guildId } = req.params;
      const userId = parseInt(req.params.userId);
      const config = await db.getConfig(userId);
      if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

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
    try {
      const { userId, channelId } = req.body;
      const config = await db.getConfig(userId);
      if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

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
      await db.updateStatus(userId, 'joining', channelId);
      discordManager.notify(userId, { type: 'STATUS', status: 'joining', channelId });

      // Step 1: Voice State Update (Handled by joinVoiceChannel)
      logger.info(`[Voice] Sending Voice State Update for channel ${channelId}`);
      
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
      });

      connection.on('debug', (message) => {
        logger.debug(`[Voice] User ${userId}: ${message}`);
      });

      let retryCount = 0;
      const maxRetries = 3;

      const connectionTimeout = setTimeout(async () => {
        const currentConfig = await db.getConfig(userId);
        if (currentConfig?.status === 'joining' || connection.state.status !== VoiceConnectionStatus.Ready) {
          logger.error(`[Voice] Timeout reached for user ${userId}. Current state: ${connection.state.status}`);
          
          if (connection.state.status === VoiceConnectionStatus.Connecting || connection.state.status === VoiceConnectionStatus.Signalling) {
             logger.warn(`[Voice] Stuck in ${connection.state.status}. UDP traffic is likely blocked or server is unreachable.`);
             discordManager.notify(userId, { type: 'ERROR', message: 'Voice connection stuck. This might be due to UDP blocking or a temporary Discord issue (521).' });
          }
          
          connection.destroy();
          await db.updateStatus(userId, 'idle');
          discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
        }
      }, 30000);

      connection.on('stateChange', async (oldState, newState) => {
        logger.info(`[Voice] User ${userId} state changed: ${oldState.status} -> ${newState.status}`);
        
        if (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling) {
          logger.info(`[Voice] User ${userId} is ${newState.status}...`);
          await db.updateStatus(userId, 'joining', channelId);
          discordManager.notify(userId, { type: 'STATUS', status: 'joining', channelId });
        }
        
        if (newState.status === VoiceConnectionStatus.Ready) {
          clearTimeout(connectionTimeout);
          logger.info("[Voice] Identify/Ready received & UDP Connection established");
          await db.updateStatus(userId, 'connected', channelId);
          discordManager.notify(userId, { type: 'STATUS', status: 'connected', channelId });
          
          sendWebhookNotification(config, `✅ **Connected** to voice channel: \`${channel.name}\` (\`${channel.id}\`) in guild: \`${channel.guild.name}\``, 3066993);

          connection.setSpeaking(true);
          setTimeout(() => connection.setSpeaking(false), 1000);
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          logger.warn(`[Voice] User ${userId} disconnected. Reason: ${newState.reason}`);
          sendWebhookNotification(config, `⚠️ **Disconnected** from voice channel. Reason code: \`${newState.reason}\`.`, 15105570);
          if (newState.reason === 0 && retryCount < maxRetries) { 
             retryCount++;
             logger.info(`[Voice] Attempting to reconnect user ${userId} (Retry ${retryCount}/${maxRetries})...`);
          } else {
            clearTimeout(connectionTimeout);
            await db.updateStatus(userId, 'idle');
            discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
            client.off('raw', rawListener);
          }
        }

        if (newState.status === VoiceConnectionStatus.Destroyed) {
          clearTimeout(connectionTimeout);
          await db.updateStatus(userId, 'idle');
          discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
          client.off('raw', rawListener);
        }
      });

      connection.on('error', async (err) => {
        logger.error(`[Voice] Error for user ${userId}`, err);
        sendWebhookNotification(config, `❌ **Voice Connection Error**: \`${err.message}\`.`, 15158332);
        
        if (err.message.includes('521')) logger.warn(`[Voice] Discord Voice Server is returning 521 (Down).`);
        if (err.message.includes('IP discovery')) logger.error(`[Voice] Critical: UDP/IP Discovery failed. UDP traffic likely blocked.`);

        if (retryCount >= maxRetries || err.message.includes('IP discovery')) {
          clearTimeout(connectionTimeout);
          await db.updateStatus(userId, 'idle');
          discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
          discordManager.notify(userId, { type: 'ERROR', message: `Voice Connection Error: ${err.message}. ${err.message.includes('521') ? 'Discord voice server is temporarily unreachable.' : ''}` });
          client.off('raw', rawListener);
          
          try { connection.destroy(); } catch (e) {}
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
    try {
      const { userId } = req.body;
      const config = await db.getConfig(userId);

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
      }
      
      await db.updateStatus(userId, 'idle');
      discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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
