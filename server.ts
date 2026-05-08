import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import bcrypt from 'bcryptjs';

import { logger } from './server/logger.ts';
import { store } from './server/store.ts';
import type { UserConfig } from './server/store.ts';
import { discordManager, joinVoice, leaveVoice, sendWebhookNotification } from './server/discordHelper.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Global Error Handlers ---
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}`, reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', err);
});

// --- Server Initialization ---
async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = parseInt(process.env.PORT || "3232", 10);

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
      } catch (e) { }
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

    const { Client } = await import('discord.js-selfbot-v13');
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
    try {
      await joinVoice(userId, channelId);
      res.json({ success: true });
    } catch (err: any) {
      logger.error("[Voice] Join error", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/leave", async (req, res) => {
    const { userId } = req.body;
    try {
      await leaveVoice(userId);
      res.json({ success: true });
    } catch (e: any) {
      logger.error(`[Voice] Error during leave for user ${userId}:`, e);
      res.status(500).json({ error: e.message });
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

  const HOST = process.env.HOST || "0.0.0.0";

  const listenCallback = () => {
    logger.info(`[Server] Running on http://${HOST || 'localhost'}:${PORT}`);
  };

  if (HOST) {
    server.listen(PORT, HOST, listenCallback);
  } else {
    server.listen(PORT, listenCallback);
  }
}

startServer().catch(err => {
  logger.error("[Server] Failed to start", err);
});
