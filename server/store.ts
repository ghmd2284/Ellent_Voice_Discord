import bcrypt from 'bcryptjs';

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

// --- In-Memory Store ---
export const store = {
  users: [{ 
    id: 1, 
    username: "admin", 
    password: bcrypt.hashSync("admin123", 10) 
  }] as User[],
  configs: [] as UserConfig[]
};
