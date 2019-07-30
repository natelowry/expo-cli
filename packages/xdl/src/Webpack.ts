import * as ConfigUtils from '@expo/config';
import formatWebpackMessages from 'react-dev-utils/formatWebpackMessages';
import printBuildError from 'react-dev-utils/printBuildError';
import { choosePort, prepareUrls } from 'react-dev-utils/WebpackDevServerUtils';
import webpack from 'webpack';
import WebpackDevServer from 'webpack-dev-server';
import chalk from 'chalk';
import createWebpackCompiler from './createWebpackCompiler';
import * as ProjectUtils from './project/ProjectUtils';
import * as ProjectSettings from './ProjectSettings';
import * as Web from './Web';
// @ts-ignore missing types for Doctor until it gets converted to TypeScript
import * as Doctor from './project/Doctor';
import XDLError from './XDLError';
import ip from './ip';

import { User as ExpUser } from './User';

export const HOST = '0.0.0.0';
export const DEFAULT_PORT = 19006;
const WEBPACK_LOG_TAG = 'expo';

let webpackDevServerInstance: WebpackDevServer | null = null;
let webpackServerPort: number | null = null;

type CLIWebOptions = {
  dev?: boolean;
  polyfill?: boolean;
  pwa?: boolean;
  nonInteractive?: boolean;
  onWebpackFinished?: (error?: Error) => void;
};

type BundlingOptions = {
  dev?: boolean;
  polyfill?: boolean;
  pwa?: boolean;
  isValidationEnabled?: boolean;
  isImageEditingEnabled?: boolean;
  isDebugInfoEnabled?: boolean;
  isPolyfillEnabled?: boolean;
  webpackEnv?: Object;
  mode?: 'development' | 'production' | 'test' | 'none';
  https?: boolean;
  nonInteractive?: boolean;
  onWebpackFinished?: (error?: Error) => void;
};

export async function startAsync(
  projectRoot: string,
  options: CLIWebOptions = {},
  deprecatedVerbose?: boolean
): Promise<{
  url: string;
  server: WebpackDevServer;
  port: number;
  protocol: 'http' | 'https';
  host?: string;
} | null> {
  if (typeof deprecatedVerbose !== 'undefined') {
    throw new XDLError(
      'WEBPACK_DEPRECATED',
      'startAsync(root, options, verbose): The `verbose` option is deprecated.'
    );
  }

  if (webpackDevServerInstance) {
    ProjectUtils.logError(projectRoot, WEBPACK_LOG_TAG, 'Webpack is already running.');
    return null;
  }

  const { env, config } = await createWebpackConfigAsync(projectRoot, options);

  const port = await getAvailablePortAsync();
  webpackServerPort = port;

  ProjectUtils.logInfo(
    projectRoot,
    WEBPACK_LOG_TAG,
    `Starting Webpack on port ${webpackServerPort} in ${chalk.underline(env.mode)} mode.`
  );

  const protocol = env.https ? 'https' : 'http';
  const urls = prepareUrls(protocol, '::', webpackServerPort);
  const useYarn = ConfigUtils.isUsingYarn(projectRoot);
  const appName = await getProjectNameAsync(projectRoot);
  const nonInteractive = validateBoolOption(
    'nonInteractive',
    options.nonInteractive,
    !!process.stdout.isTTY
  );

  const server: WebpackDevServer = await new Promise(resolve => {
    // Create a webpack compiler that is configured with custom messages.
    const compiler = createWebpackCompiler({
      projectRoot,
      nonInteractive,
      webpackFactory: webpack,
      appName,
      config,
      urls,
      useYarn,
      onFinished: () => resolve(server),
    });
    const server = new WebpackDevServer(compiler, config.devServer);
    // Launch WebpackDevServer.
    server.listen(port, HOST, error => {
      if (error) {
        ProjectUtils.logError(projectRoot, WEBPACK_LOG_TAG, error.message);
      }
      if (typeof options.onWebpackFinished === 'function') {
        options.onWebpackFinished(error);
      }
    });
    webpackDevServerInstance = server;
  });
  await ProjectSettings.setPackagerInfoAsync(projectRoot, {
    webpackServerPort,
  });

  const host = ip.address();
  const url = `${protocol}://${host}:${webpackServerPort}`;
  return {
    url,
    server,
    port,
    protocol,
    host,
  };
}

