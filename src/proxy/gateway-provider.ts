/**
 * Backconnect-gateway provider. Single host:port; country is embedded in the
 * auth username via a substitution template. Covers Decodo, PrivateProxy.me,
 * and any other vendor whose rotating residential pool follows the same shape.
 *
 * The configured endpoint is expected to be a ROTATING gateway — every new
 * connection (and so every new browser context) gets a fresh IP. Do NOT add
 * sticky-session tokens to the template: that pins an IP and defeats the
 * per-tab fresh-IP race.
 */
import type { ProxyConfig, ProxyProvider } from './provider';
import { normalizeCountry } from './provider';

export interface GatewayConfig {
  name: string;
  username: string;
  password: string;
  host: string;
  port: number;
  /** Auth-username template; `{username}` and `{country}` are substituted. */
  usernameTemplate: string;
}

export class GatewayProvider implements ProxyProvider {
  readonly name: string;
  private readonly cfg: GatewayConfig;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
  }

  buildProxy(country: string): ProxyConfig {
    const cc = normalizeCountry(country);
    const user = this.cfg.usernameTemplate
      .replace('{username}', this.cfg.username)
      .replace('{country}', cc);
    return {
      server: `http://${this.cfg.host}:${this.cfg.port}`,
      username: user,
      password: this.cfg.password,
    };
  }
}
