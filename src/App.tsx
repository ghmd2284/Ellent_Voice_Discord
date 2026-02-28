import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { LogIn, LayoutDashboard, Settings, LogOut, Mic, MicOff, Shield, Key, Hash, Activity, Bell } from 'lucide-react';
import { Toaster, toast } from 'sonner';

type User = {
  id: number;
  username: string;
};

type Config = {
  token: string;
  channel_id: string;
  status: 'idle' | 'joining' | 'connected';
  webhook_url?: string;
  webhook_enabled?: boolean;
};

// --- Logger Helper ---
const logger = {
  format: (level: string, message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    return `[${timestamp}] [${level}] ${message}`;
  },
  info: (message: string) => console.log(logger.format('INFO', message)),
  warn: (message: string) => console.warn(logger.format('WARN', message)),
  error: (message: string, err?: any) => {
    console.error(logger.format('ERROR', message), err || '');
  },
};

// --- Components ---
const StatusBadge = ({ status }: { status: string }) => {
  const colors = {
    connected: 'bg-emerald-500 text-emerald-500',
    joining: 'bg-amber-500 text-amber-500',
    idle: 'bg-zinc-800 text-zinc-500'
  };
  const color = colors[status as keyof typeof colors] || colors.idle;
  
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${color.split(' ')[0]} ${status === 'joining' ? 'animate-pulse' : status === 'connected' ? 'shadow-[0_0_8px_rgba(16,185,129,0.5)]' : ''}`} />
      <span className={`text-[10px] font-bold uppercase tracking-widest ${color.split(' ')[1]}`}>
        {status}
      </span>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Dashboard state
  const [config, setConfig] = useState<Config>({ token: '', channel_id: '', status: 'idle' });
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [guilds, setGuilds] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [selectedGuild, setSelectedGuild] = useState<string>('');
  const [isLoadingGuilds, setIsLoadingGuilds] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [visibleGuildsCount, setVisibleGuildsCount] = useState(6);
  const [isEditingToken, setIsEditingToken] = useState(false);

  const [discordTag, setDiscordTag] = useState<string>('');
  const [discordUser, setDiscordUser] = useState<any>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);

  const handleValidateToken = async (tokenOverride?: string) => {
    const tokenToValidate = tokenOverride || config.token;
    if (!tokenToValidate) return;
    setIsValidating(true);
    setTokenValid(null);
    try {
      const res = await fetch('/api/validate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          token: tokenToValidate,
          userId: user?.id 
        }),
      });
      const data = await res.json();
      if (data.valid) {
        setTokenValid(true);
        setDiscordUser(data.user);
        setDiscordTag(data.user.tag);
        
        // If it was a manual validation (not auto-restore), save it
        if (!tokenOverride) {
          toast.success('Identity Verified', {
            description: `Token for ${data.user.username} is valid and ready.`,
          });
          handleSaveConfig(tokenToValidate);
        }
      } else {
        setTokenValid(false);
        setDiscordUser(null);
        if (!tokenOverride) {
          toast.error('Identity Verification Failed', {
            description: 'The provided token is invalid or expired.',
          });
        }
      }
    } catch (e) {
      setTokenValid(false);
      if (!tokenOverride) {
        toast.error('Verification Error', {
          description: 'Failed to reach the validation endpoint.',
        });
      }
    } finally {
      setIsValidating(false);
    }
  };

  const [connectionTime, setConnectionTime] = useState<number>(0);
  const [timerInterval, setTimerInterval] = useState<NodeJS.Timeout | null>(null);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    if (config.status === 'connected') {
      const interval = setInterval(() => {
        setConnectionTime(prev => prev + 1);
      }, 1000);
      setTimerInterval(interval);
    } else {
      if (timerInterval) clearInterval(timerInterval);
      setConnectionTime(0);
    }
    return () => {
      if (timerInterval) clearInterval(timerInterval);
    };
  }, [config.status]);

  useEffect(() => {
    if (!user) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);
    
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'AUTH', userId: user.id }));
      logger.info('WebSocket connection established');
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'STATUS') {
        setConfig(prev => ({ ...prev, status: data.status, channel_id: data.channelId || prev.channel_id }));
        if (data.tag) setDiscordTag(data.tag);
        
        if (data.status === 'connected') {
          toast.success('Link Established', {
            description: 'Successfully connected to the voice terminal.',
          });
        }
      } else if (data.type === 'ERROR') {
        toast.error('Discord Error', {
          description: data.message,
        });
      }
    };

    setWs(socket);
    return () => socket.close();
  }, [user]);

  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
      logger.info('User session restored from local storage');
    }
  }, []);

  useEffect(() => {
    if (user) {
      fetchConfig();
    }
  }, [user]);

  const fetchConfig = async () => {
    if (!user || !user.id) return;
    try {
      const res = await fetch(`/api/config/${user.id}`);
      if (!res.ok) {
        throw new Error(`Server responded with ${res.status}`);
      }
      const data = await res.json();
      logger.info('Configuration retrieved');
      setConfig(data);
      if (data.token) {
        handleValidateToken(data.token);
      }
    } catch (err) {
      logger.error('Failed to fetch config', err);
    }
  };

  const fetchGuilds = async () => {
    if (!user || !config.token) return;
    setIsLoadingGuilds(true);
    const id = toast.loading('Scanning Infrastructure', {
      description: 'Retrieving available server nodes...',
    });
    try {
      const res = await fetch(`/api/guilds/${user.id}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setGuilds(data);
        toast.success('Scan Complete', {
          id,
          description: `Detected ${data.length} available server nodes.`,
        });
        handleSaveConfig();
      } else {
        throw new Error(data.error || 'Failed to fetch guilds');
      }
    } catch (e: any) {
      logger.error('Failed to fetch guilds', e);
      toast.error('Scan Failed', {
        id,
        description: e.message || 'Could not retrieve infrastructure data.',
      });
    } finally {
      setIsLoadingGuilds(false);
    }
  };

  const fetchChannels = async (guildId: string) => {
    if (!user) return;
    setIsLoadingChannels(true);
    try {
      const res = await fetch(`/api/channels/${guildId}/${user.id}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setChannels(data);
        // Save the fact that we selected this guild (implicit in channel fetch)
        handleSaveConfig();
      }
    } catch (e) {
      logger.error('Failed to fetch channels', e);
    } finally {
      setIsLoadingChannels(false);
    }
  };

  // Removed auto-fetch on token change to respect user request

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.message || `Login failed with status ${res.status}`);
      }

      const data = await res.json();
      if (data.success) {
        setUser(data.user);
        localStorage.setItem('user', JSON.stringify(data.user));
        logger.info(`Session initialized for user: ${data.user.username}`);
        toast.success('Access Granted', {
          description: `Welcome back, ${data.user.username}. Session initialized.`,
        });
      } else {
        setError(data.message || 'Login failed');
        logger.warn(`Login failed: ${data.message}`);
        toast.error('Access Denied', {
          description: data.message || 'Invalid credentials.',
        });
      }
    } catch (err: any) {
      logger.error('Login error', err);
      setError(err.message || 'Connection error');
      toast.error('Critical Error', {
        description: err.message || 'Failed to establish connection with the authentication server.',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('user');
  };

  const handleSaveConfig = async (tokenOverride?: string, configOverride?: Config) => {
    if (!user) return;
    setSaveStatus('saving');
    const targetConfig = configOverride || config;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          token: tokenOverride || targetConfig.token,
          channelId: targetConfig.channel_id,
          webhookUrl: targetConfig.webhook_url,
          webhookEnabled: targetConfig.webhook_enabled,
        }),
      });
      if (res.ok) {
        setSaveStatus('saved');
        if (!tokenOverride) {
          toast.success('Configuration Synced', {
            description: 'Identity and connection parameters have been updated.',
          });
        }
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        toast.error('Sync Failed', {
          description: 'Could not update system configuration.',
        });
      }
    } catch (err) {
      setSaveStatus('idle');
      toast.error('Sync Error', {
        description: 'Network failure during configuration sync.',
      });
    }
  };

  const handleJoin = async (channelId: string) => {
    if (!user) return;
    
    toast.info('Initiating Link', {
      description: `Connecting to terminal ${channelId.slice(-6)}...`,
    });

    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, channelId }),
      });
      if (res.ok) {
        fetchConfig();
      } else {
        toast.error('Link Failed', {
          description: 'The voice server rejected the connection request.',
        });
      }
    } catch (err) {
      toast.error('Link Error', {
        description: 'Failed to transmit join protocol.',
      });
    }
  };

  const handleLeave = async () => {
    if (!user) return;
    toast.info('Terminating Link', {
      description: 'Disconnecting from voice terminal...',
    });
    try {
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (res.ok) {
        toast.success('Link Terminated', {
          description: 'Successfully disconnected from the voice terminal.',
        });
        fetchConfig();
      } else {
        toast.error('Termination Failed', {
          description: 'The server could not process the disconnect request.',
        });
      }
    } catch (err) {
      toast.error('Termination Error', {
        description: 'Failed to transmit leave protocol.',
      });
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center p-4 font-sans relative overflow-hidden">
        {/* Background Atmosphere */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
        </div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md relative z-10"
        >
          <div className="bg-zinc-900/50 backdrop-blur-2xl border border-white/5 p-8 rounded-[32px] shadow-2xl">
            <div className="flex flex-col items-center text-center mb-10">
              <div className="w-16 h-16 bg-white/5 rounded-2xl border border-white/10 flex items-center justify-center mb-4 shadow-inner">
                <Shield className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-3xl font-bold tracking-tight mb-2">Ellent Manager</h1>
              <p className="text-zinc-500 text-sm max-w-[240px]">Professional management suite for automated voice presence.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] ml-1">Identity</label>
                <div className="relative">
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 focus:outline-none focus:border-white/20 transition-all placeholder:text-zinc-700"
                    placeholder="Username"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] ml-1">Access Key</label>
                <div className="relative">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-black/40 border border-white/5 rounded-2xl px-5 py-4 focus:outline-none focus:border-white/20 transition-all placeholder:text-zinc-700"
                    placeholder="••••••••"
                    required
                  />
                </div>
              </div>
              
              <AnimatePresence mode="wait">
                {error && (
                  <motion.p 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-red-400 text-xs text-center font-medium"
                  >
                    {error}
                  </motion.p>
                )}
              </AnimatePresence>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-white text-black font-bold py-4 rounded-2xl hover:bg-zinc-200 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-50 mt-4 shadow-lg shadow-white/5"
              >
                {loading ? (
                  <Activity className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <LogIn className="w-5 h-5" />
                    Initialize Session
                  </>
                )}
              </button>
            </form>
            
            <div className="mt-8 pt-6 border-t border-white/5 text-center">
              <p className="text-zinc-600 text-[10px] uppercase tracking-widest">
                System Default: <span className="text-zinc-400">admin / admin123</span>
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-emerald-500/30">
      <Toaster position="top-right" theme="dark" richColors closeButton />
      {/* Navigation */}
      <nav className="border-b border-white/5 bg-black/50 backdrop-blur-2xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-white/5 rounded-xl border border-white/10 flex items-center justify-center shadow-inner">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight block">Ellent Manager</span>
              <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold">Voice Management Suite</span>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs font-bold text-zinc-300">{user.username}</span>
              <span className="text-[10px] text-emerald-500 font-bold uppercase tracking-tighter">Operator Active</span>
            </div>
            <button 
              onClick={handleLogout}
              className="p-3 bg-white/5 hover:bg-red-500/10 border border-white/5 hover:border-red-500/20 rounded-xl transition-all text-zinc-400 hover:text-red-500 group"
            >
              <LogOut className="w-5 h-5 group-hover:scale-110 transition-transform" />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
          
          {/* Main Content */}
          <div className="lg:col-span-8 space-y-10">
            
            {/* Profile & Token Section */}
            <section className="space-y-6">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-1.5 h-6 bg-emerald-500 rounded-full" />
                <h2 className="text-xl font-bold tracking-tight">Identity Configuration</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-zinc-900/50 border border-white/5 rounded-[24px] p-6 space-y-6">
                  <AnimatePresence mode="wait">
                    {tokenValid && !isEditingToken ? (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="space-y-4"
                      >
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                            <Key className="w-3 h-3" />
                            Active Token
                          </label>
                          <button 
                            onClick={() => setIsEditingToken(true)}
                            className="text-[10px] font-bold text-blue-400 hover:text-blue-300 uppercase tracking-widest"
                          >
                            Change
                          </button>
                        </div>
                        <div className="bg-black/40 border border-white/5 rounded-2xl px-5 py-4 flex items-center justify-between">
                          <span className="text-xs font-mono text-zinc-400">••••••••••••••••</span>
                          <Shield className="w-4 h-4 text-emerald-500" />
                        </div>
                        <p className="text-[10px] text-emerald-500 font-bold flex items-center gap-1.5 uppercase tracking-tighter">
                          <Shield className="w-3 h-3" /> Identity Verified
                        </p>
                      </motion.div>
                    ) : (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="space-y-4"
                      >
                        <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                          <Key className="w-3 h-3" />
                          Access Token
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={config.token === '********' ? '' : config.token}
                            onChange={(e) => {
                              setConfig({ ...config, token: e.target.value });
                              setTokenValid(null);
                            }}
                            className={`flex-1 bg-black/40 border rounded-2xl px-5 py-4 focus:outline-none transition-all font-mono text-xs ${tokenValid === true ? 'border-emerald-500/50' : tokenValid === false ? 'border-red-500/50' : 'border-white/5 focus:border-white/20'}`}
                            placeholder="Discord User Token"
                          />
                          <button
                            onClick={async () => {
                              await handleValidateToken();
                              setIsEditingToken(false);
                            }}
                            disabled={isValidating || !config.token}
                            className="bg-zinc-800 hover:bg-zinc-700 text-white px-5 rounded-2xl text-[10px] font-bold uppercase tracking-wider transition-all border border-white/5 disabled:opacity-50"
                          >
                            {isValidating ? <Activity className="w-4 h-4 animate-spin" /> : 'Verify'}
                          </button>
                        </div>
                        {tokenValid === false && <p className="text-[10px] text-red-500 font-bold flex items-center gap-1.5 uppercase tracking-tighter">Invalid Credentials</p>}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <AnimatePresence mode="wait">
                  {tokenValid === true ? (
                    <motion.div
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="bg-emerald-500/5 border border-emerald-500/10 rounded-[24px] p-6 flex flex-col justify-between"
                    >
                      <div className="flex items-center gap-4">
                        <div className="relative">
                          {discordUser?.avatar ? (
                            <img src={discordUser.avatar} alt="" className="w-14 h-14 rounded-2xl border-2 border-emerald-500/20 shadow-lg" />
                          ) : (
                            <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 flex items-center justify-center font-bold text-xl text-emerald-500">
                              {discordUser?.username?.charAt(0)}
                            </div>
                          )}
                          <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 border-2 border-[#050505] rounded-full" />
                        </div>
                        <div>
                          <p className="text-lg font-bold tracking-tight">{discordUser?.username}</p>
                          <p className="text-xs text-emerald-500/60 font-mono">{discordUser?.tag}</p>
                        </div>
                      </div>
                      <div className="mt-6 flex items-center justify-between">
                        <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest">Profile Synced</span>
                        <button
                          onClick={handleSaveConfig}
                          disabled={saveStatus === 'saving'}
                          className="bg-white text-black px-6 py-2.5 rounded-xl text-xs font-bold hover:bg-zinc-200 transition-all shadow-lg shadow-white/5 disabled:opacity-50"
                        >
                          {saveStatus === 'saving' ? 'Syncing...' : saveStatus === 'saved' ? 'Synced' : 'Save Identity'}
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <div className="bg-zinc-900/30 border border-white/5 border-dashed rounded-[24px] p-6 flex items-center justify-center text-center">
                      <p className="text-zinc-600 text-xs max-w-[160px]">Verify your token to unlock identity profile.</p>
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </section>

            {/* Monitoring & Alerts Section */}
            {tokenValid === true && (
              <section className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-1.5 h-6 bg-blue-500 rounded-full" />
                  <h2 className="text-xl font-bold tracking-tight">Monitoring & Alerts</h2>
                </div>

                <div className="bg-zinc-900/50 border border-white/5 rounded-[24px] p-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <label className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                        <Bell className="w-3 h-3" />
                        Discord Webhook Logging
                      </label>
                      <p className="text-[10px] text-zinc-600">Receive real-time alerts for connection events.</p>
                    </div>
                    <button
                      onClick={() => {
                        const newState = !config.webhook_enabled;
                        const updatedConfig = { ...config, webhook_enabled: newState };
                        setConfig(updatedConfig);
                        handleSaveConfig(undefined, updatedConfig);
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${config.webhook_enabled ? 'bg-blue-500' : 'bg-zinc-800'}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.webhook_enabled ? 'translate-x-6' : 'translate-x-1'}`}
                      />
                    </button>
                  </div>

                  <AnimatePresence>
                    {config.webhook_enabled && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-4 pt-2 overflow-hidden"
                      >
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Webhook URL</label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={config.webhook_url || ''}
                              onChange={(e) => setConfig({ ...config, webhook_url: e.target.value })}
                              className="flex-1 bg-black/40 border border-white/5 rounded-2xl px-5 py-4 focus:outline-none focus:border-white/20 transition-all font-mono text-xs text-zinc-300"
                              placeholder="https://discord.com/api/webhooks/..."
                            />
                            <button
                              onClick={async () => {
                                await handleSaveConfig();
                                try {
                                  const res = await fetch('/api/test-webhook', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ userId: user.id }),
                                  });
                                  if (res.ok) {
                                    toast.success('Test Notification Sent', {
                                      description: 'Check your Discord channel for the alert.',
                                    });
                                  } else {
                                    toast.error('Webhook Test Failed', {
                                      description: 'Ensure the URL is correct and active.',
                                    });
                                  }
                                } catch (e) {
                                  toast.error('Network Error', {
                                    description: 'Failed to trigger webhook test.',
                                  });
                                }
                              }}
                              className="bg-zinc-800 hover:bg-zinc-700 text-white px-5 rounded-2xl text-[10px] font-bold uppercase tracking-wider transition-all border border-white/5"
                            >
                              Test
                            </button>
                            <button
                              onClick={() => handleSaveConfig()}
                              className="bg-white text-black px-5 rounded-2xl text-[10px] font-bold uppercase tracking-wider transition-all border border-white/5"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </section>
            )}

            {/* Server Selection */}
            {tokenValid === true && (
              <section className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-6 bg-blue-500 rounded-full" />
                    <h2 className="text-xl font-bold tracking-tight">Infrastructure</h2>
                  </div>
                  <button
                    onClick={fetchGuilds}
                    disabled={isLoadingGuilds}
                    className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition-all uppercase tracking-widest bg-blue-500/5 px-4 py-2 rounded-lg border border-blue-500/10"
                  >
                    {isLoadingGuilds ? 'Scanning...' : 'Scan Servers'}
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {guilds.length > 0 ? (
                    <>
                      <AnimatePresence>
                        {guilds.slice(0, visibleGuildsCount).map((g, idx) => (
                          <motion.button
                            key={g.id}
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: idx * 0.05 }}
                            onClick={() => {
                              setSelectedGuild(g.id);
                              fetchChannels(g.id);
                            }}
                            className={`group p-4 rounded-[20px] border transition-all text-left relative overflow-hidden ${selectedGuild === g.id ? 'bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/20' : 'bg-zinc-900/50 border-white/5 hover:border-white/10'}`}
                          >
                            <div className="flex flex-col items-center text-center gap-3 relative z-10">
                              <div className="relative">
                                {g.icon ? (
                                  <img src={g.icon} alt="" className="w-12 h-12 rounded-xl shadow-md group-hover:scale-105 transition-transform" />
                                ) : (
                                  <div className="w-12 h-12 rounded-xl bg-zinc-800 flex items-center justify-center text-sm font-bold text-zinc-400">
                                    {g.name.charAt(0)}
                                  </div>
                                )}
                                {selectedGuild === g.id && (
                                  <motion.div layoutId="active-server" className="absolute -inset-1 border-2 border-blue-500 rounded-xl" />
                                )}
                              </div>
                              <span className="text-[10px] font-bold truncate w-full uppercase tracking-tighter text-zinc-300">{g.name}</span>
                            </div>
                          </motion.button>
                        ))}
                      </AnimatePresence>
                      {guilds.length > visibleGuildsCount && (
                        <motion.button
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          onClick={() => setVisibleGuildsCount(prev => prev + 8)}
                          className="col-span-full py-4 text-[10px] font-bold text-zinc-500 hover:text-white uppercase tracking-widest border border-dashed border-white/5 rounded-[20px] transition-all hover:bg-white/5 flex items-center justify-center gap-2"
                        >
                          <Activity className="w-3 h-3" />
                          Load More Infrastructure ({guilds.length - visibleGuildsCount} remaining)
                        </motion.button>
                      )}
                    </>
                  ) : (
                    <div className="col-span-full py-12 text-center bg-zinc-900/20 border border-dashed border-white/5 rounded-[24px]">
                      <LayoutDashboard className="w-8 h-8 text-zinc-800 mx-auto mb-3" />
                      <p className="text-zinc-600 text-xs">No active infrastructure detected. Initiate scan.</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Channels Selection */}
            <AnimatePresence>
              {selectedGuild && (
                <motion.section 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-6"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-6 bg-purple-500 rounded-full" />
                    <h2 className="text-xl font-bold tracking-tight">Voice Terminals</h2>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {isLoadingChannels ? (
                      <div className="col-span-full py-10 text-center bg-zinc-900/20 rounded-[24px] border border-white/5">
                        <Activity className="w-6 h-6 text-zinc-700 animate-spin mx-auto mb-2" />
                        <p className="text-zinc-600 text-xs">Synchronizing channels...</p>
                      </div>
                    ) : channels.length > 0 ? (
                      channels.map(c => (
                        <button
                          key={c.id}
                          onClick={() => handleJoin(c.id)}
                          disabled={config.status !== 'idle'}
                          className={`group p-5 rounded-[20px] border transition-all flex items-center justify-between relative overflow-hidden ${config.channel_id === c.id ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-zinc-900/50 border-white/5 hover:border-white/10'}`}
                        >
                          <div className="flex items-center gap-4 relative z-10">
                            <div className={`p-2.5 rounded-lg ${config.channel_id === c.id ? 'bg-emerald-500/20 text-emerald-500' : 'bg-white/5 text-zinc-500 group-hover:text-zinc-300'}`}>
                              <Mic className="w-4 h-4" />
                            </div>
                            <div className="text-left">
                              <p className={`text-sm font-bold ${config.channel_id === c.id ? 'text-emerald-500' : 'text-zinc-300'}`}>{c.name}</p>
                              <p className="text-[10px] text-zinc-600 font-mono uppercase tracking-tighter">Terminal ID: {c.id.slice(-6)}</p>
                            </div>
                          </div>
                          {config.channel_id === c.id && config.status === 'connected' && (
                            <div className="flex items-center gap-1.5 bg-emerald-500/20 px-3 py-1 rounded-full border border-emerald-500/20">
                              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-tighter">Active</span>
                            </div>
                          )}
                        </button>
                      ))
                    ) : (
                      <div className="col-span-full py-10 text-center bg-zinc-900/20 rounded-[24px] border border-white/5">
                        <p className="text-zinc-600 text-xs">No voice terminals available in this sector.</p>
                      </div>
                    )}
                  </div>
                </motion.section>
              )}
            </AnimatePresence>
          </div>

          {/* Sidebar */}
          <div className="lg:col-span-4 space-y-8">
            
            {/* Control Center */}
            <section className="bg-zinc-900/50 border border-white/5 rounded-[32px] p-8 space-y-8">
              <div className="flex items-center gap-3">
                <Activity className="w-5 h-5 text-zinc-500" />
                <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-400">Command Center</h3>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <button
                  onClick={() => handleJoin(config.channel_id)}
                  disabled={config.status !== 'idle' || !config.token || !config.channel_id}
                  className="group relative bg-emerald-500 text-black py-5 rounded-[24px] font-bold hover:bg-emerald-400 active:scale-[0.98] transition-all flex flex-col items-center gap-2 disabled:opacity-20 disabled:grayscale shadow-xl shadow-emerald-500/10"
                >
                  <Mic className="w-6 h-6 group-hover:scale-110 transition-transform" />
                  <span className="text-xs uppercase tracking-widest">Initiate Link</span>
                </button>
                <button
                  onClick={handleLeave}
                  disabled={config.status === 'idle'}
                  className="group bg-white/5 border border-white/5 text-red-500 py-5 rounded-[24px] font-bold hover:bg-red-500/10 hover:border-red-500/20 active:scale-[0.98] transition-all flex flex-col items-center gap-2 disabled:opacity-20 disabled:grayscale"
                >
                  <MicOff className="w-6 h-6 group-hover:scale-110 transition-transform" />
                  <span className="text-xs uppercase tracking-widest">Terminate Link</span>
                </button>
              </div>

              <div className="pt-6 border-t border-white/5 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Link Status</span>
                  <StatusBadge status={config.status} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Mute Protocol</span>
                  <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Enforced</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Deaf Protocol</span>
                  <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Disabled</span>
                </div>
              </div>
            </section>

            {/* Active Session Info */}
            <section className="bg-zinc-900/30 border border-white/5 rounded-[32px] p-8 space-y-6">
              <h3 className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.2em]">Session Details</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase">Status</span>
                  <StatusBadge status={config.status} />
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase">Uptime</span>
                  <span className={`text-[10px] font-mono ${config.status === 'connected' ? 'text-emerald-500' : 'text-zinc-500'}`}>
                    {config.status === 'connected' ? formatTime(connectionTime) : '00:00:00'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase">Protocol</span>
                  <span className="text-[10px] font-mono text-zinc-300">UDP / DAVE</span>
                </div>
                <div className="pt-4 border-t border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-3 h-3 text-emerald-500" />
                    <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Security Layer Active</span>
                  </div>
                  <p className="text-[9px] text-zinc-600 leading-relaxed italic">
                    DAVE Protocol & UDP Encryption initialized. Session is isolated and mimicked.
                  </p>
                </div>
              </div>
            </section>

            {/* Troubleshooting Section */}
            <section className="bg-zinc-900/30 border border-white/5 rounded-[32px] p-8">
              <div className="flex items-center gap-4 mb-6">
                <div className="p-3 bg-amber-500/10 rounded-2xl text-amber-500">
                  <Activity className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold">Troubleshooting Connection</h3>
                  <p className="text-xs text-zinc-500">Solusi jika bot gagal terhubung ke Voice Channel</p>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">01. Region Voice</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">Ganti region Voice Channel di Discord (Settings Channel &rarr; Overview &rarr; Region Override) ke <b>Singapore</b> atau <b>US Central</b>.</p>
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">02. UDP Traffic</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">Beberapa hosting memblokir lalu lintas UDP. Jika bot terus "Stuck", kemungkinan besar hosting Anda tidak mendukung Voice Discord.</p>
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">03. Reset Token</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">Pastikan token akun Anda valid. Coba logout dan login kembali di dashboard ini untuk menyegarkan sesi bot.</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
