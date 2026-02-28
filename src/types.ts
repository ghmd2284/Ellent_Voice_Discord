export interface UserConfig {
  user_id: number;
  token: string;
  channel_id: string;
  status: 'idle' | 'joining' | 'connected';
  webhook_url?: string;
  webhook_enabled?: boolean;
}

export interface User {
  id: number;
  username: string;
  password: string;
}
