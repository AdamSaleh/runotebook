import { logger } from './logger';
import { authManager } from './auth';
import { WsClientMessage, WsServerMessage } from './types';

export type MessageHandler = (msg: WsServerMessage) => void;

class WebSocketConnection {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private messageHandler: MessageHandler | null = null;
  private statusDot: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;

  constructor() {
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  connect(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tokenParam = authManager.getTokenParam();
    const wsUrl = `${protocol}//${window.location.host}/ws${tokenParam ? '?' + tokenParam : ''}`;
    logger.info(`Connecting to WebSocket: ${wsUrl.replace(/token=[^&]+/, 'token=***')}`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      logger.error('Failed to create WebSocket:', e);
      this.updateStatus(false, `WebSocket Error: ${(e as Error).message}`);
      return;
    }

    this.ws.onopen = () => {
      logger.info('WebSocket connected successfully');
      this.reconnectAttempts = 0;
      this.updateStatus(true, 'Connected');
    };

    this.ws.onclose = (event) => {
      logger.warn(`WebSocket closed - code: ${event.code}, reason: ${event.reason}, clean: ${event.wasClean}`);
      this.reconnectAttempts++;
      this.updateStatus(false, `Disconnected (attempt ${this.reconnectAttempts}) - Reconnecting...`);
      setTimeout(() => this.connect(), Math.min(2000 * this.reconnectAttempts, 10000));
    };

    this.ws.onerror = (error) => {
      logger.error('WebSocket error:', error);
      this.updateStatus(false, 'Connection Error - Check console');
    };

    this.ws.onmessage = (event) => {
      logger.debug('Received message:', event.data);
      try {
        const msg = JSON.parse(event.data) as WsServerMessage;
        if (this.messageHandler) {
          this.messageHandler(msg);
        }
      } catch (e) {
        logger.error('Failed to parse message:', e, event.data);
      }
    };
  }

  send(message: WsClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(message);
      logger.debug('Sending:', json);
      this.ws.send(json);
      return true;
    }
    logger.error(`Cannot send - WebSocket not open (state: ${this.ws?.readyState})`);
    return false;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private updateStatus(connected: boolean, text: string): void {
    if (this.statusDot) {
      this.statusDot.classList.toggle('disconnected', !connected);
    }
    if (this.statusText) {
      this.statusText.textContent = text;
    }
  }
}

export const wsConnection = new WebSocketConnection();
