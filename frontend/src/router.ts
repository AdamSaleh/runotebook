import { logger } from './logger';
import type { RouteParams } from './types';

export type RouteHandler = (params: RouteParams) => void;

interface Route {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

class Router {
  private routes: Route[] = [];
  private currentParams: RouteParams = {};

  constructor() {
    window.addEventListener('popstate', () => this.handleRoute());
  }

  /**
   * Register a route pattern
   * Patterns use :param syntax, e.g. '/:workspace/:branch/:filepath*'
   * Use * suffix for catch-all remainder
   */
  route(pattern: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    let regexStr = '^';

    const parts = pattern.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      regexStr += '\\/';

      if (part.startsWith(':')) {
        const paramName = part.slice(1).replace('*', '');
        paramNames.push(paramName);

        if (part.endsWith('*')) {
          // Catch-all: match rest of path
          regexStr += '(.+)';
        } else {
          // Regular param: match segment
          regexStr += '([^\\/]+)';
        }
      } else {
        // Literal match
        regexStr += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }

    regexStr += '\\/?$';

    this.routes.push({
      pattern: new RegExp(regexStr),
      paramNames,
      handler,
    });

    logger.debug(`Registered route: ${pattern} -> ${regexStr}`);
  }

  /**
   * Navigate to a path
   */
  navigate(path: string): void {
    logger.info(`Navigating to: ${path}`);
    history.pushState(null, '', path);
    this.handleRoute();
  }

  /**
   * Handle the current route
   */
  handleRoute(): void {
    const path = window.location.pathname;
    logger.debug(`Handling route: ${path}`);

    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (match) {
        const params: RouteParams = {};
        route.paramNames.forEach((name, i) => {
          (params as Record<string, string>)[name] = decodeURIComponent(match[i + 1] || '');
        });

        this.currentParams = params;
        logger.info(`Route matched: ${JSON.stringify(params)}`);
        route.handler(params);
        return;
      }
    }

    // No route matched - show landing page
    logger.info('No route matched, showing landing');
    this.currentParams = {};

    // Find landing route (empty pattern or root)
    const landingRoute = this.routes.find(r => r.pattern.toString() === '/^\\/\\/?$/');
    if (landingRoute) {
      landingRoute.handler({});
    }
  }

  /**
   * Get current route params
   */
  getParams(): RouteParams {
    return this.currentParams;
  }

  /**
   * Start the router
   */
  start(): void {
    this.handleRoute();
  }
}

export const router = new Router();