export async function stopAsync(projectRoot: string): Promise<void> {
  if (webpackDevServerInstance) {
    const server = webpackDevServerInstance;
    await new Promise(resolve => server.close(() => resolve()));
    webpackDevServerInstance = null;
    webpackServerPort = null;
    await ProjectSettings.setPackagerInfoAsync(projectRoot, {
      webpackServerPort: null,
    });
  }
}

export async function openAsync(projectRoot: string, options?: BundlingOptions): Promise<void> {
  if (!webpackDevServerInstance) {
    await startAsync(projectRoot, options);
  }
  await Web.openProjectAsync(projectRoot);
}

export async function bundleAsync(projectRoot: string, options?: BundlingOptions): Promise<void> {
  const { config } = await createWebpackConfigAsync(projectRoot, options);

  const compiler = webpack(config);

  try {
    // We generate the stats.json file in the webpack-config
    const { stats, warnings } = await new Promise((resolve, reject) =>
      compiler.run((error, stats) => {
        let messages;
        if (error) {
          if (!error.message) {
            return reject(error);
          }
          messages = formatWebpackMessages({
            errors: [error.message],
            warnings: [],
            _showErrors: true,
            _showWarnings: true,
          });
        } else {
          messages = formatWebpackMessages(
            stats.toJson({ all: false, warnings: true, errors: true })
          );
        }

        if (messages.errors.length) {
          // Only keep the first error. Others are often indicative
          // of the same problem, but confuse the reader with noise.
          if (messages.errors.length > 1) {
            messages.errors.length = 1;
          }
          return reject(new Error(messages.errors.join('\n\n')));
        }
        if (
          process.env.CI &&
          (typeof process.env.CI !== 'string' || process.env.CI.toLowerCase() !== 'false') &&
          messages.warnings.length
        ) {
          console.log(
            chalk.yellow(
              '\nTreating warnings as errors because process.env.CI = true.\n' +
                'Most CI servers set it automatically.\n'
            )
          );
          return reject(new Error(messages.warnings.join('\n\n')));
        }

        resolve({
          stats,
          warnings: messages.warnings,
        });
      })
    );

    if (warnings.length) {
      console.log(chalk.yellow('Compiled with warnings.\n'));
      console.log(warnings.join('\n\n'));
      console.log(
        '\nSearch for the ' +
          chalk.underline(chalk.yellow('keywords')) +
          ' to learn more about each warning.'
      );
      console.log(
        'To ignore, add ' + chalk.cyan('// eslint-disable-next-line') + ' to the line before.\n'
      );
    } else {
      console.log(chalk.green('Compiled successfully.\n'));
    }
  } catch (error) {
    console.log(chalk.red('Failed to compile.\n'));
    printBuildError(error);
    process.exit(1);
  }
}

export async function getProjectNameAsync(projectRoot: string): Promise<string> {
  const { exp } = await ConfigUtils.readConfigJsonAsync(projectRoot);
  const { webName } = ConfigUtils.getNameFromConfig(exp);
  return webName;
}

export function getServer(projectRoot: string): WebpackDevServer | null {
  if (webpackDevServerInstance == null) {
    ProjectUtils.logError(projectRoot, WEBPACK_LOG_TAG, 'Webpack is not running.');
  }
  return webpackDevServerInstance;
}

export function getPort(): number | null {
  return webpackServerPort;
}

