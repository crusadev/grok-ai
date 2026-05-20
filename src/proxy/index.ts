/**
 * Proxy provider factory + public surface. Call-sites only ever import from
 * here; the active provider is chosen by `PROXY_PROVIDER` in config and frozen
 * for the lifetime of the process.
 */
import config from '../config';
import type { ProxyProvider, ProxyConfig } from './provider';
import { GatewayProvider } from './gateway-provider';

export type { ProxyConfig, ProxyProvider } from './provider';
export { normalizeCountry } from './provider';

let provider: ProxyProvider | null = null;

function createProxyProvider(): ProxyProvider {
  switch (config.proxy.provider) {
    case 'decodo':
      return new GatewayProvider({ name: 'decodo', ...config.proxy.decodo });
    case 'privateproxy':
      return new GatewayProvider({ name: 'privateproxy', ...config.proxy.privateproxy });
  }
}

export function getProxyProvider(): ProxyProvider {
  if (!provider) provider = createProxyProvider();
  return provider;
}

/** Convenience facade so call-sites stay one-liners. */
export function buildProxy(country: string): ProxyConfig {
  return getProxyProvider().buildProxy(country);
}
