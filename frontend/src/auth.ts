import { logger } from './logger';

const TOKEN_KEY = 'runotepad_token';

class AuthManager {
  private token: string | null = null;

  constructor() {
    this.loadToken();
  }

  private loadToken(): void {
    // Check URL params first
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');

    if (urlToken) {
      this.setToken(urlToken);
      // Remove token from URL to avoid sharing
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.toString());
      logger.info('Token loaded from URL');
      return;
    }

    // Fall back to localStorage
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      this.token = stored;
      logger.info('Token loaded from localStorage');
    }
  }

  setToken(token: string): void {
    this.token = token;
    localStorage.setItem(TOKEN_KEY, token);
    logger.info('Token saved');
  }

  getToken(): string | null {
    return this.token;
  }

  clearToken(): void {
    this.token = null;
    localStorage.removeItem(TOKEN_KEY);
    logger.info('Token cleared');
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }

  getAuthHeader(): Record<string, string> {
    if (this.token) {
      return { 'Authorization': `Bearer ${this.token}` };
    }
    return {};
  }

  getTokenParam(): string {
    return this.token ? `token=${encodeURIComponent(this.token)}` : '';
  }
}

export const authManager = new AuthManager();
