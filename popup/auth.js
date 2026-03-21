/**
 * PlayShare — Supabase Auth
 * Handles sign up, sign in, sign out, and session persistence.
 */

(function () {
  'use strict';

  const config = typeof SUPABASE_CONFIG !== 'undefined' ? SUPABASE_CONFIG : {};
  const isConfigured = config.url && config.anonKey && !config.url.includes('YOUR_');

  function getSupabase() {
    if (!isConfigured) return null;
    const sb = typeof supabase !== 'undefined' ? supabase : (typeof window !== 'undefined' && window.supabase);
    if (!sb || !sb.createClient) return null;
    return sb.createClient(config.url, config.anonKey);
  }

  window.PlayShareAuth = {
    isConfigured,
    supabase: null,

    async init() {
      if (!isConfigured) return null;
      this.supabase = getSupabase();
      if (!this.supabase) return null;
      const { data: { session } } = await this.supabase.auth.getSession();
      return session;
    },

    async getSession() {
      if (!this.supabase) this.supabase = getSupabase();
      if (!this.supabase) return null;
      const { data: { session } } = await this.supabase.auth.getSession();
      return session;
    },

    async signUp(email, password, displayName) {
      if (!this.supabase) this.supabase = getSupabase();
      if (!this.supabase) throw new Error('Supabase not configured');
      const { data, error } = await this.supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName || email.split('@')[0] } }
      });
      if (error) throw error;
      return data;
    },

    async signIn(email, password) {
      if (!this.supabase) this.supabase = getSupabase();
      if (!this.supabase) throw new Error('Supabase not configured');
      const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },

    async signOut() {
      if (!this.supabase) return;
      await this.supabase.auth.signOut();
    },

    getUserDisplayName(session) {
      if (!session?.user) return null;
      return session.user.user_metadata?.display_name
        || session.user.email?.split('@')[0]
        || 'User';
    },

    onAuthStateChange(callback) {
      if (!this.supabase) this.supabase = getSupabase();
      if (!this.supabase) return () => {};
      const { data: { subscription } } = this.supabase.auth.onAuthStateChange((event, session) => {
        callback(session);
      });
      return () => subscription.unsubscribe();
    }
  };
})();
