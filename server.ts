import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from 'discord.js-selfbot-v13';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import * as davey from '@snazzah/davey';
import { WebSocketServer, WebSocket } from 'ws';

// Ensure DAVE protocol package is loaded for voice encryption
console.log("DAVE Protocol support loaded:", !!davey);
import { createServer } from 'http';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory store
const store = {
  // Initial password "admin123" hashed with bcrypt
  users: [{ 
    id: 1, 
    username: "admin", 
    password: bcrypt.hashSync("admin123", 10) 
  }],
  configs: [] as any[]
};

// Discord Client Manager
const clients = new Map<number, Client>();
// WebSocket Clients
const wsClients = new Map<number, WebSocket>();

// Global Error Handlers to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(express.json());

  // WebSocket Connection Handling
  wss.on('connection', (ws, req) => {
    let userId: number | null = null;
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'AUTH') {
          userId = data.userId;
          if (userId) wsClients.set(userId, ws);
          console.log(`WS Client authenticated: ${userId}`);
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      if (userId) wsClients.delete(userId);
    });
  });

  // Helper to notify client
  function notifyClient(userId: number, data: any) {
    const ws = wsClients.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

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
      res.json({ token: "", channel_id: "", status: "idle" });
    }
  });

  app.post("/api/config", (req, res) => {
    const { userId, token, channelId } = req.body;
    const index = store.configs.findIndex(c => c.user_id === userId);
    
    let finalToken = token;
    // If token is the mask, use the existing token from store
    if (index !== -1 && token === "********") {
      finalToken = store.configs[index].token;
    }
    
    const newConfig = { user_id: userId, token: finalToken, channel_id: channelId, status: "idle" };
    if (index !== -1) {
      // If token changed and it's not the mask, destroy old client
      if (store.configs[index].token !== finalToken) {
        const oldClient = clients.get(userId);
        if (oldClient) {
          oldClient.destroy();
          clients.delete(userId);
        }
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

  // Helper to get or create client
  async function getDiscordClient(userId: number, token: string) {
    let client = clients.get(userId);
    const config = store.configs.find(c => c.user_id === userId);

    if (!client) {
      client = new Client({
        patchVoice: true
      } as any);
      
      client.on('ready', () => {
        console.log(`Discord Client Ready: ${client?.user?.tag}`);
        notifyClient(userId, { type: 'STATUS', status: config?.status || 'idle', tag: client?.user?.tag });
      });

      client.on('error', (err) => {
        console.error(`Discord Client Error (${userId}):`, err);
        notifyClient(userId, { type: 'ERROR', message: err.message });
      });

      try {
        await client.login(token);
        clients.set(userId, client);
      } catch (err: any) {
        throw new Error(`Login failed: ${err.message}`);
      }
    }
    return client;
  }

  // Fetch Guilds
  app.get("/api/guilds/:userId", async (req, res) => {
    const userId = parseInt(req.params.userId);
    const config = store.configs.find(c => c.user_id === userId);
    if (!config || !config.token) return res.status(400).json({ error: "Token not configured" });

    try {
      const client = await getDiscordClient(userId, config.token);
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
      const client = await getDiscordClient(userId, config.token);
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
      const client = await getDiscordClient(userId, config.token);
      const channel = await client.channels.fetch(channelId);
      
      if (!channel || channel.type !== 'GUILD_VOICE') {
        throw new Error("Invalid voice channel");
      }

      // Cleanup existing connection in same guild
      const existing = getVoiceConnection(channel.guild.id);
      if (existing) existing.destroy();

      config.status = 'joining';
      config.channel_id = channelId;
      notifyClient(userId, { type: 'STATUS', status: 'joining', channelId });

      // Step 1: Voice State Update (Handled by joinVoiceChannel)
      console.log(`[Step 1] Sending Voice State Update for channel ${channelId}`);
      
      // Manual event tracking for diagnostics
      const rawListener = (packet: any) => {
        if (packet.t === 'VOICE_SERVER_UPDATE' && packet.d.guild_id === channel.guild.id) {
          console.log(`[Raw Debug] VOICE_SERVER_UPDATE received for user ${userId}`);
        }
        if (packet.t === 'VOICE_STATE_UPDATE' && packet.d.guild_id === channel.guild.id && packet.d.user_id === client.user?.id) {
          console.log(`[Raw Debug] VOICE_STATE_UPDATE received for user ${userId}. Session ID: ${packet.d.session_id}`);
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
        console.log(`[Voice Debug] User ${userId}: ${message}`);
      });

      // Timeout logic: if not connected in 45s, reset
      const connectionTimeout = setTimeout(() => {
        if (config.status === 'joining' || connection.state.status !== VoiceConnectionStatus.Ready) {
          console.error(`[Voice Connection] Timeout reached for user ${userId}. Current state: ${connection.state.status}`);
          // If we are in 'Connecting' state, it might be UDP blocked. 
          // Some environments allow the bot to stay in channel even if UDP fails.
          if (connection.state.status === VoiceConnectionStatus.Connecting) {
             console.log(`[Voice Connection] Stuck in Connecting. This is likely a UDP block. The bot might still appear in channel.`);
          } else {
            connection.destroy();
            config.status = 'idle';
            notifyClient(userId, { type: 'STATUS', status: 'idle' });
            notifyClient(userId, { type: 'ERROR', message: 'Voice connection timed out. UDP ports might be blocked.' });
          }
        }
      }, 45000);

      connection.on('stateChange', (oldState, newState) => {
        console.log(`[Voice Connection] User ${userId} state changed from ${oldState.status} to ${newState.status}`);
        
        if (newState.status === VoiceConnectionStatus.Connecting) {
          console.log("[Step 2-3] Voice Server Update received & WebSocket connecting...");
        }
        
        if (newState.status === VoiceConnectionStatus.Ready) {
          clearTimeout(connectionTimeout);
          console.log("[Step 5-7] Identify/Ready received & UDP Connection established");
          config.status = 'connected';
          notifyClient(userId, { type: 'STATUS', status: 'connected', channelId });
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
          console.log(`[Voice Connection] User ${userId} disconnected. Reason: ${newState.reason}`);
          if (newState.reason === 0) { 
             console.log(`[Voice Connection] Attempting to reconnect user ${userId}...`);
          } else {
            clearTimeout(connectionTimeout);
            config.status = 'idle';
            notifyClient(userId, { type: 'STATUS', status: 'idle' });
            client.off('raw', rawListener);
          }
        }

        if (newState.status === VoiceConnectionStatus.Destroyed) {
          clearTimeout(connectionTimeout);
          config.status = 'idle';
          notifyClient(userId, { type: 'STATUS', status: 'idle' });
          client.off('raw', rawListener);
        }
      });

      connection.on('error', (err) => {
        clearTimeout(connectionTimeout);
        console.error(`[Voice Connection] Error for user ${userId}:`, err);
        
        // Handle specific "IP discovery" error which often happens in restricted environments
        if (err.message.includes('IP discovery')) {
          console.error(`[Voice Connection] Critical: UDP/IP Discovery failed. This environment likely blocks UDP traffic.`);
        }

        config.status = 'idle';
        notifyClient(userId, { type: 'STATUS', status: 'idle' });
        notifyClient(userId, { type: 'ERROR', message: `Voice Connection Error: ${err.message}. ${err.message.includes('IP discovery') ? 'UDP traffic might be blocked by your host.' : ''}` });
        client.off('raw', rawListener);
        
        try {
          connection.destroy();
        } catch (e) {}
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error("Join error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leave", async (req, res) => {
    const { userId } = req.body;
    const config = store.configs.find(c => c.user_id === userId);
    const client = clients.get(userId);

    if (config && client && config.channel_id) {
      try {
        const channel = await client.channels.fetch(config.channel_id);
        if (channel && 'guild' in channel) {
          const conn = getVoiceConnection(channel.guild.id);
          if (conn) {
            conn.destroy();
            console.log(`[Voice Connection] Destroyed for user ${userId}`);
          }
        }
      } catch (e) {
        console.error(`[Voice Connection] Error during leave for user ${userId}:`, e);
      }
      config.status = 'idle';
      notifyClient(userId, { type: 'STATUS', status: 'idle' });
    } else if (config) {
      // Fallback if client or channel_id is missing but config exists
      config.status = 'idle';
      notifyClient(userId, { type: 'STATUS', status: 'idle' });
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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Server failed to start:", err);
});
