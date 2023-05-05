import chalk from 'chalk';
import Debug from 'debug';
import Enquirer from 'enquirer';
import { access } from 'fs/promises';
import got from 'got';
import kebabCase from 'lodash.kebabcase';
import ora, { Ora } from 'ora';
import path from 'path';
import replace from 'replace-in-file';
import sanitize from 'sanitize-filename';
import { simpleGit } from 'simple-git';
import { Arguments, CommandBuilder } from 'yargs';

import * as Configs from '../../config.js';
import { run } from '../../lib/common.js';
import { Config } from '../../lib/config.js';
import { gitCopy, gitCopySHA } from '../../lib/download.js';
import {
  checkPnpmPresence,
  contentBox,
  obfuscateArgv,
  println,
} from '../../lib/util.js';
import { useToken } from '../../middleware/index.js';
import { StoreCreate } from '../../types.js';

const debug = Debug('saleor-cli:app:create');

export const command = 'create [name]';
export const desc = 'Create a Saleor App template';

export const builder: CommandBuilder = (_) =>
  _.positional('name', {
    type: 'string',
    demandOption: true,
    default: 'my-saleor-app',
  })
    .option('template', {
      type: 'string',
      default: Configs.SaleorAppRepo,
      alias: ['t', 'repo', 'repository'],
      desc: 'Template repository to start from',
    })
    .option('branch', {
      type: 'string',
      default: Configs.SaleorAppDefaultBranch,
      alias: 'b',
      desc: 'Branch of the template repository',
    })
    .option('example', {
      type: 'string',
      alias: 'e',
      desc: 'Use an Example App as a starter',
    });

export const handler = async (argv: Arguments<StoreCreate>): Promise<void> => {
  debug('command arguments: %O', obfuscateArgv(argv));

  debug('check PNPM presence');
  await checkPnpmPresence('This Saleor App template');

  const { name, template, branch, example } = argv;

  debug('construct the folder name');
  const target = await getFolderName(sanitize(name));
  const packageName = kebabCase(target);
  const dirMsg = `App directory: ${chalk.blue(
    path.join(process.env.PWD || '.', target)
  )}`;
  const appMsg = ` Package name: ${chalk.blue(packageName)}`;

  contentBox(`    ${dirMsg}\n    ${appMsg}`);

  const spinner = ora('Downloading...').start();

  debug(`downloading the ${branch} app template`);

  if (typeof example === 'string') {
    const {
      name: targetBranch,
      commit: { sha },
    } = await getExampleBranch(example);
    await gitCopySHA(template, target, sha, targetBranch);
  } else {
    await gitCopy(template, target, branch);
  }

  process.chdir(target);

  spinner.text = 'Updating package.json...';
  await replace.replaceInFile({
    files: 'package.json',
    from: /"name": "saleor-app-template".*/g,
    to: `"name": "${packageName}",`,
  });

  await setupGitRepository(spinner);

  spinner.text = 'Installing dependencies...';
  await run('pnpm', ['i', '--ignore-scripts'], { cwd: process.cwd() });
  await run('pnpm', ['generate'], { cwd: process.cwd() });

  spinner.succeed(
    chalk(
      'Your Saleor app is ready in the',
      chalk.yellow(target),
      'directory\n'
    )
  );

  println('  To start your application:\n');
  println(`    cd ${target}`);
  println('    pnpm dev');

  println(
    chalk(
      '\nTip: use',
      chalk.green('saleor app tunnel'),
      'to expose your local environment to a public URL and install your app in the Saleor instance'
    )
  );
};

const getFolderName = async (name: string): Promise<string> => {
  let folderName = name;
  while (await dirExists(folderName)) {
    folderName = folderName.concat('-0');
  }
  return folderName;
};

const dirExists = async (name: string): Promise<boolean> => {
  try {
    await access(name);
    return true;
  } catch (error) {
    return false;
  }
};

export const setupGitRepository = async (spinner: Ora) => {
  spinner.text = 'Setting up the Git repository...'; // eslint-disable-line no-param-reassign
  const git = simpleGit();
  await git.init(['--initial-branch', 'main']);
  await git.add('.');
  await git.commit('Initial commit from Saleor CLI');
};

const getExampleBranch = async (example: string) => {
  const examples = await getExamplesBranches();
  const filtered = examples.filter((e) => e.name === example);

  if (filtered.length === 0) {
    const choices = examples.map((e) => ({
      name: e.commit.sha,
      message: e.name.split('-').join(' '),
    }));

    const { sha } = await Enquirer.prompt<{ sha: string }>({
      type: 'select',
      name: 'sha',
      required: true,
      choices,
      message: 'Choose the app example',
    });

    const selected = examples.filter((e) => e.commit.sha === sha)[0];
    return selected;
  }

  return filtered[0];
};

interface BranchContent {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

const getExamplesBranches = async () => {
  const { github_token: GitHubToken } = await Config.get();

  const data: BranchContent[] = await got
    .get('https://api.github.com/repos/saleor/saleor-app-template/branches', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: GitHubToken,
      },
    })
    .json();

  return data.filter(({ name }) => name.startsWith('examples'));
};

export const middlewares = [useToken];
