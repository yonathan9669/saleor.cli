import chalk from 'chalk';
import Debug from 'debug';
import fs from 'fs-extra';
import GitUrlParse from 'git-url-parse';
import path from 'path';
import type { CommandBuilder } from 'yargs';
import { Arguments } from 'yargs';

import { Config } from '../../lib/config.js';
import {
  createProject,
  formatEnvironmentVariables,
  getRepoUrl,
  setupSaleorAppCheckout,
  triggerDeploymentInVercel,
} from '../../lib/deploy.js';
import { readEnvFile } from '../../lib/util.js';
import { Vercel } from '../../lib/vercel.js';
import { useGithub, useVercel } from '../../middleware/index.js';
import { StoreDeploy } from '../../types.js';

const debug = Debug('saleor-cli:storefront:deploy');

export const command = 'deploy';
export const desc = 'Deploy this `react-storefront` to Vercel';

export const builder: CommandBuilder = (_) =>
  _.option('dispatch', {
    type: 'boolean',
    demandOption: false,
    default: false,
    desc: 'dispatch deployment and don\'t wait till it ends',
  }).option('with-checkout', {
    type: 'boolean',
    default: false,
    desc: 'Deploy with checkout',
  });

export const handler = async (argv: Arguments<StoreDeploy>) => {
  const { name } = JSON.parse(
    await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8')
  );
  console.log(
    `\nDeploying... ${chalk.cyan(name)} (the name inferred from ${chalk.yellow(
      'package.json'
    )})`
  );

  const { vercel_token: vercelToken } = await Config.get();
  debug(`Your Vercel token: ${vercelToken}`);

  const vercel = new Vercel(vercelToken);
  const localEnvs = await readEnvFile();
  const repoUrl = await getRepoUrl(name);

  if (argv.withCheckout) {
    // Deploy checkout
    console.log('\nDeploying Checkout to Vercel');
    const { checkoutAppURL, authToken, appId } = await setupSaleorAppCheckout(
      `${name}-app-checkout`,
      localEnvs.SALEOR_API_URL,
      vercel,
      argv
    );

    localEnvs.CHECKOUT_APP_URL = checkoutAppURL;
    localEnvs.CHECKOUT_STOREFRONT_URL = `${checkoutAppURL}/checkout-spa`;
    localEnvs.SALEOR_APP_TOKEN = authToken;
    localEnvs.SALEOR_APP_ID = appId;

    // TODO save localEnvs to local .env
  }

  console.log('\nDeploying Storefront to Vercel');
  const { id, newProject } = await createProject(
    name,
    vercel,
    formatEnvironmentVariables(localEnvs),
    'storefront'
  );
  debug(`created a project in Vercel: ${id}`);

  const { name: domain } = await vercel.getProjectDomain(id);
  localEnvs.STOREFRONT_URL = `https://${domain}`;

  // 2. Deploy the project in Vercel
  debug('triggering the deployment');

  const { owner } = GitUrlParse(repoUrl);
  const deployment = await triggerDeploymentInVercel(
    vercel,
    name,
    owner,
    id,
    newProject
  );

  const shouldWaitUntilDeployed = !!process.env.CI || !argv.dispatch;
  if (shouldWaitUntilDeployed) {
    const deploymentId = deployment.id || deployment.uid;
    await vercel.verifyDeployment(name, deploymentId);
  }
};

export const middlewares = [useVercel, useGithub];