export async function getUrlAsync(projectRoot: string): Promise<string | null> {
  const devServer = getServer(projectRoot);
  if (!devServer) {
    return null;
  }
  const host = ip.address();
  const protocol = await getProtocolAsync(projectRoot);
  return `${protocol}://${host}:${webpackServerPort}`;
}

export async function getProtocolAsync(projectRoot: string): Promise<'http' | 'https'> {
  // TODO: Bacon: Handle when not in expo
  const { https } = await ProjectSettings.readAsync(projectRoot);
  return https === true ? 'https' : 'http';
}

export async function getAvailablePortAsync(
  options: { host?: string; defaultPort?: number } = {}
): Promise<number> {
  try {
    const defaultPort =
      'defaultPort' in options && options.defaultPort ? options.defaultPort : DEFAULT_PORT;
    const port = await choosePort(
      'host' in options && options.host ? options.host : HOST,
      defaultPort
    );
    if (!port) throw new Error(`Port ${defaultPort} not available.`);
    else return port;
  } catch (error) {
    throw new XDLError('NO_PORT_FOUND', 'No available port found: ' + error.message);
  }
}

export function setMode(mode: 'development' | 'production' | 'test' | 'none'): void {
  process.env.BABEL_ENV = mode;
  process.env.NODE_ENV = mode;
}

function validateBoolOption(name: string, value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'undefined') {
    value = defaultValue;
  }

  if (typeof value !== 'boolean') {
    throw new XDLError('WEBPACK_INVALID_OPTION', `'${name}' option must be a boolean.`);
  }

  return value;
}

function transformCLIOptions(options: CLIWebOptions): BundlingOptions {
  // Transform the CLI flags into more explicit values
  return {
    ...options,
    isImageEditingEnabled: options.pwa,
    isPolyfillEnabled: options.polyfill,
  };
}

async function createWebpackConfigAsync(
  projectRoot: string,
  options: CLIWebOptions = {}
): Promise<{ env: any; config: Web.WebpackConfiguration }> {
  const fullOptions = transformCLIOptions(options);
  if (validateBoolOption('isValidationEnabled', fullOptions.isValidationEnabled, true)) {
    await Doctor.validateWebSupportAsync(projectRoot);
  }

  const env = await getWebpackConfigEnvFromBundlingOptionsAsync(projectRoot, fullOptions);

  setMode(env.mode);

  const config = await Web.invokeWebpackConfigAsync(env);

  return { env, config };
}

async function applyOptionsToProjectSettingsAsync(
  projectRoot: string,
  options: BundlingOptions
): Promise<ProjectSettings.Settings> {
  let newSettings: Partial<ProjectSettings.Settings> = {};
  // Change settings before reading them
  if (typeof options.https === 'boolean') {
    newSettings.https = options.https;
  }
  if (typeof options.dev === 'boolean') {
    newSettings.dev = options.dev;
  }

  if (Object.keys(newSettings).length) {
    await ProjectSettings.setAsync(projectRoot, newSettings);
  }

  return await ProjectSettings.readAsync(projectRoot);
}

async function getWebpackConfigEnvFromBundlingOptionsAsync(
  projectRoot: string,
  options: BundlingOptions
): Promise<Web.WebEnvironment> {
  let { dev, https } = await applyOptionsToProjectSettingsAsync(projectRoot, options);

  const mode = typeof options.mode === 'string' ? options.mode : dev ? 'development' : 'production';

  const isImageEditingEnabled = validateBoolOption(
    'isImageEditingEnabled',
    options.isImageEditingEnabled,
    true
  );
  const isDebugInfoEnabled = validateBoolOption(
    'isDebugInfoEnabled',
    options.isDebugInfoEnabled,
    Web.isInfoEnabled()
  );

  return {
    projectRoot,
    pwa: isImageEditingEnabled,
    mode,
    https,
    polyfill: validateBoolOption('isPolyfillEnabled', options.isPolyfillEnabled, false),
    development: dev,
    production: !dev,
    info: isDebugInfoEnabled,
    ...(options.webpackEnv || {}),
  };
}
