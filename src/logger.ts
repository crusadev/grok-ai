/** Structured logger (pino). Pretty-prints when pino-pretty is installed. */
import pino from 'pino';
import config from './config';

let transport: pino.TransportSingleOptions | undefined;
try {
  require.resolve('pino-pretty');
  transport = {
    target: 'pino-pretty',
    options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
  };
} catch {
  // pino-pretty not installed (e.g. production install) — emit plain JSON logs.
  transport = undefined;
}

export const logger = pino({
  level: config.logLevel,
  ...(transport ? { transport } : {}),
});
