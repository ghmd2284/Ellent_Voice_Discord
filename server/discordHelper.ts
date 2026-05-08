import { Client } from 'discord.js-selfbot-v13';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { WebSocket } from 'ws';
import { logger } from './logger.ts';
import { store } from './store.ts';
import type { UserConfig } from './store.ts';

export async function sendWebhookNotification(config: UserConfig, message: string, color: number = 5814783) {
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

export class DiscordManager {
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

export const discordManager = new DiscordManager();

export async function joinVoice(userId: number, channelId: string) {
  const config = store.configs.find(c => c.user_id === userId);
  if (!config || !config.token) throw new Error("Token not configured");

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
    
    if (err.message.includes('521')) {
      logger.warn(`[Voice] Discord Voice Server is returning 521 (Down).`);
    }

    if (err.message.includes('IP discovery')) {
      logger.error(`[Voice] Critical: UDP/IP Discovery failed. UDP traffic likely blocked.`);
    }

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
}

export async function leaveVoice(userId: number) {
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
    config.status = 'idle';
    discordManager.notify(userId, { type: 'STATUS', status: 'idle' });
  }
}
